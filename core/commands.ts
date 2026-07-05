import { EditorSelection } from '@codemirror/state'
import type { Command, KeyBinding } from '@codemirror/view'

// 格式命令：全部是纯文本操作（DESIGN.md §3.6）——包裹/去包裹定界符、改行前缀。

function toggleInline(marker: string): Command {
  const len = marker.length
  const ch = marker[0]
  /** 恰为 2 个 * 的连跑属于加粗定界符，不能当作斜体去包裹（*** 同时含二者，可拆） */
  const isForeignStarPair = (run: number) => ch === '*' && len === 1 && run === 2
  return (view) => {
    const spec = view.state.changeByRange((range) => {
      const { from, to } = range
      const doc = view.state.doc
      const text = doc.sliceString(from, to)

      // 选区内侧定界符连跑长度
      let innerLead = 0
      while (innerLead < 3 && innerLead < text.length && text[innerLead] === ch) innerLead++
      let innerTail = 0
      while (innerTail < 3 && innerTail < text.length && text[text.length - 1 - innerTail] === ch)
        innerTail++
      // 选区外侧定界符连跑长度
      let runBefore = 0
      while (runBefore < 3 && from - runBefore - 1 >= 0 && doc.sliceString(from - runBefore - 1, from - runBefore) === ch)
        runBefore++
      let runAfter = 0
      while (runAfter < 3 && to + runAfter < doc.length && doc.sliceString(to + runAfter, to + runAfter + 1) === ch)
        runAfter++

      // 已被包裹（选区含定界符）→ 去掉；但选区是 **bold** 而按斜体时应嵌套而非剥离
      if (
        text.length >= 2 * len &&
        text.startsWith(marker) &&
        text.endsWith(marker) &&
        !isForeignStarPair(innerLead) &&
        !isForeignStarPair(innerTail)
      ) {
        return {
          changes: [
            { from, to: from + len, insert: '' },
            { from: to - len, to, insert: '' },
          ],
          range: EditorSelection.range(from, to - 2 * len),
        }
      }
      // 已被包裹（定界符在选区外侧）→ 去掉；** 外侧按斜体时同理走包裹分支
      if (
        runBefore >= len &&
        runAfter >= len &&
        !isForeignStarPair(runBefore) &&
        !isForeignStarPair(runAfter)
      ) {
        return {
          changes: [
            { from: from - len, to: from, insert: '' },
            { from: to, to: to + len, insert: '' },
          ],
          range: EditorSelection.range(from - len, to - len),
        }
      }
      // 包裹
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: EditorSelection.range(from + len, to + len),
      }
    })
    view.dispatch(spec, { userEvent: 'input.format' })
    return true
  }
}

export const toggleBold = toggleInline('**')
export const toggleItalic = toggleInline('*')
export const toggleStrikethrough = toggleInline('~~')
export const toggleInlineCode = toggleInline('`')

/** level 0 = 正文（去掉标题前缀） */
export function setHeading(level: number): Command {
  return (view) => {
    const { state } = view
    const changes: { from: number; to: number; insert: string }[] = []
    const seen = new Set<number>()
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number
      const last = state.doc.lineAt(range.to).number
      for (let n = first; n <= last; n++) {
        if (seen.has(n)) continue
        seen.add(n)
        const line = state.doc.line(n)
        const m = /^(#{1,6})\s+/.exec(line.text)
        const prefix = level > 0 ? '#'.repeat(level) + ' ' : ''
        changes.push({ from: line.from, to: line.from + (m?.[0].length ?? 0), insert: prefix })
      }
    }
    view.dispatch({ changes, userEvent: 'input.format' })
    return true
  }
}

export const toggleQuote: Command = (view) => {
  const { state } = view
  const lines: { from: number; text: string }[] = []
  const seen = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n++) {
      if (!seen.has(n)) {
        seen.add(n)
        const line = state.doc.line(n)
        lines.push({ from: line.from, text: line.text })
      }
    }
  }
  const allQuoted = lines.every((l) => /^>\s?/.test(l.text) || l.text === '')
  const changes = lines
    .filter((l) => l.text !== '')
    .map((l) =>
      allQuoted
        ? { from: l.from, to: l.from + (/^>\s?/.exec(l.text)?.[0].length ?? 0), insert: '' }
        : { from: l.from, to: l.from, insert: '> ' },
    )
  view.dispatch({ changes, userEvent: 'input.format' })
  return true
}

// ---- 列表切换：行前缀操作。换型时先剥掉已有列表前缀（含任务框），避免叠加 ----

const UL_RE = /^(\s*)[-*+]\s+(?!\[[ xX]\]\s)/
const OL_RE = /^(\s*)\d+[.)]\s+/
const TASK_RE = /^(\s*)[-*+]\s+\[[ xX]\]\s+/
const ANY_LIST_RE = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/

function toggleList(kind: 'ul' | 'ol' | 'task'): Command {
  const matchRe = kind === 'ul' ? UL_RE : kind === 'ol' ? OL_RE : TASK_RE
  const prefixOf = (n: number) => (kind === 'ul' ? '- ' : kind === 'ol' ? `${n}. ` : '- [ ] ')
  return (view) => {
    const { state } = view
    const lines: { from: number; text: string }[] = []
    const seen = new Set<number>()
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number
      const last = state.doc.lineAt(range.to).number
      for (let n = first; n <= last; n++) {
        if (!seen.has(n)) {
          seen.add(n)
          const line = state.doc.line(n)
          lines.push({ from: line.from, text: line.text })
        }
      }
    }
    const content = lines.filter((l) => l.text.trim() !== '')
    // 空行上触发：直接放一个列表前缀开写
    if (!content.length) {
      const pos = state.selection.main.head
      const prefix = prefixOf(1)
      view.dispatch({
        changes: { from: pos, insert: prefix },
        selection: EditorSelection.cursor(pos + prefix.length),
        userEvent: 'input.format',
      })
      return true
    }
    const allMatch = content.every((l) => matchRe.test(l.text))
    let num = 0
    const changes = content.map((l) => {
      const strip = ANY_LIST_RE.exec(l.text)
      const indent = strip?.[1] ?? /^\s*/.exec(l.text)![0]
      const stripLen = strip?.[0].length ?? indent.length
      return {
        from: l.from + indent.length,
        to: l.from + stripLen,
        insert: allMatch ? '' : prefixOf(++num),
      }
    })
    view.dispatch({ changes, userEvent: 'input.format' })
    return true
  }
}

export const toggleUnorderedList = toggleList('ul')
export const toggleOrderedList = toggleList('ol')
export const toggleTaskList = toggleList('task')

export const insertLink: Command = (view) => {
  const spec = view.state.changeByRange((range) => {
    const text = view.state.doc.sliceString(range.from, range.to)
    if (range.empty) {
      return {
        changes: { from: range.from, insert: '[链接文字](url)' },
        // 选中「链接文字」便于直接输入
        range: EditorSelection.range(range.from + 1, range.from + 5),
      }
    }
    const insert = `[${text}](url)`
    return {
      changes: { from: range.from, to: range.to, insert },
      // 选中 url 便于粘贴地址
      range: EditorSelection.range(range.from + text.length + 3, range.from + text.length + 6),
    }
  })
  view.dispatch(spec, { userEvent: 'input.format' })
  return true
}

/** 在光标处插入块级模板；若当前行非空，先另起一行 */
function insertBlock(template: string, cursorOffset: number): Command {
  return (view) => {
    const { state } = view
    const range = state.selection.main
    const line = state.doc.lineAt(range.from)
    const needsNewline = line.text.trim() !== ''
    const prefix = needsNewline ? '\n' : ''
    const insert = prefix + template
    view.dispatch({
      changes: { from: line.to, insert },
      selection: EditorSelection.cursor(line.to + prefix.length + cursorOffset),
      userEvent: 'input.format',
    })
    return true
  }
}

export const insertCodeBlock = insertBlock('```\n\n```', 3)
export const insertMathBlock = insertBlock('$$\n\n$$', 3)
export const insertTable = insertBlock(
  '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |',
  2,
)

export const bmdKeymap: KeyBinding[] = [
  { key: 'Mod-b', run: toggleBold },
  { key: 'Mod-i', run: toggleItalic },
  { key: 'Mod-Shift-x', run: toggleStrikethrough },
  { key: 'Mod-e', run: toggleInlineCode },
  { key: 'Mod-k', run: insertLink },
  // 标题主绑定 Mod+1–6（v1.0.3 起；标签直达让位给 Alt+数字，见 src/lib/shortcuts.ts）
  { key: 'Mod-1', run: setHeading(1) },
  { key: 'Mod-2', run: setHeading(2) },
  { key: 'Mod-3', run: setHeading(3) },
  { key: 'Mod-4', run: setHeading(4) },
  { key: 'Mod-5', run: setHeading(5) },
  { key: 'Mod-6', run: setHeading(6) },
  // Mod+Alt+数字保留为兼容别名（0 = 回正文）
  { key: 'Mod-Alt-0', run: setHeading(0) },
  { key: 'Mod-Alt-1', run: setHeading(1) },
  { key: 'Mod-Alt-2', run: setHeading(2) },
  { key: 'Mod-Alt-3', run: setHeading(3) },
  { key: 'Mod-Alt-4', run: setHeading(4) },
  { key: 'Mod-Alt-5', run: setHeading(5) },
  { key: 'Mod-Alt-6', run: setHeading(6) },
  // 列表：无序 Mod+L；有序/任务用 Mod+Alt 保住字母（Mod+O/Mod+X 已被打开文件/剪切占用）
  { key: 'Mod-l', run: toggleUnorderedList },
  { key: 'Mod-Alt-o', run: toggleOrderedList },
  { key: 'Mod-Alt-x', run: toggleTaskList },
  { key: 'Mod-Shift-k', run: insertCodeBlock },
  { key: 'Mod-Shift-q', run: toggleQuote },
  { key: 'Mod-Shift-m', run: insertMathBlock },
  { key: 'Mod-Shift-t', run: insertTable },
]
