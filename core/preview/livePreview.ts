import { syntaxTree } from '@codemirror/language'
import type { EditorState, Range } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import type { SyntaxNode, Tree } from '@lezer/common'

// ---------------------------------------------------------------------------
// reveal-on-cursor 装饰引擎（DESIGN.md §3.3）——行内与行级（不影响纵向布局）部分。
// 影响纵向布局的 widget（分割线/图片）在 blockField.ts 的 StateField 中。
//
// 规则：选区与元素相交 → 源码标记以弱色显示；不相交 → 标记隐藏、内容按
// 排版样式渲染。行内元素按字符区间严格相交判定（光标恰在边界不展开，
// 与 Typora 一致）；块级/行级元素按「光标是否在该行」判定。
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
const listNumMark = Decoration.mark({ class: 'bmd-list-num' })
const quoteLine = Decoration.line({ class: 'bmd-quote-line' })
const codeLine = Decoration.line({ class: 'bmd-code-line' })
const fenceLine = Decoration.line({ class: 'bmd-fence-line' })

const ATX_RE = /^ATXHeading[1-6]$/

function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from < to && r.to > from)
}

function selectionOnLine(state: EditorState, lineFrom: number, lineTo: number): boolean {
  return state.selection.ranges.some((r) => r.from <= lineTo && r.to >= lineFrom)
}

class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const s = document.createElement('span')
    s.className = 'bmd-bullet'
    s.textContent = '•'
    return s
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() })

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'bmd-checkbox'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = view.posAtDOM(box)
      const text = view.state.doc.sliceString(pos, pos + 3)
      if (/^\[[ xX]\]$/.test(text)) {
        view.dispatch({
          changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' },
          userEvent: 'input.toggle-task',
        })
      }
    })
    return box
  }
  ignoreEvent() {
    return true
  }
}

class CopyButtonWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }
  eq(other: CopyButtonWidget) {
    return other.code === this.code
  }
  toDOM() {
    const btn = document.createElement('button')
    btn.className = 'bmd-copy-btn'
    btn.type = 'button'
    btn.textContent = '复制'
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      void navigator.clipboard?.writeText(this.code)
      btn.textContent = '已复制'
      setTimeout(() => (btn.textContent = '复制'), 1200)
    })
    return btn
  }
  ignoreEvent() {
    return true
  }
}

/** 隐藏标记，若后随一个空格则一并隐藏（如 "# " / "> "） */
function hideWithSpace(deco: Range<Decoration>[], state: EditorState, from: number, to: number) {
  let end = to
  if (end < state.doc.length && state.doc.sliceString(end, end + 1) === ' ') end += 1
  if (end > from) deco.push(hide.range(from, end))
}

function decorateHeading(
  deco: Range<Decoration>[],
  state: EditorState,
  node: SyntaxNode,
) {
  const line = state.doc.lineAt(node.from)
  const revealed = selectionOnLine(state, line.from, line.to)
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'HeaderMark') continue
    if (revealed) deco.push(syntaxMark.range(child.from, child.to))
    else hideWithSpace(deco, state, child.from, child.to)
  }
}

function decorateInline(
  deco: Range<Decoration>[],
  state: EditorState,
  node: SyntaxNode,
  contentMark: Decoration,
) {
  const revealed = selectionIntersects(state, node.from, node.to)
  deco.push(contentMark.range(node.from, node.to))
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name.endsWith('Mark')) {
      deco.push((revealed ? syntaxMark : hide).range(child.from, child.to))
    }
  }
}

function decorateLink(deco: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const revealed = selectionIntersects(state, node.from, node.to)
  const marks = node.getChildren('LinkMark')
  const urlNode = node.getChild('URL')
  if (marks.length < 2) return

  const textFrom = marks[0].to
  const textTo = marks[1].from
  if (textTo > textFrom) {
    const url = urlNode ? state.doc.sliceString(urlNode.from, urlNode.to) : ''
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
    deco.push(hide.range(marks[1].from, node.to))
  }
}

function decorateAutolink(deco: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const url = state.doc.sliceString(node.from, node.to).replace(/^<|>$/g, '')
  deco.push(
    Decoration.mark({ class: 'bmd-link', attributes: { 'data-href': url, title: url } }).range(
      node.from,
      node.to,
    ),
  )
}

function decorateQuote(deco: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  // 引用块每行加线级样式；"> " 标记按行 reveal
  const first = state.doc.lineAt(node.from).number
  const last = state.doc.lineAt(node.to).number
  for (let n = first; n <= last; n++) {
    deco.push(quoteLine.range(state.doc.line(n).from))
  }
}

function decorateQuoteMark(deco: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const line = state.doc.lineAt(node.from)
  if (selectionOnLine(state, line.from, line.to)) {
    deco.push(syntaxMark.range(node.from, node.to))
  } else {
    hideWithSpace(deco, state, node.from, node.to)
  }
}

function decorateListMark(deco: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const line = state.doc.lineAt(node.from)
  const revealed = selectionOnLine(state, line.from, line.to)
  const text = state.doc.sliceString(node.from, node.to)
  const isBullet = /^[-*+]$/.test(text)
  // 任务项的 ListMark 后随 TaskMarker，圆点不渲染（checkbox 代表该项）
  const sibling = node.nextSibling
  const isTask = sibling?.name === 'Task' || sibling?.firstChild?.name === 'TaskMarker'
  if (revealed) {
    deco.push(syntaxMark.range(node.from, node.to))
  } else if (isTask) {
    // 任务项只显示 checkbox（Typora 行为），"- " 隐藏
    hideWithSpace(deco, state, node.from, node.to)
  } else if (isBullet) {
    deco.push(bullet.range(node.from, node.to))
  } else {
    deco.push(listNumMark.range(node.from, node.to))
  }
}

function decorateTaskMarker(deco: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const line = state.doc.lineAt(node.from)
  const text = state.doc.sliceString(node.from, node.to)
  const checked = /x/i.test(text)
  if (selectionOnLine(state, line.from, line.to)) {
    deco.push(syntaxMark.range(node.from, node.to))
  } else {
    hideWithSpace(deco, state, node.from, node.to)
    deco.push(
      Decoration.widget({ widget: new CheckboxWidget(checked), side: 1 }).range(node.from),
    )
  }
}

function decorateFencedCode(deco: Range<Decoration>[], state: EditorState, node: SyntaxNode) {
  const first = state.doc.lineAt(node.from)
  const last = state.doc.lineAt(node.to)
  for (let n = first.number; n <= last.number; n++) {
    const line = state.doc.line(n)
    deco.push(codeLine.range(line.from))
    if (n === first.number || (n === last.number && /^\s*(```|~~~)/.test(line.text))) {
      deco.push(fenceLine.range(line.from))
    }
  }
  // 复制按钮挂在首行行尾
  const codeText = node.getChild('CodeText')
  const code = codeText ? state.doc.sliceString(codeText.from, codeText.to) : ''
  deco.push(
    Decoration.widget({ widget: new CopyButtonWidget(code), side: 1 }).range(first.to),
  )
  // fence 标记与语言名弱色
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeMark') deco.push(syntaxMark.range(child.from, child.to))
    if (child.name === 'CodeInfo')
      deco.push(Decoration.mark({ class: 'bmd-code-info' }).range(child.from, child.to))
  }
}

export function buildInlineDecorations(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const deco: Range<Decoration>[] = []

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name
        if (ATX_RE.test(name)) {
          decorateHeading(deco, state, node.node)
          return
        }
        const contentMark = CONTENT_MARK[name]
        if (contentMark) {
          decorateInline(deco, state, node.node, contentMark)
          return
        }
        switch (name) {
          case 'Link':
            decorateLink(deco, state, node.node)
            return
          case 'Autolink':
          case 'URL':
            if (name === 'Autolink' || node.node.parent?.name === 'Paragraph') {
              decorateAutolink(deco, state, node.node)
            }
            return
          case 'Blockquote':
            decorateQuote(deco, state, node.node)
            return
          case 'QuoteMark':
            decorateQuoteMark(deco, state, node.node)
            return
          case 'ListMark':
            decorateListMark(deco, state, node.node)
            return
          case 'TaskMarker':
            decorateTaskMarker(deco, state, node.node)
            return
          case 'FencedCode':
            decorateFencedCode(deco, state, node.node)
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
