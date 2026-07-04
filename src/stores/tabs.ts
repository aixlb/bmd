import { defineStore } from 'pinia'
import { ipc, type Session } from '@/lib/ipc'
import { editorRegistry } from '@/lib/editorRegistry'

export interface Tab {
  id: string
  path: string | null
  title: string
  dirty: boolean
  mtimeMs: number | null
  /** EditorHost 首次创建 EditorState 的初始内容，消费后置 null */
  initialDoc: string | null
}

let seq = 0
const nextId = () => `tab-${++seq}-${Math.random().toString(36).slice(2, 8)}`
const titleOf = (path: string) => path.split(/[/\\]/).pop() ?? path

export const useTabs = defineStore('tabs', {
  state: () => ({
    tabs: [] as Tab[],
    activeId: null as string | null,
    savedAt: null as number | null,
  }),

  getters: {
    active: (s) => s.tabs.find((t) => t.id === s.activeId) ?? null,
    activeIndex: (s) => s.tabs.findIndex((t) => t.id === s.activeId),
  },

  actions: {
    async openFile(path: string) {
      const existing = this.tabs.find((t) => t.path === path)
      if (existing) {
        this.activeId = existing.id
        return existing
      }
      const { content, mtimeMs } = await ipc().readDoc(path)
      const tab: Tab = {
        id: nextId(),
        path,
        title: titleOf(path),
        dirty: false,
        mtimeMs,
        initialDoc: content,
      }
      this.tabs.push(tab)
      this.activeId = tab.id
      return tab
    },

    newFile() {
      const tab: Tab = {
        id: nextId(),
        path: null,
        title: '未命名',
        dirty: true,
        mtimeMs: null,
        initialDoc: '',
      }
      this.tabs.push(tab)
      this.activeId = tab.id
      return tab
    },

    activate(id: string) {
      if (this.tabs.some((t) => t.id === id)) this.activeId = id
    },

    activateIndex(i: number) {
      const tab = this.tabs[i]
      if (tab) this.activeId = tab.id
    },

    cycle(delta: 1 | -1) {
      if (!this.tabs.length) return
      const i = (this.activeIndex + delta + this.tabs.length) % this.tabs.length
      this.activeId = this.tabs[i].id
    },

    markDirty(id: string) {
      const tab = this.tabs.find((t) => t.id === id)
      if (tab) tab.dirty = true
    },

    /**
     * 保存。零写入保证（FR-17/M1 验收）：非 dirty 且非另存为时直接返回。
     * 冲突（外部修改过）时询问是否覆盖。
     */
    async saveTab(id: string, opts: { saveAs?: boolean } = {}): Promise<boolean> {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return false
      if (!tab.dirty && tab.path && !opts.saveAs) return true

      const doc = editorRegistry.getDoc(id) ?? tab.initialDoc
      if (doc === null || doc === undefined) return false

      let path = tab.path
      if (!path || opts.saveAs) {
        path = await ipc().pickSavePath(tab.path ? tab.title : '未命名.md')
        if (!path) return false
      }

      try {
        tab.mtimeMs = await ipc().writeDocAtomic(path, doc, opts.saveAs ? null : tab.mtimeMs)
      } catch (e) {
        if (`${e}` === 'conflict') {
          const overwrite = await ipc().confirm(
            `「${tab.title}」已被其他程序修改。\n覆盖磁盘上的版本？`,
            '文件冲突',
          )
          if (!overwrite) return false
          tab.mtimeMs = await ipc().writeDocAtomic(path, doc, null)
        } else {
          throw e
        }
      }
      tab.path = path
      tab.title = titleOf(path)
      tab.dirty = false
      this.savedAt = Date.now()
      return true
    },

    async closeTab(id: string): Promise<boolean> {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return false
      if (tab.dirty) {
        const discard = await ipc().confirm(
          `「${tab.title}」有未保存的更改，关闭将丢弃。\n确定关闭？`,
          '未保存的更改',
        )
        if (!discard) return false
      }
      const idx = this.tabs.findIndex((t) => t.id === id)
      this.tabs.splice(idx, 1)
      editorRegistry.remove(id)
      if (this.activeId === id) {
        this.activeId = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? null
      }
      return true
    },

    sessionSnapshot(root: string | null): Session {
      return {
        root,
        openPaths: this.tabs.filter((t) => t.path).map((t) => t.path as string),
        active: this.active?.path
          ? this.tabs.filter((t) => t.path).findIndex((t) => t.id === this.activeId)
          : null,
      }
    },

    async restoreSession(session: Session) {
      for (const p of session.openPaths) {
        try {
          await this.openFile(p)
        } catch {
          // 文件可能已被删除，跳过
        }
      }
      if (session.active !== null && this.tabs[session.active]) {
        this.activeId = this.tabs[session.active].id
      }
    },
  },
})
