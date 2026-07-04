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

  // --- 引用 ---
  '.bmd-quote-line': {
    borderLeft: '3px solid color-mix(in srgb, var(--bmd-accent-a) 55%, transparent)',
    background: 'color-mix(in srgb, var(--bmd-accent-a) 4%, transparent)',
    paddingLeft: '12px',
    color: 'var(--bmd-text-dim)',
  },

  // --- 列表 ---
  '.bmd-bullet': {
    display: 'inline-block',
    width: '1em',
    textAlign: 'center',
    color: 'var(--bmd-accent)',
    fontWeight: '700',
  },
  '.bmd-list-num': { color: 'var(--bmd-accent)', fontWeight: '600' },
  '.bmd-checkbox': {
    appearance: 'none',
    width: '15px',
    height: '15px',
    margin: '0 6px 0 0',
    verticalAlign: 'middle',
    border: '1.5px solid var(--bmd-text-faint)',
    borderRadius: '4px',
    cursor: 'pointer',
    position: 'relative',
    top: '-1px',
  },
  '.bmd-checkbox:checked': {
    background: 'var(--bmd-accent-gradient)',
    borderColor: 'transparent',
  },
  '.bmd-checkbox:checked::after': {
    content: '"✓"',
    position: 'absolute',
    inset: '0',
    display: 'grid',
    placeItems: 'center',
    fontSize: '10px',
    color: '#fff',
  },

  // --- 代码块 ---
  '.bmd-code-line': {
    fontFamily: 'var(--bmd-font-mono)',
    fontSize: '0.88em',
    lineHeight: '1.6',
    background: 'var(--bmd-code-bg)',
    paddingLeft: '14px',
    paddingRight: '14px',
  },
  '.bmd-fence-line': {
    color: 'var(--bmd-text-faint)',
    fontSize: '0.8em',
  },
  '.bmd-code-info': {
    color: 'var(--bmd-accent)',
    fontWeight: '600',
  },
  '.bmd-copy-btn': {
    float: 'right',
    margin: '2px 0',
    padding: '1px 8px',
    font: 'inherit',
    fontSize: '0.75em',
    color: 'var(--bmd-text-faint)',
    background: 'transparent',
    border: '1px solid var(--bmd-border)',
    borderRadius: '5px',
    cursor: 'pointer',
  },
  '.bmd-copy-btn:hover': {
    color: 'var(--bmd-text)',
    borderColor: 'var(--bmd-text-faint)',
  },

  // --- 分割线 ---
  '.bmd-hr': {
    display: 'inline-block',
    width: '100%',
    height: '2px',
    verticalAlign: 'middle',
    background:
      'linear-gradient(90deg, transparent, var(--bmd-border-strong, var(--bmd-border)) 20%, var(--bmd-border-strong, var(--bmd-border)) 80%, transparent)',
    borderRadius: '1px',
  },

  // --- 图片 ---
  '.bmd-image': { display: 'inline-block', maxWidth: '100%' },
  '.bmd-image img': {
    maxWidth: '100%',
    borderRadius: '8px',
    display: 'block',
  },
  '.bmd-image.broken': {
    color: 'var(--bmd-danger)',
    fontSize: '0.85em',
    padding: '4px 8px',
    border: '1px dashed var(--bmd-danger)',
    borderRadius: '6px',
  },
})
