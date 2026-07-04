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

/** TableModel → GFM 管道表源码（单元格内 | 转义） */
export function serializeTable(model: TableModel): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const row = (cells: string[]) => `| ${cells.map(esc).join(' | ')} |`
  const delim = model.aligns
    .map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : '---'))
    .join(' | ')
  return [row(model.header), `| ${delim} |`, ...model.rows.map(row)].join('\n')
}

/** 表格就地编辑 widget（FR-11b，M4）：contentEditable 单元格 + Tab 跳格 + 增删行列 */
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

    const readModel = (): TableModel => {
      const rows = [...table.querySelectorAll('tr')].map((tr) =>
        [...tr.children].map((c) => (c as HTMLElement).innerText.trim()),
      )
      return { header: rows[0] ?? [], aligns: model.aligns.slice(0, rows[0]?.length), rows: rows.slice(1) }
    }

    /** 把当前 DOM 状态序列化回文档（单事务，可一次撤销） */
    const commit = (m?: TableModel) => {
      const pos = view.posAtDOM(wrap)
      if (pos < 0) return
      const next = serializeTable(m ?? readModel())
      if (next === view.state.doc.sliceString(pos, pos + this.src.length)) return
      view.dispatch({
        changes: { from: pos, to: pos + this.src.length, insert: next },
        userEvent: 'input.table-edit',
      })
    }

    const cellAt = (n: number) =>
      [...table.querySelectorAll('th,td')][n] as HTMLElement | undefined

    const makeCell = (tag: 'th' | 'td', text: string, align: string) => {
      const el = document.createElement(tag)
      el.textContent = text
      el.style.textAlign = align
      el.contentEditable = 'plaintext-only'
      el.spellcheck = false
      return el
    }

    const table = document.createElement('table')
    table.className = 'bmd-table'
    const thead = table.createTHead()
    const headRow = thead.insertRow()
    model.header.forEach((h, i) =>
      headRow.appendChild(makeCell('th', h, model.aligns[i] ?? 'left')),
    )
    const tbody = table.createTBody()
    for (const row of model.rows) {
      const tr = tbody.insertRow()
      model.header.forEach((_, i) =>
        tr.appendChild(makeCell('td', row[i] ?? '', model.aligns[i] ?? 'left')),
      )
    }

    // 键盘导航：Tab/Shift+Tab 跳格（末格 Tab 建新行）；Enter 提交
    table.addEventListener('keydown', (e) => {
      const cells = [...table.querySelectorAll('th,td')]
      const idx = cells.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'Tab') {
        e.preventDefault()
        const next = idx + (e.shiftKey ? -1 : 1)
        if (next >= cells.length) {
          const m = readModel()
          m.rows.push(model.header.map(() => ''))
          pendingFocus = { from: view.posAtDOM(wrap), cell: idx + 1 }
          commit(m)
        } else if (next >= 0) {
          ;(cells[next] as HTMLElement).focus()
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        commit()
        view.focus()
      }
    })
    table.addEventListener('focusout', (e) => {
      if (!table.contains(e.relatedTarget as Node)) commit()
    })

    // 悬浮操作条：增删行列 / 查看源码
    const bar = document.createElement('div')
    bar.className = 'bmd-table-bar'
    const ops: [string, string, () => void][] = [
      ['+行', '在末尾添加一行', () => {
        const m = readModel()
        m.rows.push(m.header.map(() => ''))
        commit(m)
      }],
      ['-行', '删除最后一行', () => {
        const m = readModel()
        if (m.rows.length > 1) m.rows.pop()
        commit(m)
      }],
      ['+列', '在末尾添加一列', () => {
        const m = readModel()
        m.header.push('')
        m.aligns.push('left')
        m.rows.forEach((r) => r.push(''))
        commit(m)
      }],
      ['-列', '删除最后一列', () => {
        const m = readModel()
        if (m.header.length > 1) {
          m.header.pop()
          m.aligns.pop()
          m.rows.forEach((r) => r.pop())
        }
        commit(m)
      }],
      ['源码', '编辑 markdown 源码', () => {
        const pos = view.posAtDOM(wrap)
        if (pos >= 0) {
          view.dispatch({ selection: { anchor: pos } })
          view.focus()
        }
      }],
    ]
    for (const [label, title, fn] of ops) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        fn()
      })
      bar.appendChild(b)
    }

    wrap.append(bar, table)

    // 提交重建后恢复焦点到目标单元格
    if (pendingFocus !== null) {
      const want = pendingFocus
      pendingFocus = null
      requestAnimationFrame(() => {
        const pos = view.posAtDOM(wrap)
        if (pos === want.from || want.from < 0) cellAt(want.cell)?.focus()
      })
    }
    return wrap
  }

  ignoreEvent() {
    return true
  }
}

let pendingFocus: { from: number; cell: number } | null = null
