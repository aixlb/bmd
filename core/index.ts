import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView, type ViewUpdate, drawSelection, keymap } from '@codemirror/view'

import { bmdKeymap } from './commands'
import { bmdConfig } from './config'
import { bmdSyntaxHighlighting } from './highlight'
import { selectionToolbar } from './input/selectionToolbar'
import { slashMenu } from './input/slash'
import { mathExtension } from './parser/math'
import { blockPreviewField } from './preview/blockField'
import { headingDecorations } from './preview/headingField'
import { inlinePreviewPlugin, linkClickHandler } from './preview/livePreview'
import { bmdBaseTheme } from './theme'

export { bmdKeymap } from './commands'
export * from './commands'
export { getOutline, type OutlineItem } from './outline'
export { preheatRenderers } from './render/lazy'

// 查找替换面板中文化
const zhPhrases = EditorState.phrases.of({
  Find: '查找',
  Replace: '替换',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  'match case': '区分大小写',
  'by word': '整词',
  regexp: '正则',
  replace: '替换',
  'replace all': '全部替换',
  close: '关闭',
  'current match': '当前匹配',
  'replaced $ matches': '已替换 $ 处',
  'replaced match on line $': '已替换第 $ 行的匹配',
  'on line': '于行',
})

export interface BmdCoreConfig {
  /** 文档内容变更（用户编辑）时回调 */
  onDocChanged?: (doc: EditorState) => void
  /** 任意视图更新（含选区移动），供状态栏等使用 */
  onViewUpdate?: (update: ViewUpdate) => void
  /** ⌘/Ctrl+点击链接 */
  onOpenLink?: (url: string) => void
  /** 图片地址解析（相对路径 → 可渲染 URL） */
  resolveImageSrc?: (src: string) => string
  /** 粘贴/拖入图片：落盘后返回可写入 markdown 的相对路径，返回 null 表示放弃 */
  onPasteImage?: (file: File) => Promise<string | null>
}

/** 粘贴/拖拽图片 → 落盘 → 插入相对路径引用（FR-25/26） */
function imagePasteHandler(onPasteImage: (file: File) => Promise<string | null>) {
  const insertImage = (view: EditorView, file: File, pos: number) => {
    void onPasteImage(file).then((rel) => {
      if (!rel) return
      view.dispatch({
        changes: { from: pos, insert: `![${file.name.replace(/\.\w+$/, '')}](${rel})` },
        userEvent: 'input.paste-image',
      })
    })
  }
  return EditorView.domEventHandlers({
    paste(event, view) {
      const item = [...(event.clipboardData?.items ?? [])].find((i) =>
        i.type.startsWith('image/'),
      )
      const file = item?.getAsFile()
      if (!file) return false
      event.preventDefault()
      insertImage(view, file, view.state.selection.main.from)
      return true
    },
    drop(event, view) {
      const files = [...(event.dataTransfer?.files ?? [])].filter((f) =>
        f.type.startsWith('image/'),
      )
      if (!files.length) return false
      event.preventDefault()
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? 0
      for (const f of files) insertImage(view, f, pos)
      return true
    },
  })
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
    slashMenu,
    search({ top: true }),
    zhPhrases,
    highlightSelectionMatches(),
    keymap.of([
      ...closeBracketsKeymap,
      ...bmdKeymap,
      ...searchKeymap,
      ...markdownKeymap, // Enter 续列表 / Backspace 删标记
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [mathExtension],
    }),
    EditorView.lineWrapping,
    bmdBaseTheme,
    bmdSyntaxHighlighting,
    bmdConfig.of({ resolveImageSrc: config.resolveImageSrc }),
    previewCompartment.of(previewExtensions()),
    selectionToolbar,
    linkClickHandler(config.onOpenLink ?? (() => {})),
    config.onPasteImage ? imagePasteHandler(config.onPasteImage) : [],
    EditorView.updateListener.of((update) => {
      if (update.docChanged) config.onDocChanged?.(update.state)
      config.onViewUpdate?.(update)
    }),
  ]
}

/** 强制重建预览层（主题切换后让 Mermaid 等按新主题重渲染） */
export function refreshPreview(view: EditorView) {
  if (isSourceMode(view.state)) return
  view.dispatch({ effects: previewCompartment.reconfigure(previewExtensions()) })
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
