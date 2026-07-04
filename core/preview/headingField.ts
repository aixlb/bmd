import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

// 标题行的行级装饰（字号/字重）。与 reveal 无关、只依赖文档内容，
// 放在 StateField 里增量维护，避免 ViewPlugin 提供影响纵向布局的装饰（CM6 约束）。
const HEADING_LINE = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `bmd-heading bmd-h${level}` }),
)

const ATX_RE = /^ATXHeading([1-6])$/

function computeHeadings(
  state: EditorState,
  from: number,
  to: number,
  add: (pos: number, deco: Decoration) => void,
) {
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const m = ATX_RE.exec(node.name)
      if (!m) return
      const line = state.doc.lineAt(node.from)
      add(line.from, HEADING_LINE[Number(m[1]) - 1])
      return false
    },
  })
}

export const headingDecorations = StateField.define<DecorationSet>({
  create(state) {
    const builder = new RangeSetBuilder<Decoration>()
    computeHeadings(state, 0, state.doc.length, (pos, deco) => builder.add(pos, pos, deco))
    return builder.finish()
  },

  update(deco, tr) {
    // 解析进度推进（大文档异步 parse）而文档未变：全量重算一次
    if (!tr.docChanged) {
      if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
        const builder = new RangeSetBuilder<Decoration>()
        computeHeadings(tr.state, 0, tr.state.doc.length, (pos, d) => builder.add(pos, pos, d))
        return builder.finish()
      }
      return deco
    }

    // 增量：先 map，再重算受影响的整行区间
    deco = deco.map(tr.changes)
    const spans: { from: number; to: number }[] = []
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const from = tr.state.doc.lineAt(fromB).from
      const to = tr.state.doc.lineAt(Math.min(toB, tr.state.doc.length)).to
      spans.push({ from, to })
    })
    for (const span of spans) {
      const add: Range<Decoration>[] = []
      computeHeadings(tr.state, span.from, span.to, (pos, d) => add.push(d.range(pos)))
      deco = deco.update({
        filterFrom: span.from,
        filterTo: span.to,
        filter: () => false,
        add,
      })
    }
    return deco
  },

  provide: (field) => EditorView.decorations.from(field),
})
