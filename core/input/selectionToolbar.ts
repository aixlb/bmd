import { StateField } from '@codemirror/state'
import { EditorView, showTooltip, type Tooltip } from '@codemirror/view'
import {
  insertLink,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrikethrough,
} from '../commands'

// 选中文本浮动工具条（FR-14）

const BUTTONS: { label: string; title: string; cmd: (v: EditorView) => boolean }[] = [
  { label: 'B', title: '加粗 ⌘B', cmd: toggleBold },
  { label: 'I', title: '斜体 ⌘I', cmd: toggleItalic },
  { label: 'S', title: '删除线 ⌘⇧X', cmd: toggleStrikethrough },
  { label: '‹›', title: '行内代码 ⌘E', cmd: toggleInlineCode },
  { label: '🔗', title: '链接 ⌘K', cmd: insertLink },
]

function makeTooltip(pos: number): Tooltip {
  return {
    pos,
    above: true,
    strictSide: false,
    arrow: false,
    create(view) {
      const dom = document.createElement('div')
      dom.className = 'bmd-sel-toolbar'
      for (const b of BUTTONS) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = b.label
        btn.title = b.title
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          b.cmd(view)
        })
        dom.appendChild(btn)
      }
      return { dom }
    },
  }
}

export const selectionToolbar = StateField.define<readonly Tooltip[]>({
  create(state) {
    const r = state.selection.main
    return r.empty ? [] : [makeTooltip(r.from)]
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection) return value
    const r = tr.state.selection.main
    return r.empty ? [] : [makeTooltip(r.from)]
  },
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
})
