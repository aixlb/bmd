import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { bmdConfig } from '../config'

// 影响纵向布局的 widget（分割线、图片）必须由 StateField 提供（CM6 约束）。
// 结构（位置清单）只依赖文档内容；reveal 依赖选区——两者变化都重derive装饰，
// 但 derive 只是对结构数组的一次线性走查，与文档长度无关。

interface BlockEntry {
  from: number
  to: number
  type: 'hr' | 'image'
  src?: string
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

function scanBlocks(state: EditorState, from: number, to: number, out: BlockEntry[]) {
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === 'HorizontalRule') {
        out.push({ from: node.from, to: node.to, type: 'hr' })
        return false
      }
      if (node.name === 'Image') {
        const n = node.node
        const urlNode = n.getChild('URL')
        const marks = n.getChildren('LinkMark')
        const src = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : ''
        const alt =
          marks.length >= 2 && marks[1].from > marks[0].to
            ? state.doc.sliceString(marks[0].to, marks[1].from)
            : ''
        if (src) out.push({ from: node.from, to: node.to, type: 'image', src, alt })
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

function derive(state: EditorState, entries: BlockEntry[]): DecorationSet {
  const config = state.facet(bmdConfig)
  const deco: Range<Decoration>[] = []
  for (const e of entries) {
    const line = state.doc.lineAt(e.from)
    const lineEnd = state.doc.lineAt(e.to).to
    // 分割线按行 reveal；行内图片按字符区间严格 reveal（光标在同行文字处不展开）
    const revealed =
      e.type === 'hr'
        ? state.selection.ranges.some((r) => r.from <= lineEnd && r.to >= line.from)
        : state.selection.ranges.some((r) => r.from < e.to && r.to > e.from)
    if (revealed) {
      deco.push(Decoration.mark({ class: 'bmd-syntax' }).range(e.from, e.to))
      continue
    }
    if (e.type === 'hr') {
      deco.push(Decoration.replace({ widget: hrWidget }).range(e.from, e.to))
    } else {
      deco.push(
        Decoration.replace({
          widget: new ImageWidget(e.src!, e.alt ?? '', config.resolveImageSrc(e.src!)),
        }).range(e.from, e.to),
      )
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
      // 位置映射 + 受影响整行区间重扫
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
      // 异步解析推进（大文档首次打开）
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
