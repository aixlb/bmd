import { EditorView, WidgetType } from '@codemirror/view'
import { currentTheme, renderKatex, renderMermaid } from '../render/lazy'

/** 点击块级 widget → 光标进入其源码（触发 reveal） */
function revealOnClick(el: HTMLElement, getPos: () => number | null, view: EditorView) {
  el.addEventListener('mousedown', (e) => {
    const pos = getPos()
    if (pos === null) return
    e.preventDefault()
    view.dispatch({ selection: { anchor: pos } })
    view.focus()
  })
}

export class KatexWidget extends WidgetType {
  constructor(
    readonly expr: string,
    readonly display: boolean,
  ) {
    super()
  }
  eq(other: KatexWidget) {
    return other.expr === this.expr && other.display === this.display
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'bmd-math-block' : 'bmd-math-inline'
    el.textContent = this.display ? '公式渲染中…' : '…'
    void renderKatex(this.expr, this.display).then((html) => {
      el.innerHTML = html
    })
    if (this.display) {
      revealOnClick(el, () => view.posAtDOM(el), view)
    }
    return el
  }
  ignoreEvent() {
    return false
  }
}

export class MermaidWidget extends WidgetType {
  readonly theme = currentTheme()
  constructor(readonly code: string) {
    super()
  }
  eq(other: MermaidWidget) {
    return other.code === this.code && other.theme === this.theme
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'bmd-mermaid'
    el.textContent = '图表渲染中…'
    void renderMermaid(this.code).then(({ ok, content }) => {
      if (ok) {
        el.innerHTML = content
      } else {
        el.classList.add('bmd-render-error-card')
        el.textContent = `Mermaid 渲染失败：${content.split('\n')[0]}`
      }
    })
    revealOnClick(el, () => view.posAtDOM(el), view)
    return el
  }
  ignoreEvent() {
    return false
  }
}

export interface TableModel {
  header: string[]
  aligns: ('left' | 'center' | 'right')[]
  rows: string[][]
}

/** 从 markdown 表格源码解析（GFM 管道表） */
export function parseTable(src: string): TableModel | null {
  const lines = src.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 2) return null
  const splitRow = (l: string) =>
    l
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'))
  const header = splitRow(lines[0])
  const delim = splitRow(lines[1])
  if (!delim.every((d) => /^:?-+:?$/.test(d))) return null
  const aligns = delim.map((d) =>
    d.startsWith(':') && d.endsWith(':')
      ? ('center' as const)
      : d.endsWith(':')
        ? ('right' as const)
        : ('left' as const),
  )
  const rows = lines.slice(2).map(splitRow)
  return { header, aligns, rows }
}

export class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super()
  }
  eq(other: TableWidget) {
    return other.src === this.src
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'bmd-table-wrap'
    const model = parseTable(this.src)
    if (!model) {
      wrap.textContent = this.src
      return wrap
    }
    const table = document.createElement('table')
    table.className = 'bmd-table'
    const thead = table.createTHead()
    const hr = thead.insertRow()
    model.header.forEach((h, i) => {
      const th = document.createElement('th')
      th.textContent = h
      th.style.textAlign = model.aligns[i] ?? 'left'
      hr.appendChild(th)
    })
    const tbody = table.createTBody()
    for (const row of model.rows) {
      const tr = tbody.insertRow()
      model.header.forEach((_, i) => {
        const td = tr.insertCell()
        td.textContent = row[i] ?? ''
        td.style.textAlign = model.aligns[i] ?? 'left'
      })
    }
    wrap.appendChild(table)
    revealOnClick(wrap, () => view.posAtDOM(wrap), view)
    return wrap
  }
  ignoreEvent() {
    return false
  }
}
