// 本轮功能回归：全文搜索（searchText）、新建文件关闭策略、快捷键提示平台化、自定义技能
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState } from '@codemirror/state'
import { createMockIpc, setIpc, type Ipc } from '../src/lib/ipc'
import { editorRegistry } from '../src/lib/editorRegistry'
import { isOpenablePath, isPlainTextPath } from '../src/lib/fileTypes'
import { isMac, keyHint } from '../src/lib/shortcuts'
import { BUILTIN_COMMANDS, useAi } from '../src/stores/ai'
import { useTabs } from '../src/stores/tabs'
import { useUi } from '../src/stores/ui'

let mock: Ipc

beforeEach(() => {
  setActivePinia(createPinia())
  editorRegistry.clear()
  localStorage.clear()
  mock = createMockIpc({
    '/ws/a.md': '# Hello World\nsay hello, hello!\n',
    '/ws/sub/deep.md': 'hello 深层\n',
    '/ws/Note-hello.md': '无关内容\n',
    '/ws/skip.txt': 'hello hello\n',
    '/ws/custom.xyz': '冷门格式也能搜索\n',
  })
  setIpc(mock)
})

/** 模拟编辑器里有了新内容 */
function typeInto(tabId: string, doc: string) {
  editorRegistry.set(tabId, EditorState.create({ doc }))
  useTabs().markDirty(tabId)
}

describe('searchText 全文搜索（mock 与 Rust 同契约）', () => {
  it('内容匹配：大小写不敏感，统计次数、首行行号与预览', async () => {
    const hits = await mock.searchText('/ws', 'HELLO', 50, 1)
    const a = hits.find((h) => h.name === 'a.md')!
    expect(a.count).toBe(3) // Hello + hello + hello
    expect(a.line).toBe(1)
    expect(a.preview).toBe('# Hello World')
  })

  it('排序：文件名命中优先，其余文本按命中次数降序', async () => {
    const hits = await mock.searchText('/ws', 'hello', 50, 2)
    expect(hits.map((h) => h.name)).toEqual(['Note-hello.md', 'a.md', 'skip.txt', 'deep.md'])
    // 仅文件名命中：line 0 / count 0
    expect(hits[0].line).toBe(0)
    expect(hits[0].count).toBe(0)
    expect(hits.find((h) => h.name === 'skip.txt')?.count).toBe(2)
  })

  it('作用域限定 root；空查询返回空；limit 生效', async () => {
    expect(await mock.searchText('/elsewhere', 'hello', 50, 3)).toEqual([])
    expect(await mock.searchText('/ws', '   ', 50, 4)).toEqual([])
    expect(await mock.searchText('/ws', 'hello', 2, 5)).toHaveLength(2)
  })

  it('按内容识别的未知文本扩展也参与搜索', async () => {
    const hits = await mock.searchText('/ws', '冷门格式', 50, 6)
    expect(hits.map((hit) => hit.name)).toEqual(['custom.xyz'])
  })
})

describe('文本文件能力规则', () => {
  it('支持常见表格、配置、隐藏文本名与无扩展说明文件', () => {
    for (const path of ['data.csv', 'config.toml', '.gitignore', '.env', 'LICENSE', 'Dockerfile']) {
      expect(isPlainTextPath(path), path).toBe(true)
      expect(isOpenablePath(path), path).toBe(true)
    }
  })
})

describe('本地设置容错', () => {
  it('没有持久化设置时使用设计默认值', () => {
    const ui = useUi()
    const ai = useAi()
    expect(ui.fontSize).toBe(16)
    expect(ui.lineWidth).toBe(760)
    expect(ai.panelWidth).toBe(360)
  })

  it('越界或损坏的布局设置会回到安全范围', () => {
    localStorage.setItem('bmd.fontSize', '999')
    localStorage.setItem('bmd.lineWidth', 'bad')
    localStorage.setItem('bmd.ai.width', '-20')
    localStorage.setItem('bmd.ai.providers', '{}')
    localStorage.setItem('bmd.ai.commands', '[null]')
    setActivePinia(createPinia())

    const ui = useUi()
    const ai = useAi()
    expect(ui.fontSize).toBe(24)
    expect(ui.lineWidth).toBe(760)
    expect(ai.panelWidth).toBe(280)
    expect(ai.customProviders).toEqual([])
    expect(ai.customCommands).toEqual([])
  })
})

describe('新建文件关闭策略（FR：未编辑不弹确认）', () => {
  it('新建未编辑：dirty=false，关闭不询问直接移除', async () => {
    const tabs = useTabs()
    const t = await tabs.newFile()
    expect(t.dirty).toBe(false)
    mock.confirm = vi.fn(async () => false)
    expect(await tabs.closeTab(t.id)).toBe(true)
    expect(mock.confirm).not.toHaveBeenCalled()
    expect(tabs.tabs).toHaveLength(0)
  })

  it('新建后编辑过：关闭需确认，拒绝则保留', async () => {
    const tabs = useTabs()
    const t = await tabs.newFile()
    typeInto(t.id, '草稿')
    expect(t.dirty).toBe(true)
    mock.confirm = vi.fn(async () => false)
    expect(await tabs.closeTab(t.id)).toBe(false)
    expect(mock.confirm).toHaveBeenCalledOnce()
    expect(tabs.tabs).toHaveLength(1)
  })
})

describe('自定义技能（QuickCommand CRUD 与持久化）', () => {
  it('commands = 内置 + 自定义；保存落 localStorage，新 store 实例可恢复', () => {
    localStorage.removeItem('bmd.ai.commands')
    const ai = useAi()
    expect(ai.commands.map((c) => c.id)).toEqual(BUILTIN_COMMANDS.map((c) => c.id))

    ai.customCommands.push({ id: 'skill-x', label: '去 AI 味', prompt: '改写：{sel}' })
    ai.saveCustomCommands()
    expect(ai.commands.at(-1)!.label).toBe('去 AI 味')

    // 新 pinia 实例（模拟重启）从 localStorage 恢复
    setActivePinia(createPinia())
    const ai2 = useAi()
    expect(ai2.customCommands).toEqual([{ id: 'skill-x', label: '去 AI 味', prompt: '改写：{sel}' }])

    ai2.customCommands = ai2.customCommands.filter((c) => c.id !== 'skill-x')
    ai2.saveCustomCommands()
    expect(JSON.parse(localStorage.getItem('bmd.ai.commands')!)).toEqual([])
    localStorage.removeItem('bmd.ai.commands')
  })

  it('内置技能不可被自定义列表污染：builtin 标记存在', () => {
    for (const c of BUILTIN_COMMANDS) expect(c.builtin).toBe(true)
  })
})

describe('keyHint 快捷键提示平台化', () => {
  it('jsdom（非 mac）环境：mac 符号转 Ctrl/Shift/Alt 写法', () => {
    expect(isMac).toBe(false)
    expect(keyHint('⌘N')).toBe('Ctrl+N')
    expect(keyHint('⌘⇧L')).toBe('Ctrl+Shift+L')
    expect(keyHint('⌘⇧O')).toBe('Ctrl+Shift+O')
    expect(keyHint('⌘,')).toBe('Ctrl+,')
    expect(keyHint('⌥F')).toBe('Alt+F')
    expect(keyHint('⌃K')).toBe('Ctrl+K')
  })
})
