// 标签页 → 编辑器状态的非响应式登记处。
// EditorState 是重对象，放 Pinia 会被 reactive 包裹拖慢编辑器，故独立存放。
import type { EditorState } from '@codemirror/state'

const states = new Map<string, EditorState>()

export const editorRegistry = {
  get: (tabId: string) => states.get(tabId),
  set: (tabId: string, state: EditorState) => states.set(tabId, state),
  remove: (tabId: string) => states.delete(tabId),
  getDoc: (tabId: string) => states.get(tabId)?.doc.toString(),
  clear: () => states.clear(),
}
