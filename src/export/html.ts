// 导出独立 HTML（FR-28，DESIGN.md §6）
// - 数学：KaTeX 以 MathML 输出——零字体依赖，文件完全自包含
// - Mermaid：预渲染为 SVG 内嵌
// - 代码高亮：与编辑器同源（Lezer highlightTree + classHighlighter）
// 全链路懒加载，不进启动路径。

import type MarkdownIt from 'markdown-it'
import { renderMermaid } from '@core/render/lazy'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function highlightCode(lang: string, code: string): Promise<string | null> {
  if (!lang) return null
  const [{ languages }, { LanguageDescription }, { highlightTree, classHighlighter }] =
    await Promise.all([
      import('@codemirror/language-data'),
      import('@codemirror/language'),
      import('@lezer/highlight'),
    ])
  const desc = LanguageDescription.matchLanguageName(languages, lang, true)
  if (!desc) return null
  try {
    const support = await desc.load()
    const tree = support.language.parser.parse(code)
    let html = ''
    let last = 0
    highlightTree(tree, classHighlighter, (from, to, cls) => {
      html += escapeHtml(code.slice(last, from))
      html += `<span class="${cls}">${escapeHtml(code.slice(from, to))}</span>`
      last = to
    })
    return html + escapeHtml(code.slice(last))
  } catch {
    return null
  }
}

type Katex = typeof import('katex').default

function mathPlugin(md: MarkdownIt, katex: Katex) {
  const render = (expr: string, display: boolean) =>
    katex.renderToString(expr, { displayMode: display, output: 'mathml', throwOnError: false })

  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const { src, pos } = state
    if (src[pos] !== '$' || src[pos + 1] === '$') return false
    let end = -1
    for (let i = pos + 1; i < state.posMax; i++) {
      if (src[i] === '\n') return false
      if (src[i] === '$' && src[i - 1] !== '\\') {
        end = i
        break
      }
    }
    if (end < 0 || end === pos + 1) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = src.slice(pos + 1, end)
    }
    state.pos = end + 1
    return true
  })

  md.block.ruler.after('fence', 'math_block', (state, start, endLine, silent) => {
    const first = state.getLines(start, start + 1, 0, false).trim()
    if (!first.startsWith('$$')) return false
    if (silent) return true
    let last = start
    if (!(first.length > 4 && first.endsWith('$$'))) {
      for (let l = start + 1; l < endLine; l++) {
        last = l
        if (state.getLines(l, l + 1, 0, false).trim().endsWith('$$')) break
      }
    }
    const content = state
      .getLines(start, last + 1, 0, false)
      .trim()
      .replace(/^\$\$/, '')
      .replace(/\$\$$/, '')
      .trim()
    const token = state.push('math_block', 'math', 0)
    token.content = content
    token.map = [start, last + 1]
    state.line = last + 1
    return true
  })

  md.renderer.rules.math_inline = (tokens, i) => render(tokens[i].content, false)
  md.renderer.rules.math_block = (tokens, i) =>
    `<div class="math-block">${render(tokens[i].content, true)}</div>`
}

function taskListPlugin(md: MarkdownIt) {
  md.core.ruler.after('inline', 'bmd-task', (state) => {
    const tokens = state.tokens
    for (let i = 2; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.type !== 'inline' || !t.children?.length) continue
      if (tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open')
        continue
      const first = t.children[0]
      const m = /^\[([ xX])\]\s+/.exec(first.content)
      if (!m) continue
      first.content = first.content.slice(m[0].length)
      const cb = new state.Token('html_inline', '', 0)
      cb.content = `<input type="checkbox" disabled${/x/i.test(m[1]) ? ' checked' : ''}> `
      t.children.unshift(cb)
      tokens[i - 2].attrJoin('class', 'task-item')
    }
    return true
  })
}

export interface ExportOptions {
  title: string
  theme: 'dark' | 'light'
}

export async function buildExportHtml(markdown: string, opts: ExportOptions): Promise<string> {
  const [{ default: MarkdownItCtor }, katexModule] = await Promise.all([
    import('markdown-it'),
    import('katex'),
  ])
  const katex = (katexModule as { default: Katex }).default

  // 第一遍 parse：收集代码块做异步高亮 / mermaid 预渲染
  const highlighted = new Map<string, string>()
  const mermaidSvg = new Map<string, string>()
  const md: MarkdownIt = new MarkdownItCtor({ html: false, linkify: true })
  md.use((m) => mathPlugin(m, katex))
  md.use(taskListPlugin)

  const tokens = md.parse(markdown, {})
  const jobs: Promise<void>[] = []
  for (const t of tokens) {
    if (t.type !== 'fence') continue
    const lang = t.info.trim().split(/\s+/)[0] ?? ''
    const code = t.content
    if (lang === 'mermaid') {
      jobs.push(
        renderMermaid(code.trimEnd()).then(({ ok, content }) => {
          if (ok) mermaidSvg.set(code, content)
        }),
      )
    } else {
      jobs.push(
        highlightCode(lang, code.trimEnd()).then((html) => {
          if (html) highlighted.set(`${lang}\0${code}`, html)
        }),
      )
    }
  }
  await Promise.all(jobs)

  const defaultFence = md.renderer.rules.fence!
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const t = tokens[idx]
    const lang = t.info.trim().split(/\s+/)[0] ?? ''
    if (lang === 'mermaid' && mermaidSvg.has(t.content)) {
      return `<figure class="mermaid">${mermaidSvg.get(t.content)}</figure>\n`
    }
    const hl = highlighted.get(`${lang}\0${t.content}`)
    if (hl !== undefined) {
      return `<pre class="code-block" data-lang="${escapeHtml(lang)}"><code>${hl}</code></pre>\n`
    }
    return defaultFence(tokens, idx, options, env, self)
  }

  const body = md.render(markdown)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${exportCss(opts.theme)}</style>
</head>
<body><article class="bmd-doc">
${body}
</article></body>
</html>`
}

function exportCss(theme: 'dark' | 'light'): string {
  const dark = theme === 'dark'
  const c = dark
    ? {
        bg: '#0e1016', text: '#e6e9ef', dim: '#9aa3b2', faint: '#5c667a',
        border: 'rgba(255,255,255,.09)', codeBg: '#12151d', link: '#8fa8ff', accent: '#6d8dff',
        kw: '#c678dd', str: '#98c379', com: '#7f848e', num: '#d19a66', fn: '#61afef',
        typ: '#e5c07b', prop: '#e06c75', op: '#abb2bf',
      }
    : {
        bg: '#ffffff', text: '#1c2333', dim: '#5a6377', faint: '#9aa3b2',
        border: 'rgba(28,35,51,.12)', codeBg: '#f1f3f6', link: '#4a6cf0', accent: '#4a6cf0',
        kw: '#a626a4', str: '#50a14f', com: '#a0a1a7', num: '#986801', fn: '#4078f2',
        typ: '#c18401', prop: '#e45649', op: '#383a42',
      }
  return `
:root { color-scheme: ${dark ? 'dark' : 'light'}; }
body { margin: 0; background: ${c.bg}; color: ${c.text};
  font: 16px/1.75 Inter, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
.bmd-doc { max-width: 760px; margin: 0 auto; padding: 48px 32px 96px; }
h1,h2,h3,h4,h5,h6 { line-height: 1.4; }
h1 { font-size: 1.9em; } h2 { font-size: 1.55em; } h3 { font-size: 1.3em; }
h6 { color: ${c.dim}; }
a { color: ${c.link}; text-underline-offset: 3px; }
blockquote { margin: 1em 0; padding: 2px 0 2px 12px; color: ${c.dim};
  border-left: 3px solid ${c.accent}88; background: ${c.accent}0a; }
code { font-family: "JetBrains Mono","SF Mono",Menlo,Consolas,monospace; font-size: .9em;
  background: ${c.codeBg}; border: 1px solid ${c.border}; border-radius: 4px; padding: 1px 5px; }
pre.code-block, pre { position: relative; background: ${c.codeBg}; border-radius: 10px;
  padding: 14px; overflow-x: auto; }
pre code { background: none; border: none; padding: 0; font-size: .88em; line-height: 1.6; }
pre.code-block::before { content: attr(data-lang); position: absolute; top: 8px; right: 12px;
  font-size: .75em; color: ${c.faint}; }
table { border-collapse: collapse; width: 100%; font-size: .95em; }
th, td { border: 1px solid ${c.border}; padding: 7px 12px; }
th { background: ${c.codeBg}; }
hr { border: none; height: 2px; border-radius: 1px;
  background: linear-gradient(90deg, transparent, ${c.border} 20%, ${c.border} 80%, transparent); }
img { max-width: 100%; border-radius: 8px; }
figure.mermaid { text-align: center; margin: 1.2em 0; }
figure.mermaid svg { max-width: 100%; }
.math-block { text-align: center; padding: 8px 0; overflow-x: auto; }
li.task-item { list-style: none; margin-left: -1.2em; }
li.task-item input { margin-right: 6px; }
.tok-keyword { color: ${c.kw}; } .tok-string,.tok-string2 { color: ${c.str}; }
.tok-comment { color: ${c.com}; font-style: italic; } .tok-number,.tok-bool { color: ${c.num}; }
.tok-function,.tok-variableName2 { color: ${c.fn}; } .tok-typeName,.tok-className { color: ${c.typ}; }
.tok-propertyName,.tok-attributeName { color: ${c.prop}; } .tok-operator,.tok-punctuation { color: ${c.op}; }
.tok-meta { color: ${c.faint}; }
@media print {
  body { background: #fff; color: #111; }
  .bmd-doc { max-width: none; padding: 0; }
  h1,h2,h3,h4,h5,h6 { break-after: avoid; }
  figure.mermaid, img, table, .math-block, blockquote { break-inside: avoid; }
  pre { white-space: pre-wrap; }
  a { color: inherit; }
}
`
}
