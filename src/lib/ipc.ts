// IPC 抽象层：Tauri 环境走 invoke，浏览器/测试环境走内存 mock。
// 所有磁盘写入统一经此层（DESIGN.md §2 职责边界）。

export interface Entry {
  name: string
  path: string
  isDir: boolean
  isMd: boolean
}

export interface DocPayload {
  content: string
  mtimeMs: number
}

export interface Session {
  root: string | null
  openPaths: string[]
  active: number | null
}

export interface SearchHit {
  path: string
  name: string
  /** 首个匹配行（1-based；仅文件名匹配时为 0） */
  line: number
  preview: string
  count: number
}

export interface Ipc {
  scanDir(path: string): Promise<Entry[]>
  /** 工作区全文搜索：匹配文件名与 md 内容 */
  searchText(root: string, query: string, limit: number): Promise<SearchHit[]>
  readDoc(path: string): Promise<DocPayload>
  /** AI 工具路径约束：path 规范化后必须在 root 内，否则 reject（防 ../ 与符号链接逃逸） */
  canonInRoot(root: string, path: string): Promise<string>
  /** 返回新 mtime；期望 mtime 不匹配时 reject('conflict') */
  writeDocAtomic(path: string, content: string, expectedMtimeMs: number | null): Promise<number>
  createEntry(parent: string, name: string, isDir: boolean): Promise<string>
  renameEntry(path: string, newName: string): Promise<string>
  trashEntry(path: string): Promise<void>
  revealInOs(path: string): Promise<void>
  loadSession(): Promise<Session | null>
  saveSession(session: Session): Promise<void>
  pickFolder(): Promise<string | null>
  pickFile(): Promise<string | null>
  pickSavePath(
    defaultName: string,
    filter?: { name: string; extensions: string[] },
  ): Promise<string | null>
  confirm(message: string, title?: string): Promise<boolean>
  /** 原生静默导出 PDF（D8 V2）；非 Tauri 环境 reject，由调用方回退打印管线 */
  exportPdfNative(html: string, baseDir: string | null, outPath: string): Promise<void>
  savePastedImage(docPath: string, dataB64: string, ext: string): Promise<string>
  /** 注册 HTML 只读预览，返回 iframe 可加载的 URL；非 Tauri 环境返回 null（回退 srcdoc） */
  previewHtmlUrl(path: string): Promise<string | null>
  startWatch(root: string): Promise<void>
  stopWatch(): Promise<void>
  onFsChanged(cb: (paths: string[]) => void): Promise<() => void>
  initialFiles(): Promise<string[]>
  // ---- AI（DESIGN §13） ----
  setApiKey(providerId: string, key: string): Promise<void>
  hasApiKey(providerId: string): Promise<boolean>
  aiChat(req: AiChatRequest, onEvent: (e: AiEvent) => void): Promise<void>
  aiCancel(requestId: string): Promise<void>
  loadChats(workspace: string): Promise<string>
  saveChats(workspace: string, json: string): Promise<void>
  ragIndex(workspace: string, embed: EmbedConfig | null): Promise<RagIndexStats>
  ragSearch(
    workspace: string,
    query: string,
    embed: EmbedConfig | null,
    k: number,
  ): Promise<RagHit[]>
}

export interface EmbedConfig {
  providerId: string
  baseUrl: string
  model: string
}

export interface RagIndexStats {
  files: number
  chunks: number
  embedded: number
  skipped: number
}

export interface RagHit {
  path: string
  heading: string
  snippet: string
  score: number
}

export interface AiProvider {
  id: string
  name: string
  protocol: 'anthropic' | 'openai'
  baseUrl: string
  model: string
  preset?: boolean
}

/** 工具定义（parameters 为 JSON Schema） */
export interface AiToolDef {
  name: string
  description: string
  parameters: unknown
}

/** 模型发起的一次工具调用（arguments 为 JSON 字符串原文） */
export interface AiToolCall {
  id: string
  name: string
  arguments: string
}

/** 线上消息：user/assistant 文本，assistant 可带 toolCalls，role=tool 为工具结果 */
export interface ChatWireMsg {
  role: string
  content: string
  toolCalls?: AiToolCall[]
  toolCallId?: string
}

export interface AiChatRequest {
  requestId: string
  provider: AiProvider
  system: string | null
  messages: ChatWireMsg[]
  /** 只读工具集（Agent 循环）；不传 = 纯对话 */
  tools?: AiToolDef[] | null
}

export type AiEvent =
  | { type: 'delta'; text: string }
  | { type: 'toolCalls'; calls: AiToolCall[] }
  | { type: 'done' }
  | { type: 'error'; message: string }

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function tauriIpc(): Ipc {
  // 动态 import 避免浏览器环境加载 @tauri-apps 模块
  const inv = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  }
  return {
    scanDir: (path) => inv('scan_dir', { path }),
    searchText: (root, query, limit) => inv('search_text', { root, query, limit }),
    readDoc: (path) => inv('read_doc', { path }),
    writeDocAtomic: (path, content, expectedMtimeMs) =>
      inv('write_doc_atomic', { path, content, expectedMtimeMs }),
    createEntry: (parent, name, isDir) => inv('create_entry', { parent, name, isDir }),
    renameEntry: (path, newName) => inv('rename_entry', { path, newName }),
    trashEntry: (path) => inv('trash_entry', { path }),
    revealInOs: (path) => inv('reveal_in_os', { path }),
    loadSession: () => inv('load_session'),
    saveSession: (session) => inv('save_session', { session }),
    pickFolder: async () => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const r = await open({ directory: true, multiple: false })
      return typeof r === 'string' ? r : null
    },
    pickFile: async () => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const r = await open({
        multiple: false,
        filters: [
          { name: '支持的文件', extensions: ['md', 'markdown', 'html', 'htm'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'HTML', extensions: ['html', 'htm'] },
        ],
      })
      return typeof r === 'string' ? r : null
    },
    pickSavePath: async (defaultName, filter) => {
      const { save } = await import('@tauri-apps/plugin-dialog')
      return save({
        defaultPath: defaultName,
        filters: [filter ?? { name: 'Markdown', extensions: ['md'] }],
      })
    },
    confirm: async (message, title) => {
      const { ask } = await import('@tauri-apps/plugin-dialog')
      return ask(message, { title: title ?? 'bmd' })
    },
    exportPdfNative: (html, baseDir, outPath) => inv('export_pdf', { html, baseDir, outPath }),
    savePastedImage: (docPath, dataB64, ext) =>
      inv('save_pasted_image', { docPath, dataB64, ext }),
    previewHtmlUrl: (path) => inv('register_html_preview', { path }),
    startWatch: (root) => inv('start_watch', { path: root }),
    stopWatch: () => inv('stop_watch', {}),
    onFsChanged: async (cb) => {
      const { listen } = await import('@tauri-apps/api/event')
      return listen<string[]>('fs-changed', (e) => cb(e.payload))
    },
    initialFiles: () => inv('initial_files'),
    setApiKey: (providerId, key) => inv('set_api_key', { providerId, key }),
    hasApiKey: (providerId) => inv('has_api_key', { providerId }),
    aiChat: async (req, onEvent) => {
      const { invoke, Channel } = await import('@tauri-apps/api/core')
      const channel = new Channel<AiEvent>()
      channel.onmessage = onEvent
      await invoke('ai_chat', {
        requestId: req.requestId,
        provider: req.provider,
        system: req.system,
        messages: req.messages,
        tools: req.tools ?? null,
        onEvent: channel,
      })
    },
    canonInRoot: (root, path) => inv('canon_in_root', { root, path }),
    aiCancel: (requestId) => inv('ai_cancel', { requestId }),
    loadChats: (workspace) => inv('load_chats', { workspace }),
    saveChats: (workspace, json) => inv('save_chats', { workspace, json }),
    ragIndex: (workspace, embed) => inv('rag_index', { workspace, embed }),
    ragSearch: (workspace, query, embed, k) =>
      inv('rag_search', { workspace, query, embed, k }),
  }
}

/** 浏览器预览 / vitest 用的内存文件系统 */
export function createMockIpc(seed?: Record<string, string>): Ipc {
  const ROOT = '/demo'
  const files = new Map<string, { content: string; mtime: number }>()
  let clock = 1000
  const defaults: Record<string, string> = seed ?? {
    '/demo/README.md': `# bmd 全元素演示

## 行内元素

这是 **加粗**、*斜体*、~~删除线~~、\`行内代码\`、[链接](https://github.com/aixlb/bmd) 与自动链接 https://bmd.dev 。

## 引用与列表

> 引用第一行
> 引用第二行

- 无序列表项
- 另一项
  - 嵌套项

1. 有序第一
2. 有序第二

- [x] 已完成任务
- [ ] 待办任务

## 代码块

\`\`\`ts
function hello(name: string): string {
  // 注释
  return \`hi, \${name}\`
}
\`\`\`

---

## 数学公式

行内公式 $e = mc^2$ 与块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

## Mermaid 图表

\`\`\`mermaid
graph LR
  A[写作] --> B{满意?}
  B -->|是| C[发布]
  B -->|否| A
\`\`\`

## 表格

| 里程碑 | 内容 | 状态 |
| :-- | :-: | --: |
| M2 | 内核完备 | ✅ |
| M3 | 高级渲染 | 🚧 |

## 图片

![示例图](https://picsum.photos/480/200)

正文结束。
`,
    '/demo/笔记/想法.md': '## 想法\n\n- **bmd** 要够快\n- 手感要即时渲染\n',
    '/demo/笔记/清单.md': '# 清单\n\n1. 完成 M1\n2. 完成 M2\n',
    '/demo/参考.txt': 'not markdown',
    '/demo/预览示例.html': `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>HTML 预览</title>
<style>body{font:15px/1.8 -apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 24px}</style>
</head><body><h1>HTML 只读预览</h1><p>这是 <strong>bmd</strong> 的 HTML 预览示例：只渲染，不可编辑。</p></body></html>`,
  }
  for (const [k, v] of Object.entries(defaults)) files.set(k, { content: v, mtime: ++clock })
  let session: Session | null = null

  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'))

  return {
    async scanDir(path) {
      const dirs = new Set<string>()
      const out: Entry[] = []
      for (const p of files.keys()) {
        if (!p.startsWith(path + '/')) continue
        const rest = p.slice(path.length + 1)
        const slash = rest.indexOf('/')
        if (slash === -1) {
          out.push({ name: rest, path: p, isDir: false, isMd: /\.(md|markdown)$/i.test(rest) })
        } else {
          dirs.add(rest.slice(0, slash))
        }
      }
      const dirEntries: Entry[] = [...dirs].map((d) => ({
        name: d,
        path: `${path}/${d}`,
        isDir: true,
        isMd: false,
      }))
      const byName = (a: Entry, b: Entry) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      return [...dirEntries.sort(byName), ...out.sort(byName)]
    },
    async searchText(root, query, limit) {
      const q = query.trim().toLowerCase()
      if (!q) return []
      const out: SearchHit[] = []
      for (const [p, f] of files) {
        if (!p.startsWith(root + '/')) continue
        if (!/\.(md|markdown)$/i.test(p)) continue
        const name = p.split('/').pop() ?? p
        let count = 0
        let line = 0
        let preview = ''
        const lines = f.content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const ll = lines[i].toLowerCase()
          let start = 0
          let idx
          while ((idx = ll.indexOf(q, start)) !== -1) {
            count++
            start = idx + q.length
          }
          if (count > 0 && line === 0) {
            line = i + 1
            preview = lines[i].trim().slice(0, 120)
          }
        }
        if (count > 0 || name.toLowerCase().includes(q)) {
          out.push({ path: p, name, line, preview, count })
          if (out.length >= limit) break
        }
      }
      const nameHit = (h: SearchHit) => (h.name.toLowerCase().includes(q) ? 1 : 0)
      return out.sort((a, b) => nameHit(b) - nameHit(a) || b.count - a.count)
    },
    async readDoc(path) {
      const f = files.get(path)
      if (!f) throw new Error(`not found: ${path}`)
      return { content: f.content, mtimeMs: f.mtime }
    },
    async canonInRoot(root, path) {
      // 浏览器 mock：词法归一（真实实现在 Rust 侧 canonicalize）
      const norm = (p: string) => {
        const parts: string[] = []
        for (const seg of p.replace(/\\/g, '/').split('/')) {
          if (!seg || seg === '.') continue
          if (seg === '..') {
            if (!parts.length) throw new Error('路径越出工作区，已拒绝')
            parts.pop()
          } else parts.push(seg)
        }
        return '/' + parts.join('/')
      }
      const abs = path.startsWith('/') || /^[a-zA-Z]:/.test(path) ? norm(path) : norm(`${root}/${path}`)
      const rootN = norm(root)
      if (abs !== rootN && !abs.startsWith(`${rootN}/`)) throw new Error('路径越出工作区，已拒绝')
      return abs
    },
    async writeDocAtomic(path, content, expectedMtimeMs) {
      const f = files.get(path)
      if (f && expectedMtimeMs !== null && f.mtime !== expectedMtimeMs) throw 'conflict'
      const mtime = ++clock
      files.set(path, { content, mtime })
      return mtime
    },
    async createEntry(parent, name, isDir) {
      const p = `${parent}/${name}`
      if (files.has(p)) throw new Error('已存在同名文件')
      if (!isDir) files.set(p, { content: '', mtime: ++clock })
      return p
    },
    async renameEntry(path, newName) {
      const target = `${dirOf(path)}/${newName}`
      const f = files.get(path)
      if (f) {
        files.delete(path)
        files.set(target, f)
      }
      return target
    },
    async trashEntry(path) {
      files.delete(path)
      for (const p of [...files.keys()]) if (p.startsWith(path + '/')) files.delete(p)
    },
    async revealInOs() {},
    async loadSession() {
      return session
    },
    async saveSession(s) {
      session = s
    },
    async pickFolder() {
      return ROOT
    },
    async pickFile() {
      return '/demo/README.md'
    },
    async pickSavePath(defaultName) {
      return `${ROOT}/${defaultName}`
    },
    async confirm(message) {
      return window.confirm(message)
    },
    async exportPdfNative() {
      throw new Error('浏览器环境不支持静默导出')
    },
    async savePastedImage(docPath, _dataB64, ext) {
      const stem = nameNoExt(docPath)
      return `assets/${stem}/img-${++clock}.${ext}`
    },
    async previewHtmlUrl() {
      return null // 浏览器/测试环境走 srcdoc 回退
    },
    async startWatch() {},
    async stopWatch() {},
    async onFsChanged() {
      return () => {}
    },
    async initialFiles() {
      return []
    },
    // ---- AI mock：浏览器预览用的假流式回复 ----
    async setApiKey() {},
    async hasApiKey() {
      return true
    },
    async aiChat(req, onEvent) {
      cancelled.delete(req.requestId)
      const last = req.messages[req.messages.length - 1]?.content ?? ''
      const reply = `（demo 回复）收到你的消息：**${last.slice(0, 40)}**\n\n这是浏览器预览环境的模拟流式输出；在桌面应用中将连接你配置的模型（${req.provider.name} · ${req.provider.model}）。`
      for (const ch of reply) {
        if (cancelled.has(req.requestId)) return
        await new Promise((r) => setTimeout(r, 12))
        onEvent({ type: 'delta', text: ch })
      }
      onEvent({ type: 'done' })
    },
    async aiCancel(requestId) {
      cancelled.add(requestId)
    },
    async loadChats() {
      return 'null'
    },
    async saveChats() {},
    async ragIndex() {
      return { files: files.size, chunks: files.size * 2, embedded: 0, skipped: 0 }
    },
    async ragSearch(_ws, query, _embed, k) {
      // mock：2 字滑窗重叠计分（真实实现在 Rust 侧：BM25/余弦）
      const grams: string[] = []
      for (let i = 0; i < query.length - 1; i++) grams.push(query.slice(i, i + 2))
      return [...files.entries()]
        .filter(([p]) => /\.(md|markdown)$/i.test(p))
        .map(([p, f]) => ({
          path: p,
          heading: p.split('/').pop() ?? p,
          snippet: f.content.slice(0, 200),
          score: grams.filter((g) => f.content.includes(g)).length,
        }))
        .filter((h) => h.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
    },
  }
}

const cancelled = new Set<string>()

function nameNoExt(p: string) {
  const name = p.slice(p.lastIndexOf('/') + 1)
  return name.replace(/\.\w+$/, '')
}

let current: Ipc = isTauri ? tauriIpc() : createMockIpc()

export function setIpc(ipc: Ipc) {
  current = ipc
}

export function ipc(): Ipc {
  return current
}
