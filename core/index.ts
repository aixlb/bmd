import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'

import { headingDecorations } from './preview/headingField'
import { inlinePreviewPlugin, linkClickHandler } from './preview/livePreview'
import { bmdBaseTheme } from './theme'

export interface BmdEditorConfig {
  parent: HTMLElement
  doc?: string
  onDocChanged?: (doc: string) => void
  onOpenLink?: (url: string) => void
}

export interface BmdEditor {
  view: EditorView
  getMarkdown: () => string
  setMarkdown: (doc: string) => void
  focus: () => void
  destroy: () => void
}

/** 创建一个 bmd 编辑器实例（纯 TS，无框架依赖）。 */
export function createBmdEditor(config: BmdEditorConfig): BmdEditor {
  const view = new EditorView({
    parent: config.parent,
    state: EditorState.create({
      doc: config.doc ?? '',
      extensions: [
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
          if (update.docChanged) config.onDocChanged?.(update.state.doc.toString())
        }),
      ],
    }),
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
