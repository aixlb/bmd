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

export interface Ipc {
  scanDir(path: string): Promise<Entry[]>
  readDoc(path: string): Promise<DocPayload>
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
  pickSavePath(defaultName: string): Promise<string | null>
  confirm(message: string, title?: string): Promise<boolean>
}

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function tauriIpc(): Ipc {
  // 动态 import 避免浏览器环境加载 @tauri-apps 模块
  const inv = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(cmd, args)
  }
  return {
    scanDir: (path) => inv('scan_dir', { path }),
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
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      })
      return typeof r === 'string' ? r : null
    },
    pickSavePath: async (defaultName) => {
      const { save } = await import('@tauri-apps/plugin-dialog')
      return save({
        defaultPath: defaultName,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
    },
    confirm: async (message, title) => {
      const { ask } = await import('@tauri-apps/plugin-dialog')
      return ask(message, { title: title ?? 'bmd' })
    },
  }
}

/** 浏览器预览 / vitest 用的内存文件系统 */
export function createMockIpc(seed?: Record<string, string>): Ipc {
  const ROOT = '/demo'
  const files = new Map<string, { content: string; mtime: number }>()
  let clock = 1000
  const defaults: Record<string, string> = seed ?? {
    '/demo/README.md': '# demo 工作区\n\n这是浏览器预览用的内存工作区。\n',
    '/demo/笔记/想法.md': '## 想法\n\n- **bmd** 要够快\n- 手感要像 Typora\n',
    '/demo/笔记/清单.md': '# 清单\n\n1. 完成 M1\n2. 完成 M2\n',
    '/demo/参考.txt': 'not markdown',
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
    async readDoc(path) {
      const f = files.get(path)
      if (!f) throw new Error(`not found: ${path}`)
      return { content: f.content, mtimeMs: f.mtime }
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
  }
}

let current: Ipc = isTauri ? tauriIpc() : createMockIpc()

export function setIpc(ipc: Ipc) {
  current = ipc
}

export function ipc(): Ipc {
  return current
}
