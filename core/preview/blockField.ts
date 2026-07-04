import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { bmdConfig } from '../config'
import { KatexWidget, MermaidWidget, TableWidget } from './widgets'

// 影响纵向布局的 widget（分割线、图片、公式、Mermaid、表格）由 StateField 提供
// （CM6 约束）。结构（位置清单）只依赖文档内容；reveal 依赖选区——两者变化都
// 重新 derive 装饰，derive 只是对结构数组的线性走查，与文档长度无关。

type BlockKind = 'hr' | 'image' | 'mathInline' | 'mathBlock' | 'mermaid' | 'table'

interface BlockEntry {
  from: number
  to: number
  type: BlockKind
  /** image: src；math: 表达式；mermaid: 代码；table: 源码 */
  payload: string
  alt?: string
}

class HrWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'bmd-hr'
    return el
  }
  ignoreEvent() {
    return false
  }
}
const hrWidget = new HrWidget()

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly resolved: string,
  ) {
    super()
  }
  eq(other: ImageWidget) {
    return other.resolved === this.resolved && other.alt === this.alt
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'bmd-image'
    const img = document.createElement('img')
    img.alt = this.alt
    img.src = this.resolved
    img.draggable = false
    img.addEventListener('error', () => {
      wrap.classList.add('broken')
      wrap.textContent = `⚠ 图片加载失败：${this.src}`
    })
    wrap.appendChild(img)
    return wrap
  }
  ignoreEvent() {
    return false
  }
}

function stripMath(state: EditorState, from: number, to: number): string {
  return state.doc
    .sliceString(from, to)
    .replace(/^\$\$?/, '')
    .replace(/\$\$?$/, '')
    .trim()
}

function scanBlocks(state: EditorState, from: number, to: number, out: BlockEntry[]) {
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      switch (node.name) {
        case 'HorizontalRule':
          out.push({ from: node.from, to: node.to, type: 'hr', payload: '' })
          return false
        case 'Image': {
          const n = node.node
          const urlNode = n.getChild('URL')
          const marks = n.getChildren('LinkMark')
          const src = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : ''
          const alt =
            marks.length >= 2 && marks[1].from > marks[0].to
              ? state.doc.sliceString(marks[0].to, marks[1].from)
              : ''
          if (src) out.push({ from: node.from, to: node.to, type: 'image', payload: src, alt })
          return false
        }
        case 'InlineMath':
          out.push({
            from: node.from,
            to: node.to,
            type: 'mathInline',
            payload: stripMath(state, node.from, node.to),
          })
          return false
        case 'BlockMath':
          out.push({
            from: node.from,
            to: node.to,
            type: 'mathBlock',
            payload: stripMath(state, node.from, node.to),
          })
          return false
        case 'FencedCode': {
          const info = node.node.getChild('CodeInfo')
          const lang = info ? state.doc.sliceString(info.from, info.to).trim() : ''
          if (lang === 'mermaid') {
            const codeText = node.node.getChild('CodeText')
            const code = codeText ? state.doc.sliceString(codeText.from, codeText.to) : ''
            out.push({ from: node.from, to: node.to, type: 'mermaid', payload: code })
            return false
          }
          return false
        }
        case 'Table':
          out.push({
            from: node.from,
            to: node.to,
            type: 'table',
            payload: state.doc.sliceString(node.from, node.to),
          })
          return false
      }
      return undefined
    },
  })
}

function fullScan(state: EditorState): BlockEntry[] {
  const out: BlockEntry[] = []
  scanBlocks(state, 0, state.doc.length, out)
  return out
}

const revealMark = Decoration.mark({ class: 'bmd-syntax' })

function derive(state: EditorState, entries: BlockEntry[]): DecorationSet {
  const config = state.facet(bmdConfig)
  const deco: Range<Decoration>[] = []
  for (const e of entries) {
    const line = state.doc.lineAt(e.from)
    const lineEnd = state.doc.lineAt(Math.min(e.to, state.doc.length)).to
    // 行内元素（图片/行内公式）按字符区间严格 reveal；块级按行 reveal
    const inlineKind = e.type === 'image' || e.type === 'mathInline'
    const revealed = inlineKind
      ? state.selection.ranges.some((r) => r.from < e.to && r.to > e.from)
      : state.selection.ranges.some((r) => r.from <= lineEnd && r.to >= line.from)

    if (revealed) {
      if (inlineKind || e.type === 'hr' || e.type === 'mathBlock') {
        deco.push(revealMark.range(e.from, e.to))
      }
      // mermaid/table 的 reveal 态交给 inlinePreview 的代码块/表格源码样式
      continue
    }

    switch (e.type) {
      case 'hr':
        deco.push(Decoration.replace({ widget: hrWidget }).range(e.from, e.to))
        break
      case 'image':
        deco.push(
          Decoration.replace({
            widget: new ImageWidget(e.payload, e.alt ?? '', config.resolveImageSrc(e.payload)),
          }).range(e.from, e.to),
        )
        break
      case 'mathInline':
        deco.push(
          Decoration.replace({ widget: new KatexWidget(e.payload, false) }).range(e.from, e.to),
        )
        break
      case 'mathBlock':
        deco.push(
          Decoration.replace({ widget: new KatexWidget(e.payload, true), block: true }).range(
            line.from,
            lineEnd,
          ),
        )
        break
      case 'mermaid':
        deco.push(
          Decoration.replace({ widget: new MermaidWidget(e.payload), block: true }).range(
            line.from,
            lineEnd,
          ),
        )
        break
      case 'table':
        deco.push(
          Decoration.replace({ widget: new TableWidget(e.payload), block: true }).range(
            line.from,
            lineEnd,
          ),
        )
        break
    }
  }
  return Decoration.set(deco, true)
}

interface BlockState {
  entries: BlockEntry[]
  deco: DecorationSet
}

export const blockPreviewField = StateField.define<BlockState>({
  create(state) {
    const entries = fullScan(state)
    return { entries, deco: derive(state, entries) }
  },

  update(value, tr) {
    let entries = value.entries
    let structureChanged = false

    if (tr.docChanged) {
      const spans: { from: number; to: number }[] = []
      tr.changes.iterChangedRanges((_fa, _ta, fb, tb) => {
        const from = tr.state.doc.lineAt(fb).from
        const to = tr.state.doc.lineAt(Math.min(tb, tr.state.doc.length)).to
        spans.push({ from, to })
      })
      entries = entries
        .map((e) => {
          const from = tr.changes.mapPos(e.from, 1)
          const to = tr.changes.mapPos(e.to, -1)
          return { ...e, from, to }
        })
        .filter((e) => e.to > e.from && !spans.some((s) => e.from <= s.to && e.to >= s.from))
      for (const s of spans) {
        const found: BlockEntry[] = []
        scanBlocks(tr.state, s.from, s.to, found)
        entries = entries.concat(found)
      }
      entries.sort((a, b) => a.from - b.from)
      structureChanged = true
    } else if (syntaxTree(tr.state) !== syntaxTree(tr.startState)) {
      entries = fullScan(tr.state)
      structureChanged = true
    }

    if (structureChanged || tr.selection) {
      return { entries, deco: derive(tr.state, entries) }
    }
    return value
  },

  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
})
