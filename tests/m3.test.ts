import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorSelection, EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { mathExtension } from '../core/parser/math'
import { blockPreviewField } from '../core/preview/blockField'
import { bmdConfig } from '../core/config'
import { parseTable } from '../core/preview/widgets'
import { createMockIpc, setIpc, type Ipc } from '../src/lib/ipc'
import { editorRegistry } from '../src/lib/editorRegistry'
import { useTabs } from '../src/stores/tabs'

function stateOf(doc: string, cursor = 0) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(Math.min(cursor, doc.length)),
    extensions: [
      markdown({ base: markdownLanguage, extensions: [mathExtension] }),
      bmdConfig.of({}),
      blockPreviewField,
    ],
  })
  ensureSyntaxTree(state, doc.length, 5_000)
  return state
}

function nodeNames(doc: string): string[] {
  const state = stateOf(doc)
  const names: string[] = []
  syntaxTree(state).iterate({
    enter(n) {
      names.push(n.name)
    },
  })
  return names
}

describe('数学语法解析', () => {
  it('行内 $...$ 生成 InlineMath 节点', () => {
    expect(nodeNames('质能方程 $e=mc^2$ 成立')).toContain('InlineMath')
  })

  it('货币写法 $5 和 $6 不误判为行内数学（Pandoc 邻接约束）', () => {
    expect(nodeNames('价格 $5 和 $6 各一')).not.toContain('InlineMath')
  })

  it('空 $$ 与转义 \\$ 不解析为行内数学', () => {
    expect(nodeNames('转义 \\$abc\\$ 不是公式')).not.toContain('InlineMath')
  })

  it('块级 $$...$$（多行）生成 BlockMath', () => {
    const names = nodeNames('$$\ne = mc^2\n$$\n')
    expect(names).toContain('BlockMath')
  })

  it('单行块级 $$e=mc^2$$', () => {
    expect(nodeNames('$$e=mc^2$$\n')).toContain('BlockMath')
  })
})

describe('块级 widget 结构（M3 新增）', () => {
  function entries(doc: string, cursor = 0) {
    return stateOf(doc, cursor).field(blockPreviewField).entries
  }

  it('行内公式/块公式/mermaid/表格全部入结构表', () => {
    const doc = [
      '有 $a+b$ 公式',
      '',
      '$$',
      'c^2',
      '$$',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
    ].join('\n')
    const types = entries(doc).map((e) => e.type)
    expect(types).toContain('mathInline')
    expect(types).toContain('mathBlock')
    expect(types).toContain('mermaid')
    expect(types).toContain('table')
  })

  it('mermaid 代码块提取代码体；普通代码块不入表', () => {
    const doc = '```mermaid\ngraph TD\n```\n\n```js\nx\n```\n'
    const es = entries(doc, doc.length)
    expect(es).toHaveLength(1)
    expect(es[0].payload).toContain('graph TD')
  })

  it('数学表达式剥掉 $ 定界符', () => {
    const es = entries('见 $x^2$ 处\n', 12)
    expect(es[0].payload).toBe('x^2')
  })
})

describe('表格源码解析', () => {
  it('对齐与转义管道', () => {
    const model = parseTable('| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| a | b\\|c | d |')
    expect(model).not.toBeNull()
    expect(model!.aligns).toEqual(['left', 'center', 'right'])
    expect(model!.rows[0][1]).toBe('b|c')
  })

  it('非法分隔行返回 null', () => {
    expect(parseTable('| a |\n| xx |')).toBeNull()
  })
})

describe('外部变更流（FR-05/21）', () => {
  let mock: Ipc
  beforeEach(() => {
    setActivePinia(createPinia())
    editorRegistry.clear()
    mock = createMockIpc({ '/ws/a.md': 'v1' })
    setIpc(mock)
  })

  it('未改动的打开文件被外部修改 → 静默重载', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/a.md')
    await mock.writeDocAtomic('/ws/a.md', '外部新内容', null)
    await tabs.handleExternalChanges(['/ws/a.md'])
    expect(t.conflict).toBe(false)
    expect(t.dirty).toBe(false)
    expect(t.initialDoc).toBe('外部新内容')
  })

  it('有本地改动 → 标记冲突；保留本地后保存直接覆盖', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/a.md')
    editorRegistry.set(t.id, EditorState.create({ doc: '本地改动' }))
    tabs.markDirty(t.id)
    await mock.writeDocAtomic('/ws/a.md', '外部内容', null)
    await tabs.handleExternalChanges(['/ws/a.md'])
    expect(t.conflict).toBe(true)

    tabs.keepLocal(t.id)
    expect(t.conflict).toBe(false)
    expect(await tabs.saveTab(t.id)).toBe(true)
    expect((await mock.readDoc('/ws/a.md')).content).toBe('本地改动')
  })

  it('加载磁盘版本 → 丢弃本地', async () => {
    const tabs = useTabs()
    const t = await tabs.openFile('/ws/a.md')
    editorRegistry.set(t.id, EditorState.create({ doc: '本地改动' }))
    tabs.markDirty(t.id)
    await mock.writeDocAtomic('/ws/a.md', '磁盘内容', null)
    await tabs.handleExternalChanges(['/ws/a.md'])
    await tabs.reloadFromDisk(t.id)
    expect(t.dirty).toBe(false)
    expect(t.conflict).toBe(false)
    expect(t.initialDoc).toBe('磁盘内容')
  })
})
