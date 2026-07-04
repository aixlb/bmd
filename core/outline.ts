import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'

export interface OutlineItem {
  level: number
  text: string
  pos: number
}

const ATX_RE = /^ATXHeading([1-6])$/
const SETEXT_RE = /^SetextHeading([12])$/

export function getOutline(state: EditorState): OutlineItem[] {
  const items: OutlineItem[] = []
  syntaxTree(state).iterate({
    enter(node) {
      const atx = ATX_RE.exec(node.name)
      const setext = atx ? null : SETEXT_RE.exec(node.name)
      if (!atx && !setext) return
      const line = state.doc.lineAt(node.from)
      const text = line.text.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim()
      if (text) {
        items.push({ level: Number((atx ?? setext)![1]), text, pos: node.from })
      }
      return false
    },
  })
  return items
}
