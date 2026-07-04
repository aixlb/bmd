import { EditorView } from '@codemirror/view'

// 内核自带的基础样式；颜色/字体全部走 --bmd-* CSS 变量（tokens.css 定义），
// 内核本身不感知亮暗主题。
// 注意：标题行用 padding 而非 margin 控制间距（CM6 行高测量约束）。
export const bmdBaseTheme = EditorView.baseTheme({
  '&': {
    fontSize: 'var(--bmd-font-size, 16px)',
    color: 'var(--bmd-text)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--bmd-font-prose)',
    lineHeight: '1.75',
  },
  '.cm-content': {
    caretColor: 'var(--bmd-accent)',
    padding: '2rem 0 40vh',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--bmd-accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
    {
      background: 'var(--bmd-selection)',
    },

  // --- 语法标记（reveal 态） ---
  '.bmd-syntax': { color: 'var(--bmd-text-faint)' },
  '.bmd-url': { color: 'var(--bmd-text-faint)', textDecoration: 'none' },

  // --- 行内元素 ---
  '.bmd-strong': { fontWeight: '700' },
  '.bmd-em': { fontStyle: 'italic' },
  '.bmd-strike': { textDecoration: 'line-through', color: 'var(--bmd-text-dim)' },
  '.bmd-code': {
    fontFamily: 'var(--bmd-font-mono)',
    fontSize: '0.9em',
    background: 'var(--bmd-code-bg)',
    border: '1px solid var(--bmd-border)',
    borderRadius: '4px',
    padding: '1px 5px',
  },
  '.bmd-link': {
    color: 'var(--bmd-link)',
    textDecoration: 'underline',
    textUnderlineOffset: '3px',
    textDecorationColor: 'var(--bmd-link-underline)',
    cursor: 'pointer',
  },

  // --- 标题 ---
  '.bmd-heading': { fontWeight: '700', lineHeight: '1.4' },
  '.bmd-h1': { fontSize: '1.9em', paddingTop: '0.9em', paddingBottom: '0.35em' },
  '.bmd-h2': { fontSize: '1.55em', paddingTop: '0.8em', paddingBottom: '0.3em' },
  '.bmd-h3': { fontSize: '1.3em', paddingTop: '0.7em', paddingBottom: '0.25em' },
  '.bmd-h4': { fontSize: '1.15em', paddingTop: '0.6em', paddingBottom: '0.2em' },
  '.bmd-h5': { fontSize: '1.05em', paddingTop: '0.5em', paddingBottom: '0.15em' },
  '.bmd-h6': {
    fontSize: '1em',
    color: 'var(--bmd-text-dim)',
    paddingTop: '0.5em',
    paddingBottom: '0.15em',
  },
})
