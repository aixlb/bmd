import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import type { Tree } from '@lezer/common'

// ---------------------------------------------------------------------------
// reveal-on-cursor 装饰引擎（DESIGN.md §3.3）
//
// 规则：选区与元素相交 → 源码标记以弱色显示；不相交 → 标记隐藏、内容按
// 排版样式渲染。行内元素按字符区间严格相交判定（光标恰在边界不展开，
// 与 Typora 一致）；标题按「光标是否在该行」判定。
// ---------------------------------------------------------------------------

const CONTENT_MARK: Record<string, Decoration> = {
  StrongEmphasis: Decoration.mark({ class: 'bmd-strong' }),
  Emphasis: Decoration.mark({ class: 'bmd-em' }),
  InlineCode: Decoration.mark({ class: 'bmd-code' }),
  Strikethrough: Decoration.mark({ class: 'bmd-strike' }),
}

const syntaxMark = Decoration.mark({ class: 'bmd-syntax' })
const urlMark = Decoration.mark({ class: 'bmd-url' })
const hide = Decoration.replace({})

const ATX_RE = /^ATXHeading[1-6]$/

function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from < to && r.to > from)
}

function selectionOnLine(state: EditorState, lineFrom: number, lineTo: number): boolean {
  return state.selection.ranges.some((r) => r.from <= lineTo && r.to >= lineFrom)
}

export function buildInlineDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const deco: Range<Decoration>[] = []
  const doc = state.doc

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name

        if (ATX_RE.test(name)) {
          const line = doc.lineAt(node.from)
          const revealed = selectionOnLine(state, line.from, line.to)
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name !== 'HeaderMark') continue
            if (revealed) {
              deco.push(syntaxMark.range(child.from, child.to))
            } else {
              // 连同 "# " 后的空格一起隐藏
              let end = child.to
              if (end < doc.length && doc.sliceString(end, end + 1) === ' ') end += 1
              deco.push(hide.range(child.from, end))
            }
          }
          return // 继续下钻：标题内的行内元素照常处理
        }

        const contentMark = CONTENT_MARK[name]
        if (contentMark) {
          const revealed = selectionIntersects(state, node.from, node.to)
          deco.push(contentMark.range(node.from, node.to))
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name.endsWith('Mark')) {
              deco.push((revealed ? syntaxMark : hide).range(child.from, child.to))
            }
          }
          return
        }

        if (name === 'Link') {
          const revealed = selectionIntersects(state, node.from, node.to)
          const linkNode = node.node
          const marks = linkNode.getChildren('LinkMark')
          const urlNode = linkNode.getChild('URL')
          if (marks.length < 2) return

          const textFrom = marks[0].to
          const textTo = marks[1].from
          if (textTo > textFrom) {
            const url = urlNode ? doc.sliceString(urlNode.from, urlNode.to) : ''
            deco.push(
              Decoration.mark({
                class: 'bmd-link',
                attributes: url ? { 'data-href': url, title: url } : undefined,
              }).range(textFrom, textTo),
            )
          }

          if (revealed) {
            for (const m of marks) deco.push(syntaxMark.range(m.from, m.to))
            if (urlNode) deco.push(urlMark.range(urlNode.from, urlNode.to))
          } else {
            deco.push(hide.range(marks[0].from, marks[0].to))
            // 从 "]" 一直隐藏到链接末尾，覆盖 ](url "title")
            deco.push(hide.range(marks[1].from, node.to))
          }
          return
        }
      },
    })
  }

  return Decoration.set(deco, true)
}

export const inlinePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private tree: Tree
    private pendingRebuild = false

    constructor(view: EditorView) {
      this.tree = syntaxTree(view.state)
      this.decorations = buildInlineDecorations(view.state, view.visibleRanges)
    }

    update(update: ViewUpdate) {
      // IME 铁律（DESIGN.md §3.4）：输入法组合期间绝不增删装饰，
      // 只把现有装饰随文档变更映射位置；组合结束后的首个更新统一重算。
      if (update.view.composing) {
        this.decorations = this.decorations.map(update.changes)
        this.pendingRebuild = true
        return
      }
      const tree = syntaxTree(update.state)
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        tree !== this.tree ||
        this.pendingRebuild
      ) {
        this.tree = tree
        this.pendingRebuild = false
        this.decorations = buildInlineDecorations(update.state, update.view.visibleRanges)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

/** ⌘/Ctrl+点击打开链接 */
export function linkClickHandler(onOpenLink: (url: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(event) {
      if (!(event.metaKey || event.ctrlKey)) return false
      const el = (event.target as HTMLElement).closest('.bmd-link') as HTMLElement | null
      const href = el?.dataset.href
      if (href) {
        event.preventDefault()
        onOpenLink(href)
        return true
      }
      return false
    },
  })
}
