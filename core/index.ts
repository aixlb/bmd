import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, type ViewUpdate, drawSelection, keymap } from '@codemirror/view'

import { headingDecorations } from './preview/headingField'
import { inlinePreviewPlugin, linkClickHandler } from './preview/livePreview'
import { bmdBaseTheme } from './theme'

export interface BmdCoreConfig {
  /** 文档内容变更（用户编辑）时回调 */
  onDocChanged?: (doc: EditorState) => void
  /** 任意视图更新（含选区移动），供状态栏等使用 */
  onViewUpdate?: (update: ViewUpdate) => void
  /** ⌘/Ctrl+点击链接 */
  onOpenLink?: (url: string) => void
}

/** bmd 内核扩展集：一个标签页 = 一个携带这套扩展的 EditorState */
export function bmdExtensions(config: BmdCoreConfig = {}): Extension {
  return [
    history(),
    drawSelection(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    bmdBaseTheme,
    headingDecorations,
    inlinePreviewPlugin,
    linkClickHandler(config.onOpenLink ?? (() => {})),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) config.onDocChanged?.(update.state)
      config.onViewUpdate?.(update)
    }),
  ]
}

export function createBmdState(doc: string, config: BmdCoreConfig = {}): EditorState {
  return EditorState.create({ doc, extensions: bmdExtensions(config) })
}

export interface BmdEditor {
  view: EditorView
  getMarkdown: () => string
  setMarkdown: (doc: string) => void
  focus: () => void
  destroy: () => void
}

/** 单实例便捷封装（demo/测试用；应用层多标签请用 createBmdState + 共享 EditorView） */
export function createBmdEditor(
  config: BmdCoreConfig & { parent: HTMLElement; doc?: string },
): BmdEditor {
  const view = new EditorView({
    parent: config.parent,
    state: createBmdState(config.doc ?? '', config),
  })
  return {
    view,
    getMarkdown: () => view.state.doc.toString(),
    setMarkdown: (doc: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  }
}
