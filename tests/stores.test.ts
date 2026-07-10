import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from '@codemirror/state'
import { createMockIpc, setIpc, type Ipc } from '../src/lib/ipc'
import { editorRegistry } from '../src/lib/editorRegistry'
import { registerMenu } from '../src/lib/menuBus'
import { createSessionPersistence } from '../src/lib/sessionPersistence'
import { useFiles } from '../src/stores/files'
import { useTabs } from '../src/stores/tabs'
import { useWorkspace } from '../src/stores/workspace'
import { countWords } from '../src/stores/ui'

let mock: Ipc

beforeEach(() => {
  setActivePinia(createPinia())
  editorRegistry.clear()
  localStorage.removeItem('bmd.fileSort')
  mock = createMockIpc({
    '/ws/a.md': '# A\n',
    '/ws/b.md': 'bbb\n',
    '/ws/sub/c.md': 'ccc\n',
    '/ws/raw.txt': 'x',
  })
  mock.pickFolder = async () => '/ws'
  setIpc(mock)
  registerMenu(null)
})

afterEach(() => {
  localStorage.removeItem('bmd.fileSort')
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

  it('文件树排序模式：可按名称升降序并持久化', async () => {
    const ws = useWorkspace()
    await ws.openFolder()
    ws.setSortMode('nameAsc')
    expect(ws.rootEntries.map((e) => e.name)).toEqual(['a.md', 'b.md', 'raw.txt', 'sub'])
    ws.setSortMode('nameDesc')
    expect(ws.rootEntries.map((e) => e.name)).toEqual(['sub', 'raw.txt', 'b.md', 'a.md'])
    expect(localStorage.getItem('bmd.fileSort')).toBe('nameDesc')
  })

  it('清空工作区：进入无文件夹的单文件状态', async () => {
    const ws = useWorkspace()
    const stopSpy = vi.fn(async () => {})
    mock.stopWatch = stopSpy
    await ws.openFolder()
    ws.filter = 'a'
    await ws.clear()
    expect(stopSpy).toHaveBeenCalledOnce()
    expect(ws.root).toBeNull()
    expect(ws.children).toEqual({})
    expect(ws.expanded).toEqual({})
    expect(ws.filter).toBe('')
  })
})

describe('tabs 打开/保存链路', () => {
  it('打开文件建标签；重复打开只激活不新建', async () => {
    const tabs = useTabs()
    const t1 = await tabs.openFile('/ws/a.md')
    expect(t1.initialDoc).toBe('# A\n')
    expect(t1.dirty).toBe(false)
    expect(t1.preview).toBe(false)
    await tabs.openFile('/ws/b.md')
    await tabs.openFile('/ws/a.md')
    expect(tabs.tabs).toHaveLength(2)
    expect(tabs.activeId).toBe(t1.id)
  })

  it('预览模式：单击轮播只占一个斜体预览标签；正式打开会转正', async () => {
    const tabs = useTabs()
    const a = await tabs.previewFile('/ws/a.md')
    expect(a.preview).toBe(true)
    expect(a.title).toBe('a.md')
    const firstId = a.id

    const b = await tabs.previewFile('/ws/b.md')
    expect(tabs.tabs).toHaveLength(1)
    expect(b.id).toBe(firstId)
    expect(b.path).toBe('/ws/b.md')
    expect(b.preview).toBe(true)

    tabs.confirmPreview(b.id)
    expect(b.preview).toBe(false)
    await tabs.previewFile('/ws/a.md')
    expect(tabs.tabs.map((t) => ({ path: t.path, preview: t.preview }))).toEqual([
      { path: '/ws/b.md', preview: false },
      { path: '/ws/a.md', preview: true },
    ])
  })

  it('预览被编辑后切换文件：确认保存后转正式标签，再打开新的预览', async () => {
    const tabs = useTabs()
    const a = await tabs.previewFile('/ws/a.md')
    typeInto(a.id, '# A 改\n')
    mock.confirm = vi.fn(async () => true)

    const b = await tabs.previewFile('/ws/b.md')
    expect(mock.confirm).toHaveBeenCalledWith('文件已有修改，是否要保存？', '文件已有修改')
    expect((await mock.readDoc('/ws/a.md')).content).toBe('# A 改\n')
    expect(tabs.tabs.map((t) => ({ path: t.path, preview: t.preview, dirty: t.dirty }))).toEqual([
      { path: '/ws/a.md', preview: false, dirty: false },
      { path: '/ws/b.md', preview: true, dirty: false },
    ])
    expect(tabs.activeId).toBe(b.id)
  })

  it('预览被编辑后切换文件：取消保存则停留在原预览', async () => {
    const tabs = useTabs()
    const a = await tabs.previewFile('/ws/a.md')
    typeInto(a.id, '# A 改\n')
    mock.confirm = vi.fn(async () => false)

    const stayed = await tabs.previewFile('/ws/b.md')
    expect(stayed.id).toBe(a.id)
    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.active?.path).toBe('/ws/a.md')
    expect(tabs.active?.preview).toBe(true)
    expect(tabs.active?.dirty).toBe(true)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('# A\n')
  })

  it('预览被编辑后切换文件：选择不保存则丢弃修改并轮播到新预览', async () => {
    registerMenu({
      showMenu: () => {},
      askText: async () => null,
      askChoice: async () => 'discard',
    })
    const tabs = useTabs()
    const a = await tabs.previewFile('/ws/a.md')
    typeInto(a.id, '# A 改\n')

    const b = await tabs.previewFile('/ws/b.md')
    expect(tabs.tabs).toHaveLength(1)
    expect(b.path).toBe('/ws/b.md')
    expect(b.preview).toBe(true)
    expect(b.dirty).toBe(false)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('# A\n')
  })

  it('普通文本文件：打开为 text 标签并可编辑保存', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/raw.txt')
    expect(t.kind).toBe('text')
    expect(t.initialDoc).toBe('x')
    typeInto(t.id, 'x,y\n1,2\n')
    expect(await tabs.saveTab(t.id)).toBe(true)
    expect((await mock.readDoc('/ws/raw.txt')).content).toBe('x,y\n1,2\n')
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

  it('保存期间继续输入：旧保存完成后仍保持 dirty，下一次保存写入最新版', async () => {
    const tabs = useTabs()
    const tab = await tabs.openFile('/ws/a.md')
    const write = mock.writeDocAtomic.bind(mock)
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const entered = new Promise<void>((resolve) => (started = resolve))
    mock.writeDocAtomic = vi.fn(async (path, content, mtime, encoding) => {
      started()
      await gate
      return write(path, content, mtime, encoding)
    })

    typeInto(tab.id, '第一版')
    const saving = tabs.saveTab(tab.id)
    await entered
    typeInto(tab.id, '第二版')
    release()
    expect(await saving).toBe(true)
    expect(tab.dirty).toBe(true)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('第一版')

    expect(await tabs.saveTab(tab.id)).toBe(true)
    expect(tab.dirty).toBe(false)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('第二版')
  })

  it('快速连续预览：只提交最后一次点击并保持同一预览槽位', async () => {
    const tabs = useTabs()
    const first = await tabs.previewFile('/ws/a.md')
    const read = mock.readDoc.bind(mock)
    let releaseB!: () => void
    let releaseC!: () => void
    let startedB!: () => void
    let startedC!: () => void
    const gateB = new Promise<void>((resolve) => (releaseB = resolve))
    const gateC = new Promise<void>((resolve) => (releaseC = resolve))
    const enteredB = new Promise<void>((resolve) => (startedB = resolve))
    const enteredC = new Promise<void>((resolve) => (startedC = resolve))
    mock.readDoc = async (path) => {
      if (path === '/ws/b.md') {
        startedB()
        await gateB
      }
      if (path === '/ws/sub/c.md') {
        startedC()
        await gateC
      }
      return read(path)
    }

    const older = tabs.previewFile('/ws/b.md')
    await enteredB
    const newer = tabs.previewFile('/ws/sub/c.md')
    await enteredC
    releaseC()
    await newer
    releaseB()
    await older

    expect(tabs.tabs).toHaveLength(1)
    expect(tabs.active?.id).toBe(first.id)
    expect(tabs.active?.path).toBe('/ws/sub/c.md')
  })

  it('过期预览读取失败：不覆盖新预览，也不冒出无关错误', async () => {
    const tabs = useTabs()
    await tabs.previewFile('/ws/a.md')
    const read = mock.readDoc.bind(mock)
    let rejectOld!: (error: Error) => void
    let startedOld!: () => void
    const enteredOld = new Promise<void>((resolve) => (startedOld = resolve))
    mock.readDoc = async (path) => {
      if (path === '/ws/b.md') {
        startedOld()
        return await new Promise<never>((_, reject) => (rejectOld = reject))
      }
      return read(path)
    }

    const oldPreview = tabs.previewFile('/ws/b.md')
    await enteredOld
    await tabs.previewFile('/ws/sub/c.md')
    rejectOld(new Error('旧请求读取失败'))

    await expect(oldPreview).resolves.toBe(tabs.active)
    expect(tabs.active?.path).toBe('/ws/sub/c.md')
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

  it('批量关闭：左侧/右侧/其他；dirty 拒绝时保留该标签', async () => {
    const tabs = useTabs()
    await tabs.openFile('/ws/a.md')
    const b = await tabs.openFile('/ws/b.md')
    const c = await tabs.openFile('/ws/sub/c.md')

    await tabs.closeLeft(b.id)
    expect(tabs.tabs.map((t) => t.id)).toEqual([b.id, c.id])

    await tabs.closeRight(b.id)
    expect(tabs.tabs.map((t) => t.id)).toEqual([b.id])

    const a2 = await tabs.openFile('/ws/a.md')
    typeInto(a2.id, 'x')
    mock.confirm = vi.fn(async () => false)
    await tabs.closeOthers(b.id)
    expect(tabs.tabs.map((t) => t.id)).toEqual([b.id, a2.id]) // dirty 拒绝关闭被保留

    mock.confirm = vi.fn(async () => true)
    await tabs.closeOthers(b.id)
    expect(tabs.tabs.map((t) => t.id)).toEqual([b.id])
    expect(tabs.activeId).toBe(b.id)
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

  it('会话快照不保存临时预览标签', async () => {
    const tabs = useTabs()
    await tabs.openFile('/ws/a.md')
    await tabs.previewFile('/ws/b.md')
    expect(tabs.sessionSnapshot('/ws')).toEqual({ root: '/ws', openPaths: ['/ws/a.md'], active: null })
  })
})

describe('HTML 只读预览标签', () => {
  beforeEach(() => {
    mock = createMockIpc({
      '/ws/a.md': '# A\n',
      '/ws/page.html': '<h1>hi</h1>',
    })
    setIpc(mock)
  })

  it('打开 .html：kind=html、保留 initialDoc 供 srcdoc；md 标签 kind=md', async () => {
    const tabs = useTabs()
    const h = await tabs.openFile('/ws/page.html')
    expect(h.kind).toBe('html')
    expect(h.initialDoc).toBe('<h1>hi</h1>')
    expect(h.previewUrl).toBeNull() // mock 环境走 srcdoc 回退
    const m = await tabs.openFile('/ws/a.md')
    expect(m.kind).toBe('md')
  })

  it('html 标签不支持编辑/保存：saveTab 拒绝且零写入', async () => {
    const tabs = useTabs()
    const spy = vi.spyOn(mock, 'writeDocAtomic')
    const h = await tabs.openFile('/ws/page.html')
    expect(await tabs.saveTab(h.id)).toBe(false)
    expect(await tabs.saveTab(h.id, { saveAs: true })).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('外部修改：html 标签静默刷新 initialDoc 与 mtime（驱动 iframe 重载）', async () => {
    const tabs = useTabs()
    const h = await tabs.openFile('/ws/page.html')
    const oldMtime = h.mtimeMs
    await mock.writeDocAtomic('/ws/page.html', '<h1>new</h1>', null)
    await tabs.handleExternalChanges(['/ws/page.html'])
    expect(h.initialDoc).toBe('<h1>new</h1>')
    expect(h.mtimeMs).not.toBe(oldMtime)
    expect(h.conflict).toBe(false)
  })
})

describe('文件系统事务', () => {
  it('重命名目录：同步映射内部标签，保存后仍写向新路径', async () => {
    const tabs = useTabs()
    const files = useFiles()
    const tab = await tabs.openFile('/ws/sub/c.md')
    typeInto(tab.id, '目录改名前的修改')

    expect(await files.renameEntry('/ws/sub', true, 'sub', 'renamed')).toBe('/ws/renamed')
    expect(tab.path).toBe('/ws/renamed/c.md')
    expect(tab.dirty).toBe(false)
    await expect(mock.readDoc('/ws/sub/c.md')).rejects.toThrow()
    expect((await mock.readDoc('/ws/renamed/c.md')).content).toBe('目录改名前的修改')

    typeInto(tab.id, '新路径继续编辑')
    await tabs.saveTab(tab.id)
    expect((await mock.readDoc('/ws/renamed/c.md')).content).toBe('新路径继续编辑')
  })

  it('重命名扩展名：重新计算编辑器类型', async () => {
    const tabs = useTabs()
    const files = useFiles()
    const tab = await tabs.openFile('/ws/raw.txt')
    expect(tab.kind).toBe('text')
    await files.renameEntry('/ws/raw.txt', false, 'raw.txt', 'raw.md')
    expect(tab.path).toBe('/ws/raw.md')
    expect(tab.kind).toBe('md')
  })

  it('删除目录：关闭所有内部标签', async () => {
    const tabs = useTabs()
    const files = useFiles()
    await tabs.openFile('/ws/sub/c.md')
    mock.confirm = vi.fn(async () => true)
    expect(await files.trashEntry('/ws/sub', true, 'sub')).toBe(true)
    expect(tabs.tabs).toHaveLength(0)
  })

  it('删除前的在途保存失败：中止删除并保留文件与标签', async () => {
    const tabs = useTabs()
    const files = useFiles()
    const tab = await tabs.openFile('/ws/a.md')
    typeInto(tab.id, '未能保存的修改')
    mock.writeDocAtomic = vi.fn(async () => {
      throw new Error('磁盘写入失败')
    })
    mock.confirm = vi.fn(async () => true)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const saving = tabs.saveTab(tab.id)
    expect(await files.trashEntry('/ws/a.md', false, 'a.md')).toBe(false)
    await expect(saving).rejects.toThrow('磁盘写入失败')
    expect(tabs.tabs.some((item) => item.id === tab.id)).toBe(true)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('# A\n')
    errorSpy.mockRestore()
  })
})

describe('会话持久化控制器', () => {
  it('预览转正式后 flush 会立即保存正式标签', async () => {
    const tabs = useTabs()
    const workspace = useWorkspace()
    const persistence = createSessionPersistence(tabs, workspace)
    await persistence.start()
    const tab = await tabs.previewFile('/ws/a.md')
    await persistence.flush()
    expect((await mock.loadSession())?.openPaths).toEqual([])

    tabs.confirmPreview(tab.id)
    await persistence.flush()
    expect(await mock.loadSession()).toEqual({ root: null, openPaths: ['/ws/a.md'], active: 0 })
    persistence.dispose()
  })
})

describe('字数统计', () => {
  it('中英混排', () => {
    const r = countWords('中文四个字 and three words\n')
    expect(r.words).toBe(5 + 3)
    expect(r.chars).toBe('中文四个字andthreewords'.length)
  })
})
