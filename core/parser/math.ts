import type { BlockContext, InlineContext, Line, MarkdownConfig } from '@lezer/markdown'
import { tags } from '@lezer/highlight'

// 数学语法的 Lezer 扩展（DESIGN.md §3.2）：
// 行内 $...$（不跨行、\$ 转义、$ 后紧跟 $ 交给块级）；块级 $$...$$。

const DOLLAR = 36
const BACKSLASH = 92
const NEWLINE = 10

function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR) return -1
  if (cx.char(pos + 1) === DOLLAR) return -1 // $$ 由块级处理
  if (pos > cx.offset && cx.char(pos - 1) === BACKSLASH) return -1

  let end = -1
  for (let i = pos + 1; i < cx.end; i++) {
    const ch = cx.char(i)
    if (ch === NEWLINE) break
    if (ch === DOLLAR && cx.char(i - 1) !== BACKSLASH) {
      end = i
      break
    }
  }
  if (end < 0 || end === pos + 1) return -1
  return cx.addElement(
    cx.elt('InlineMath', pos, end + 1, [
      cx.elt('MathMark', pos, pos + 1),
      cx.elt('MathMark', end, end + 1),
    ]),
  )
}

function parseBlockMath(cx: BlockContext, line: Line): boolean {
  if (!/^\$\$/.test(line.text.trim()) || !line.text.trimStart().startsWith('$$')) return false
  const from = cx.lineStart + line.text.indexOf('$$')
  const restOfFirst = line.text.trim().slice(2)

  // 单行形式：$$ e = mc^2 $$
  if (restOfFirst.endsWith('$$') && restOfFirst.length >= 2) {
    const to = cx.lineStart + line.text.length
    cx.addElement(cx.elt('BlockMath', from, to))
    cx.nextLine()
    return true
  }

  let to = cx.lineStart + line.text.length
  while (cx.nextLine()) {
    to = cx.lineStart + line.text.length
    if (/\$\$\s*$/.test(line.text)) {
      cx.nextLine()
      break
    }
  }
  cx.addElement(cx.elt('BlockMath', from, to))
  return true
}

export const mathExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: tags.special(tags.content) },
    { name: 'BlockMath', block: true, style: tags.special(tags.content) },
    { name: 'MathMark', style: tags.processingInstruction },
  ],
  parseInline: [{ name: 'InlineMath', parse: parseInlineMath, after: 'Escape' }],
  parseBlock: [{ name: 'BlockMath', parse: parseBlockMath, before: 'FencedCode' }],
}
