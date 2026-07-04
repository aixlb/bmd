import { EditorSelection } from '@codemirror/state'
import type { Command, KeyBinding } from '@codemirror/view'

// 格式命令：全部是纯文本操作（DESIGN.md §3.6）——包裹/去包裹定界符、改行前缀。

function toggleInline(marker: string): Command {
  const len = marker.length
  return (view) => {
    const spec = view.state.changeByRange((range) => {
      const { from, to } = range
      const doc = view.state.doc
      const text = doc.sliceString(from, to)
      const before = doc.sliceString(Math.max(0, from - len), from)
      const after = doc.sliceString(to, Math.min(doc.length, to + len))

      // 已被包裹（选区含定界符）→ 去掉
      if (text.length >= 2 * len && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: [
            { from, to: from + len, insert: '' },
            { from: to - len, to, insert: '' },
          ],
          range: EditorSelection.range(from, to - 2 * len),
        }
      }
      // 已被包裹（定界符在选区外侧）→ 去掉
      if (before === marker && after === marker) {
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
  { key: 'Mod-Alt-0', run: setHeading(0) },
  { key: 'Mod-Alt-1', run: setHeading(1) },
  { key: 'Mod-Alt-2', run: setHeading(2) },
  { key: 'Mod-Alt-3', run: setHeading(3) },
  { key: 'Mod-Alt-4', run: setHeading(4) },
  { key: 'Mod-Alt-5', run: setHeading(5) },
  { key: 'Mod-Alt-6', run: setHeading(6) },
  { key: 'Mod-Shift-k', run: insertCodeBlock },
  { key: 'Mod-Shift-q', run: toggleQuote },
  { key: 'Mod-Shift-m', run: insertMathBlock },
  { key: 'Mod-Shift-t', run: insertTable },
]
