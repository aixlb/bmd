// 第三方插件 API（v1）：manifest 校验、热键匹配、CommonJS 式模块装载、Notice 通知。
// 设计参考 Obsidian：插件目录 = {appData}/plugins/<id>/{manifest.json, main.js}，
// main.js 以 module.exports = { onload(app), onunload() } 导出生命周期。
// ⚠ 本文件是插件接口契约的一部分：修改对外行为时必须同步 PLUGINS.md（含「API 变更记录」）
//   与 examples/plugins/hello-world，见 CLAUDE.md「插件 API 文档同步」。

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 要求的最低 bmd 版本；不满足时拒绝加载 */
  minAppVersion?: string
}

/** 插件向宿主注册的 ribbon（左侧活动栏）图标 */
export interface RibbonItem {
  pluginId: string
  /** 完整 <svg> 字符串（24×24 viewBox 优先） */
  icon: string
  title: string
  onClick: () => void
}

export interface StatusItemHandle {
  setText(text: string): void
  remove(): void
}

export interface StatusItem {
  id: number
  pluginId: string
  text: string
  title?: string
  onClick?: () => void
}

export interface PluginCommand {
  pluginId: string
  id: string
  name: string
  /** 形如 'mod+shift+h'；mod = macOS ⌘ / 其他平台 Ctrl */
  hotkey?: string
  callback: () => void
}

export interface SettingTab {
  pluginId: string
  /** 设置弹窗左侧导航显示名（默认取插件名） */
  title: string
  /** 由宿主提供容器元素，插件自行渲染 DOM */
  render: (container: HTMLElement) => void
}

export type PluginEvent = 'file-open' | 'theme-change'

/** 插件拿到的宿主 API（每个插件一份实例，便于禁用时统一回收） */
export interface BmdPluginApp {
  /** 宿主应用版本 */
  version: string
  manifest: PluginManifest
  addRibbonIcon(opts: { icon: string; title: string; onClick: () => void }): void
  addStatusBarItem(opts: { text: string; title?: string; onClick?: () => void }): StatusItemHandle
  addCommand(cmd: { id: string; name: string; hotkey?: string; callback: () => void }): void
  addSettingTab(tab: { title?: string; render: (container: HTMLElement) => void }): void
  notice(message: string, timeoutMs?: number): void
  /** 当前活动编辑器的最小操作面；无打开文档时为 null */
  getEditor(): PluginEditor | null
  getActiveFile(): { path: string | null; title: string } | null
  /** 订阅宿主事件；返回取消函数（插件卸载时自动取消） */
  on(event: PluginEvent, cb: (payload?: unknown) => void): () => void
  /** 插件私有数据持久化（localStorage，键 bmd.plugin.<id>） */
  loadData<T = unknown>(): T | null
  saveData(data: unknown): void
}

export interface PluginEditor {
  getValue(): string
  getSelection(): string
  replaceSelection(text: string): void
  insertAtCursor(text: string): void
}

export interface PluginModule {
  onload(app: BmdPluginApp): void | Promise<void>
  onunload?(): void
}

/** 校验 manifest.json；返回错误消息（null = 合法） */
export function validateManifest(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return 'manifest.json 不是对象'
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-_]*$/i.test(m.id))
    return 'id 缺失或含非法字符（仅字母数字-_）'
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name 缺失'
  if (typeof m.version !== 'string' || !m.version.trim()) return 'version 缺失'
  return null
}

/** 语义化版本比较：a<b → -1，a==b → 0，a>b → 1（非数字段按 0 处理） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** 解析 'mod+shift+h' 式热键并与键盘事件比对 */
export function matchHotkey(hotkey: string, e: KeyboardEvent, isMac: boolean): boolean {
  const parts = hotkey.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  const key = parts.pop()
  if (!key) return false
  const want = { ctrl: false, meta: false, shift: false, alt: false }
  for (const p of parts) {
    if (p === 'mod') (isMac ? (want.meta = true) : (want.ctrl = true))
    else if (p === 'ctrl') want.ctrl = true
    else if (p === 'meta' || p === 'cmd') want.meta = true
    else if (p === 'shift') want.shift = true
    else if (p === 'alt' || p === 'option') want.alt = true
    else return false
  }
  return (
    e.key.toLowerCase() === key &&
    e.ctrlKey === want.ctrl &&
    e.metaKey === want.meta &&
    e.shiftKey === want.shift &&
    e.altKey === want.alt
  )
}

/**
 * 以 CommonJS 约定执行插件源码，返回其导出的生命周期对象。
 *
 * v1.0.1 起装载机制改为 Blob ESM 动态导入，应用 CSP 因此不再需要
 * `'unsafe-eval'`（script-src 收紧为 'self' blob:）。插件源码格式不变。
 * 无 Blob 模块能力的环境（Node 单测）回退 new Function。
 */
export async function loadPluginModule(code: string): Promise<PluginModule> {
  const exp = await loadExports(code)
  const mod = (typeof exp.default === 'object' && exp.default ? exp.default : exp) as PluginModule
  if (typeof mod.onload !== 'function') throw new Error('main.js 必须导出 onload(app) 方法')
  return mod
}

async function loadExports(code: string): Promise<Record<string, unknown>> {
  // 首选：包一层 CommonJS 垫片后经 Blob URL 作为 ES 模块导入（无需 eval 权限）
  if (typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const wrapped = `const module = { exports: {} }; const exports = module.exports;\n${code}\n;export default module.exports;`
    const url = URL.createObjectURL(new Blob([wrapped], { type: 'text/javascript' }))
    try {
      const ns = (await import(/* @vite-ignore */ url)) as { default: Record<string, unknown> }
      return ns.default
    } catch (e) {
      // 源码语法错误也会走到这里：交回退路径统一报错（生产 CSP 下回退同样失败，错误如实上抛）
      console.warn('[bmd] Blob 模块装载失败，尝试回退', e)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  // 回退：插件在应用同一上下文运行；启用与否由用户在设置里逐个控制
  const module = { exports: {} as Record<string, unknown> }
  const fn = new Function('module', 'exports', code)
  fn(module, module.exports)
  return module.exports
}

// ---- Notice 通知（右上角轻提示，纯 DOM，无 Vue 依赖） ----

let noticeHost: HTMLElement | null = null

export function showNotice(message: string, timeoutMs = 3000) {
  if (typeof document === 'undefined') return
  if (!noticeHost || !noticeHost.isConnected) {
    noticeHost = document.createElement('div')
    noticeHost.style.cssText =
      'position:fixed;top:52px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;'
    document.body.appendChild(noticeHost)
  }
  const el = document.createElement('div')
  el.textContent = message
  el.style.cssText =
    'pointer-events:auto;max-width:320px;padding:9px 14px;font-size:12.5px;line-height:1.5;' +
    'color:var(--bmd-text);background:var(--bmd-panel);border:1px solid var(--bmd-border);' +
    'border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.25);opacity:0;transform:translateY(-4px);' +
    'transition:opacity .18s,transform .18s;'
  noticeHost.appendChild(el)
  requestAnimationFrame(() => {
    el.style.opacity = '1'
    el.style.transform = 'none'
  })
  const dismiss = () => {
    el.style.opacity = '0'
    el.style.transform = 'translateY(-4px)'
    setTimeout(() => el.remove(), 200)
  }
  el.addEventListener('click', dismiss)
  if (timeoutMs > 0) setTimeout(dismiss, timeoutMs)
}
