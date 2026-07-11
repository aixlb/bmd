import { defineStore } from 'pinia'
import { isReadableTextPath } from '@/lib/fileTypes'
import { ipc, type Entry } from '@/lib/ipc'

export type FileSortMode = 'type' | 'nameAsc' | 'nameDesc'

const SORT_KEY = 'bmd.fileSort'
let workspaceRequestSeq = 0
let watcherTransition: Promise<void> = Promise.resolve()

function enqueueWatcherTransition(task: () => Promise<void>): Promise<void> {
  const next = watcherTransition.catch(() => {}).then(task)
  watcherTransition = next
  return next
}

function initialSortMode(): FileSortMode {
  const saved = localStorage.getItem(SORT_KEY)
  return saved === 'type' || saved === 'nameAsc' || saved === 'nameDesc' ? saved : 'type'
}

function sortEntries(entries: Entry[], mode: FileSortMode): Entry[] {
  const byName = (a: Entry, b: Entry) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  const out = [...entries]
  if (mode === 'nameAsc') return out.sort(byName)
  if (mode === 'nameDesc') return out.sort((a, b) => byName(b, a))
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || byName(a, b))
}

export const useWorkspace = defineStore('workspace', {
  state: () => ({
    root: null as string | null,
    /** dir path → 已加载的子项（懒加载，展开时才 scan） */
    children: {} as Record<string, Entry[]>,
    expanded: {} as Record<string, boolean>,
    filter: '',
    sortMode: initialSortMode(),
  }),

  getters: {
    rootName: (s) => (s.root ? s.root.split(/[/\\]/).filter(Boolean).pop() : null),
    rootEntries: (s) => (s.root ? sortEntries(s.children[s.root] ?? [], s.sortMode) : []),
    sortedEntries: (s) => (entries: Entry[]) => sortEntries(entries, s.sortMode),
  },

  actions: {
    setSortMode(mode: FileSortMode) {
      this.sortMode = mode
      localStorage.setItem(SORT_KEY, mode)
    },

    async openFolder(path?: string) {
      const requestId = ++workspaceRequestSeq
      const target = path ?? (await ipc().pickFolder())
      if (!target || requestId !== workspaceRequestSeq) return false

      let entries: Entry[]
      try {
        entries = await ipc().scanDir(target)
      } catch {
        entries = []
      }
      if (requestId !== workspaceRequestSeq) return false

      await enqueueWatcherTransition(async () => {
        if (requestId !== workspaceRequestSeq) return
        const prev = this.root
        if (prev && prev !== target) {
          try {
            await ipc().stopWatch()
          } catch {
            // 旧监听不存在或停止失败时继续切换；新监听会在下方重建
          }
        }
        if (requestId !== workspaceRequestSeq) return
        this.root = target
        this.children = { [target]: entries }
        this.expanded = {}
        this.filter = ''
        try {
          await ipc().startWatch(target)
        } catch (e) {
          console.warn('[bmd] 目录监听启动失败', e)
        }
      })
      return requestId === workspaceRequestSeq && this.root === target
    },

    /** 进入无工作区的单文件模式：左侧不再展示上次打开的文件夹 */
    async clear() {
      const requestId = ++workspaceRequestSeq
      await enqueueWatcherTransition(async () => {
        if (requestId !== workspaceRequestSeq) return
        if (this.root) {
          try {
            await ipc().stopWatch()
          } catch {
            // 没有活动监听时忽略
          }
        }
        if (requestId !== workspaceRequestSeq) return
        this.root = null
        this.children = {}
        this.expanded = {}
        this.filter = ''
      })
    },

    async ensureChildren(dir: string) {
      if (this.children[dir]) return
      const requestId = workspaceRequestSeq
      const root = this.root
      let entries: Entry[]
      try {
        entries = await ipc().scanDir(dir)
      } catch {
        entries = []
      }
      if (requestId === workspaceRequestSeq && root === this.root) this.children[dir] = entries
    },

    async toggleDir(dir: string) {
      this.expanded[dir] = !this.expanded[dir]
      if (this.expanded[dir]) await this.ensureChildren(dir)
    },

    /** 收集工作区全部可读取文本文件（QuickOpen / AI @文件用，BFS 限深） */
    async collectAllText(): Promise<string[]> {
      if (!this.root) return []
      const out: string[] = []
      let frontier = [this.root]
      for (let depth = 0; depth < 8 && frontier.length && out.length < 2000; depth++) {
        const next: string[] = []
        for (const dir of frontier) {
          let entries
          try {
            entries = await ipc().scanDir(dir)
          } catch {
            continue
          }
          for (const e of entries) {
            if (e.isDir) next.push(e.path)
            else if (e.isText || isReadableTextPath(e.path)) out.push(e.path)
          }
        }
        frontier = next
      }
      return out.sort()
    },

    /** 重扫已加载的目录（外部变更/手动刷新） */
    async refresh() {
      const requestId = workspaceRequestSeq
      const root = this.root
      const dirs = Object.keys(this.children)
      const results = await Promise.all(
        dirs.map(async (d) => {
          try {
            return [d, await ipc().scanDir(d)] as const
          } catch {
            return [d, null] as const
          }
        }),
      )
      if (requestId !== workspaceRequestSeq || root !== this.root) return
      for (const [dir, entries] of results) {
        if (entries) this.children[dir] = entries
        else delete this.children[dir]
      }
    },
  },
})
