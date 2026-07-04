import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from '@codemirror/state'
import { createMockIpc, setIpc, type Ipc } from '../src/lib/ipc'
import { editorRegistry } from '../src/lib/editorRegistry'
import { useTabs } from '../src/stores/tabs'
import { useWorkspace } from '../src/stores/workspace'
import { countWords } from '../src/stores/ui'

let mock: Ipc

beforeEach(() => {
  setActivePinia(createPinia())
  editorRegistry.clear()
  mock = createMockIpc({
    '/ws/a.md': '# A\n',
    '/ws/b.md': 'bbb\n',
    '/ws/sub/c.md': 'ccc\n',
    '/ws/raw.txt': 'x',
  })
  mock.pickFolder = async () => '/ws'
  setIpc(mock)
})

/** 模拟编辑器里有了新内容 */
function typeInto(tabId: string, doc: string) {
  editorRegistry.set(tabId, EditorState.create({ doc }))
  useTabs().markDirty(tabId)
}

describe('workspace 文件树', () => {
  it('打开文件夹：目录在前、文件在后、忽略大小写排序', async () => {
    const ws = useWorkspace()
    await ws.openFolder()
    expect(ws.root).toBe('/ws')
    expect(ws.rootEntries.map((e) => e.name)).toEqual(['sub', 'a.md', 'b.md', 'raw.txt'])
    expect(ws.rootEntries.map((e) => e.isMd)).toEqual([false, true, true, false])
  })

  it('展开目录懒加载子项', async () => {
    const ws = useWorkspace()
    await ws.openFolder()
    expect(ws.children['/ws/sub']).toBeUndefined()
    await ws.toggleDir('/ws/sub')
    expect(ws.children['/ws/sub'].map((e) => e.name)).toEqual(['c.md'])
  })
})

describe('tabs 打开/保存链路', () => {
  it('打开文件建标签；重复打开只激活不新建', async () => {
    const tabs = useTabs()
    const t1 = await tabs.openFile('/ws/a.md')
    expect(t1.initialDoc).toBe('# A\n')
    expect(t1.dirty).toBe(false)
    await tabs.openFile('/ws/b.md')
    await tabs.openFile('/ws/a.md')
    expect(tabs.tabs).toHaveLength(2)
    expect(tabs.activeId).toBe(t1.id)
  })

  it('零写入保证：未编辑保存不触盘', async () => {
    const tabs = useTabs()
    const spy = vi.spyOn(mock, 'writeDocAtomic')
    const t = await tabs.openFile('/ws/a.md')
    expect(await tabs.saveTab(t.id)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('编辑后保存：写盘、清除 dirty、mtime 链路正确', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/a.md')
    typeInto(t.id, '# A 改\n')
    expect(t.dirty).toBe(true)
    expect(await tabs.saveTab(t.id)).toBe(true)
    expect(t.dirty).toBe(false)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('# A 改\n')
    // 再改再存（mtime 已更新，不应冲突）
    typeInto(t.id, 'v3')
    expect(await tabs.saveTab(t.id)).toBe(true)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('v3')
  })

  it('外部修改后保存：冲突 → 用户确认覆盖', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/a.md')
    await mock.writeDocAtomic('/ws/a.md', '外部内容', null) // 模拟外部程序改动
    typeInto(t.id, '本地内容')
    mock.confirm = vi.fn(async () => true)
    expect(await tabs.saveTab(t.id)).toBe(true)
    expect(mock.confirm).toHaveBeenCalledOnce()
    expect((await mock.readDoc('/ws/a.md')).content).toBe('本地内容')
  })

  it('外部修改后保存：用户拒绝则不写盘', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/a.md')
    await mock.writeDocAtomic('/ws/a.md', '外部内容', null)
    typeInto(t.id, '本地内容')
    mock.confirm = vi.fn(async () => false)
    expect(await tabs.saveTab(t.id)).toBe(false)
    expect(t.dirty).toBe(true)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('外部内容')
  })

  it('新建文件：首次保存走另存对话框', async () => {
    const tabs = useTabs()
    const t = tabs.newFile()
    typeInto(t.id, '草稿')
    mock.pickSavePath = vi.fn(async () => '/ws/draft.md')
    expect(await tabs.saveTab(t.id)).toBe(true)
    expect(t.path).toBe('/ws/draft.md')
    expect(t.title).toBe('draft.md')
    expect((await mock.readDoc('/ws/draft.md')).content).toBe('草稿')
  })

  it('关闭 dirty 标签需确认；拒绝则保留', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/a.md')
    typeInto(t.id, 'x')
    mock.confirm = vi.fn(async () => false)
    expect(await tabs.closeTab(t.id)).toBe(false)
    expect(tabs.tabs).toHaveLength(1)
    mock.confirm = vi.fn(async () => true)
    expect(await tabs.closeTab(t.id)).toBe(true)
    expect(tabs.tabs).toHaveLength(0)
    expect(tabs.activeId).toBeNull()
  })

  it('标签轮换与序号跳转', async () => {
    const tabs = useTabs()
    const a = await tabs.openFile('/ws/a.md')
    const b = await tabs.openFile('/ws/b.md')
    tabs.cycle(1)
    expect(tabs.activeId).toBe(a.id)
    tabs.cycle(-1)
    expect(tabs.activeId).toBe(b.id)
    tabs.activateIndex(0)
    expect(tabs.activeId).toBe(a.id)
  })

  it('会话快照与恢复', async () => {
    const tabs = useTabs()
    await tabs.openFile('/ws/a.md')
    await tabs.openFile('/ws/b.md')
    const snap = tabs.sessionSnapshot('/ws')
    expect(snap).toEqual({ root: '/ws', openPaths: ['/ws/a.md', '/ws/b.md'], active: 1 })

    setActivePinia(createPinia())
    editorRegistry.clear()
    const fresh = useTabs()
    await fresh.restoreSession(snap)
    expect(fresh.tabs.map((t) => t.path)).toEqual(['/ws/a.md', '/ws/b.md'])
    expect(fresh.active?.path).toBe('/ws/b.md')
  })
})

describe('字数统计', () => {
  it('中英混排', () => {
    const r = countWords('中文四个字 and three words\n')
    expect(r.words).toBe(5 + 3)
    expect(r.chars).toBe('中文四个字andthreewords'.length)
  })
})
