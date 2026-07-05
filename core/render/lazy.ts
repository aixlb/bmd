// KaTeX / Mermaid 懒加载渲染器（DESIGN.md D4/D5/§7）：
// 绝不进入启动路径；渲染结果按内容+主题做 LRU 缓存。

function makeLru<V>(cap: number) {
  const map = new Map<string, V>()
  return {
    get(k: string): V | undefined {
      const v = map.get(k)
      if (v !== undefined) {
        map.delete(k)
        map.set(k, v)
      }
      return v
    },
    set(k: string, v: V) {
      if (map.size >= cap) map.delete(map.keys().next().value!)
      map.set(k, v)
    },
  }
}

const katexCache = makeLru<string>(500)
let katexModule: Promise<typeof import('katex').default> | null = null

function loadKatex() {
  katexModule ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(([m]) => (m as { default: typeof import('katex').default }).default)
  return katexModule
}

export async function renderKatex(expr: string, displayMode: boolean): Promise<string> {
  const key = `${displayMode ? 'D' : 'I'}:${expr}`
  const cached = katexCache.get(key)
  if (cached) return cached
  const katex = await loadKatex()
  let html: string
  try {
    html = katex.renderToString(expr, { displayMode, throwOnError: false, output: 'html' })
  } catch (e) {
    // 错误信息可能包含用户输入，转义后再进 innerHTML
    const esc = String(e).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    html = `<span class="bmd-render-error">公式错误：${esc}</span>`
  }
  katexCache.set(key, html)
  return html
}

const mermaidCache = makeLru<string>(100)
let mermaidModule: Promise<typeof import('mermaid').default> | null = null
let mermaidTheme: string | null = null
let renderSeq = 0

function loadMermaid() {
  mermaidModule ??= import('mermaid').then((m) => m.default)
  return mermaidModule
}

export function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export async function renderMermaid(code: string): Promise<{ ok: boolean; content: string }> {
  const theme = currentTheme()
  const key = `${theme}:${code}`
  const cached = mermaidCache.get(key)
  if (cached) return { ok: true, content: cached }
  const mermaid = await loadMermaid()
  if (mermaidTheme !== theme) {
    mermaidTheme = theme
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'neutral',
      fontFamily: 'var(--bmd-font-prose)',
    })
  }
  const renderId = ++renderSeq // 局部捕获，避免并发渲染时清理错节点
  try {
    const { svg } = await mermaid.render(`bmd-mermaid-${renderId}`, code)
    mermaidCache.set(key, svg)
    return { ok: true, content: svg }
  } catch (e) {
    // mermaid 渲染失败会在 DOM 残留错误占位，清理掉
    document.querySelector(`#dbmd-mermaid-${renderId}`)?.remove()
    return { ok: false, content: String(e) }
  }
}

/** 首帧后空闲预热（App 启动时调用一次） */
export function preheatRenderers() {
  const idle =
    'requestIdleCallback' in window
      ? window.requestIdleCallback.bind(window) // 不绑定 this 直接调用会抛 Illegal invocation
      : (fn: () => void) => setTimeout(fn, 1500)
  idle(() => {
    void loadKatex()
    void loadMermaid()
  })
}
