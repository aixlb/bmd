import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, type ViewUpdate, drawSelection, keymap } from '@codemirror/view'

import { bmdKeymap } from './commands'
import { bmdConfig } from './config'
import { bmdSyntaxHighlighting } from './highlight'
import { blockPreviewField } from './preview/blockField'
import { headingDecorations } from './preview/headingField'
import { inlinePreviewPlugin, linkClickHandler } from './preview/livePreview'
import { bmdBaseTheme } from './theme'

export { bmdKeymap } from './commands'
export * from './commands'
export { getOutline, type OutlineItem } from './outline'

export interface BmdCoreConfig {
  /** 文档内容变更（用户编辑）时回调 */
  onDocChanged?: (doc: EditorState) => void
  /** 任意视图更新（含选区移动），供状态栏等使用 */
  onViewUpdate?: (update: ViewUpdate) => void
  /** ⌘/Ctrl+点击链接 */
  onOpenLink?: (url: string) => void
  /** 图片地址解析（相对路径 → 可渲染 URL） */
  resolveImageSrc?: (src: string) => string
}

// 即时渲染 ⇄ 源码模式：同一 Compartment 实例可复用于所有 EditorState
const previewCompartment = new Compartment()

function previewExtensions(): Extension {
  return [headingDecorations, inlinePreviewPlugin, blockPreviewField]
}

/** bmd 内核扩展集：一个标签页 = 一个携带这套扩展的 EditorState */
export function bmdExtensions(config: BmdCoreConfig = {}): Extension {
  return [
    history(),
    drawSelection(),
    closeBrackets(),
    keymap.of([
      ...closeBracketsKeymap,
      ...bmdKeymap,
      ...markdownKeymap, // Enter 续列表 / Backspace 删标记
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    EditorView.lineWrapping,
    bmdBaseTheme,
    bmdSyntaxHighlighting,
    bmdConfig.of({ resolveImageSrc: config.resolveImageSrc }),
    previewCompartment.of(previewExtensions()),
    linkClickHandler(config.onOpenLink ?? (() => {})),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) config.onDocChanged?.(update.state)
      config.onViewUpdate?.(update)
    }),
  ]
}

export function isSourceMode(state: EditorState): boolean {
  const content = previewCompartment.get(state)
  return Array.isArray(content) && content.length === 0
}

/** ⌘/ 即时渲染与源码模式切换（FR-10b）：同一文档缓冲区、撤销栈与光标不变 */
export function toggleSourceMode(view: EditorView): boolean {
  const source = isSourceMode(view.state)
  view.dispatch({
    effects: previewCompartment.reconfigure(source ? previewExtensions() : []),
  })
  return !source
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
