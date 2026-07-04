import { defineStore } from 'pinia'
import { ipc, type Entry } from '@/lib/ipc'

export const useWorkspace = defineStore('workspace', {
  state: () => ({
    root: null as string | null,
    /** dir path → 已加载的子项（懒加载，展开时才 scan） */
    children: {} as Record<string, Entry[]>,
    expanded: {} as Record<string, boolean>,
    filter: '',
  }),

  getters: {
    rootName: (s) => (s.root ? s.root.split(/[/\\]/).filter(Boolean).pop() : null),
    rootEntries: (s) => (s.root ? (s.children[s.root] ?? []) : []),
  },

  actions: {
    async openFolder(path?: string) {
      const target = path ?? (await ipc().pickFolder())
      if (!target) return
      this.root = target
      this.children = {}
      this.expanded = {}
      await this.ensureChildren(target)
      // 外部变更监听（FR-05）
      try {
        await ipc().startWatch(target)
      } catch (e) {
        console.warn('[bmd] 目录监听启动失败', e)
      }
    },

    async ensureChildren(dir: string) {
      if (this.children[dir]) return
      try {
        this.children[dir] = await ipc().scanDir(dir)
      } catch {
        this.children[dir] = []
      }
    },

    async toggleDir(dir: string) {
      this.expanded[dir] = !this.expanded[dir]
      if (this.expanded[dir]) await this.ensureChildren(dir)
    },

    /** 重扫已加载的目录（外部变更/手动刷新） */
    async refresh() {
      const dirs = Object.keys(this.children)
      await Promise.all(
        dirs.map(async (d) => {
          try {
            this.children[d] = await ipc().scanDir(d)
          } catch {
            delete this.children[d]
          }
        }),
      )
    },
  },
})
