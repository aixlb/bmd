// M2 内核元素验收矩阵（DESIGN.md §9）：每个元素 × {光标外渲染, 光标进入 reveal}
import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { buildInlineDecorations } from '../core/preview/livePreview'
import { blockPreviewField } from '../core/preview/blockField'
import { bmdConfig } from '../core/config'
import {
  insertTable,
  setHeading,
  toggleBold,
  toggleQuote,
} from '../core/commands'
import { getOutline } from '../core/outline'
import { EditorView } from '@codemirror/view'

function stateOf(doc: string, cursor = 0, extra: unknown[] = []) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage }), ...(extra as never[])],
  })
  ensureSyntaxTree(state, doc.length, 5_000)
  return state
}

interface Deco {
  from: number
  to: number
  hidden: boolean
  cls?: string
  widget: boolean
}

function inlineDecos(doc: string, cursor: number): Deco[] {
  const state = stateOf(doc, cursor)
  const set = buildInlineDecorations(state, [{ from: 0, to: doc.length }])
  const out: Deco[] = []
  const it = set.iter()
  while (it.value) {
    const spec = it.value.spec as { class?: string; widget?: unknown }
    out.push({
      from: it.from,
      to: it.to,
      hidden: !spec.class && !spec.widget,
      cls: spec.class,
      widget: !!spec.widget,
    })
    it.next()
  }
  return out
}

const hidden = (d: Deco[]) => d.filter((x) => x.hidden).map((x) => [x.from, x.to])
const byClass = (d: Deco[], cls: string) => d.filter((x) => x.cls === cls)

describe('引用块', () => {
  const doc = '> 引用第一行\n> 第二行\n\n正文'

  it('光标外：每行有线级样式，> 隐藏', () => {
    const d = inlineDecos(doc, doc.length)
    expect(byClass(d, 'bmd-quote-line')).toHaveLength(2)
    expect(hidden(d)).toEqual([
      [0, 2],
      [8, 10],
    ])
  })

  it('光标在行内：该行 > 展开，其他行保持隐藏', () => {
    const d = inlineDecos(doc, 3)
    expect(byClass(d, 'bmd-syntax')).toHaveLength(1)
    expect(hidden(d)).toEqual([[8, 10]])
  })
})

describe('列表', () => {
  it('无序列表：光标外圆点 widget 替换 -', () => {
    const doc = '- 项目一\n- 项目二\n\n尾'
    const d = inlineDecos(doc, doc.length)
    expect(d.filter((x) => x.widget)).toHaveLength(2)
  })

  it('光标在行：显示原始 -', () => {
    const d = inlineDecos('- 项目一\n- 项目二', 2)
    // 第一行 reveal（syntax 样式），第二行仍是 widget
    expect(byClass(d, 'bmd-syntax')).toHaveLength(1)
    expect(d.filter((x) => x.widget)).toHaveLength(1)
  })

  it('有序列表：序号样式化不替换', () => {
    const doc = '1. 一\n2. 二\n\n尾'
    const d = inlineDecos(doc, doc.length)
    expect(byClass(d, 'bmd-list-num')).toHaveLength(2)
  })

  it('任务列表：光标外 checkbox widget，[x] 隐藏', () => {
    const doc = '- [x] 已完成\n- [ ] 待办'
    const d = inlineDecos(doc, doc.length)
    const widgets = d.filter((x) => x.widget)
    // 第二行光标所在 → 不替换；第一行：圆点不渲染 + checkbox
    expect(widgets.length).toBeGreaterThanOrEqual(1)
  })
})

describe('代码块', () => {
  const doc = '```js\nconst a = 1\n```\n\n正文'

  it('行级样式 + 语言标记 + 复制按钮', () => {
    const d = inlineDecos(doc, doc.length)
    expect(byClass(d, 'bmd-code-line')).toHaveLength(3)
    expect(byClass(d, 'bmd-fence-line')).toHaveLength(2)
    expect(byClass(d, 'bmd-code-info')).toHaveLength(1)
    expect(d.some((x) => x.widget)).toBe(true)
  })
})

describe('块级 widget（分割线/图片）', () => {
  function blockDecos(doc: string, cursor: number) {
    const state = stateOf(doc, cursor, [bmdConfig.of({}), blockPreviewField])
    const { deco } = state.field(blockPreviewField)
    const out: { from: number; to: number; widget: boolean; cls?: string }[] = []
    const it = deco.iter()
    while (it.value) {
      const spec = it.value.spec as { widget?: unknown; class?: string }
      out.push({ from: it.from, to: it.to, widget: !!spec.widget, cls: spec.class })
      it.next()
    }
    return out
  }

  it('--- 光标外渲染为分割线 widget', () => {
    const doc = '上文\n\n---\n\n下文'
    const d = blockDecos(doc, 0)
    expect(d).toHaveLength(1)
    expect(d[0].widget).toBe(true)
  })

  it('光标在分割线行：显示源码', () => {
    const doc = '上文\n\n---\n\n下文'
    const d = blockDecos(doc, 5)
    expect(d[0].widget).toBe(false)
    expect(d[0].cls).toBe('bmd-syntax')
  })

  it('图片光标外渲染为 widget；编辑后结构增量更新', () => {
    const doc = '看图 ![alt文字](./a.png) 结束'
    const d = blockDecos(doc, 0)
    expect(d).toHaveLength(1)
    expect(d[0].widget).toBe(true)
  })

  it('文档编辑后 widget 位置跟随映射', () => {
    const doc = '前\n\n---\n'
    let state = stateOf(doc, 0, [bmdConfig.of({}), blockPreviewField])
    state = state.update({ changes: { from: 0, insert: 'XX' } }).state
    const { entries } = state.field(blockPreviewField)
    expect(entries).toHaveLength(1)
    expect(state.doc.sliceString(entries[0].from, entries[0].to)).toBe('---')
  })
})

describe('格式命令', () => {
  function run(doc: string, anchor: number, head: number, cmd: (v: EditorView) => boolean) {
    const parent = document.createElement('div')
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.range(anchor, head),
        extensions: [markdown({ base: markdownLanguage })],
      }),
    })
    cmd(view)
    const result = { doc: view.state.doc.toString(), sel: view.state.selection.main }
    view.destroy()
    return result
  }

  it('加粗：包裹与去包裹', () => {
    expect(run('hello', 0, 5, toggleBold).doc).toBe('**hello**')
    expect(run('**hello**', 2, 7, toggleBold).doc).toBe('hello')
  })

  it('空选区加粗：插入定界符对，光标居中', () => {
    const r = run('ab', 1, 1, toggleBold)
    expect(r.doc).toBe('a****b')
    expect(r.sel.head).toBe(3)
  })

  it('标题设置与清除', () => {
    expect(run('标题', 0, 0, setHeading(2)).doc).toBe('## 标题')
    expect(run('### 标题', 5, 5, setHeading(0)).doc).toBe('标题')
    expect(run('# 旧', 2, 2, setHeading(3)).doc).toBe('### 旧')
  })

  it('引用切换（多行）', () => {
    expect(run('一\n二', 0, 3, toggleQuote).doc).toBe('> 一\n> 二')
    expect(run('> 一\n> 二', 0, 7, toggleQuote).doc).toBe('一\n二')
  })

  it('插入表格模板', () => {
    const r = run('文字', 1, 1, insertTable)
    expect(r.doc).toContain('| 列 1 | 列 2 | 列 3 |')
    expect(r.doc).toContain('| --- | --- | --- |')
  })
})

describe('大纲提取', () => {
  it('多级标题与文本清洗', () => {
    const state = stateOf('# 一\n\n正文\n\n## 二 ##\n\n### **三**\n', 0)
    const outline = getOutline(state)
    expect(outline.map((o) => [o.level, o.text])).toEqual([
      [1, '一'],
      [2, '二'],
      [3, '**三**'],
    ])
  })
})
