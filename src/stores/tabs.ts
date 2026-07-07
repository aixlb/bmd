import { defineStore } from 'pinia'
import { isHtmlPath, isImagePath } from '@/lib/fileTypes'
import { ipc, type Session } from '@/lib/ipc'
import { editorRegistry } from '@/lib/editorRegistry'

export interface Tab {
  id: string
  path: string | null
  title: string
  /** md：可编辑；html/image：只读预览（不创建编辑器状态，不可保存） */
  kind: 'md' | 'html' | 'image'
  dirty: boolean
  mtimeMs: number | null
  /** 磁盘被外部修改且本地有未保存改动（FR-21） */
  conflict: boolean
  /** EditorHost 首次创建 EditorState 的初始内容，消费后置 null；html 标签保留（srcdoc 回退用） */
  initialDoc: string | null
  /** html 预览 URL（Tauri：bmdpreview:// 协议；浏览器环境为 null，走 srcdoc） */
  previewUrl: string | null
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
      const kind = isHtmlPath(path) ? 'html' : isImagePath(path) ? 'image' : 'md'
      let content: string | null = null
      let mtimeMs: number | null = null
      if (kind !== 'image') {
        // 图片是二进制，不走文本读取；内容由预览协议直接服务
        ;({ content, mtimeMs } = await ipc().readDoc(path))
      }
      let previewUrl: string | null = null
      if (kind !== 'md') {
        try {
          previewUrl = await ipc().previewHtmlUrl(path)
        } catch {
          previewUrl = null // 注册失败：html 回退 srcdoc；图片显示占位提示
        }
      }
      const tab: Tab = {
        id: nextId(),
        path,
        title: titleOf(path),
        kind,
        dirty: false,
        mtimeMs,
        conflict: false,
        initialDoc: content,
        previewUrl,
      }
      this.tabs.push(tab)
      this.activeId = tab.id
      return tab
    },

    newFile() {
      // 初始不置 dirty：未编辑过的新文件关闭时不弹确认（真实编辑由 markDirty 标记）
      const tab: Tab = {
        id: nextId(),
        path: null,
        title: '未命名',
        kind: 'md',
        dirty: false,
        mtimeMs: null,
        conflict: false,
        initialDoc: '',
        previewUrl: null,
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
      if (tab.kind !== 'md') return false // 只读预览（html/图片），不支持编辑/保存
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

    /** 批量关闭：逐个走 closeTab，保留脏文件确认；某个取消不影响其余 */
    async closeTabs(ids: string[]) {
      for (const id of ids) await this.closeTab(id)
    },

    async closeOthers(id: string) {
      await this.closeTabs(this.tabs.filter((t) => t.id !== id).map((t) => t.id))
    },

    async closeLeft(id: string) {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx > 0) await this.closeTabs(this.tabs.slice(0, idx).map((t) => t.id))
    },

    async closeRight(id: string) {
      const idx = this.tabs.findIndex((t) => t.id === id)
      if (idx >= 0) await this.closeTabs(this.tabs.slice(idx + 1).map((t) => t.id))
    },

    /** 外部变更分发（FR-05/21）：未改动的标签静默重载，有改动的标记冲突 */
    async handleExternalChanges(paths: string[]) {
      const set = new Set(paths)
      for (const tab of this.tabs) {
        if (!tab.path || !set.has(tab.path)) continue
        if (tab.dirty) {
          tab.conflict = true
        } else {
          await this.reloadFromDisk(tab.id)
        }
      }
    },

    async reloadFromDisk(id: string) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab?.path) return
      if (tab.kind === 'image') {
        // 图片不读文本：更新 mtime 使 <img> 的 key 变化，协议端现读磁盘即新图
        tab.mtimeMs = Date.now()
        return
      }
      let payload
      try {
        payload = await ipc().readDoc(tab.path)
      } catch {
        return // 文件可能已被删除
      }
      tab.mtimeMs = payload.mtimeMs
      tab.dirty = false
      tab.conflict = false
      const view = editorRegistry.getActiveView()
      const state = editorRegistry.get(id)
      if (this.activeId === id && view && state) {
        // 活动标签就地替换（userEvent=external 使壳层不置 dirty）
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: payload.content },
          userEvent: 'external.reload',
        })
      } else {
        editorRegistry.remove(id)
        tab.initialDoc = payload.content
      }
    },

    /** 冲突处理：保留本地（下次保存直接覆盖磁盘） */
    keepLocal(id: string) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return
      tab.conflict = false
      tab.mtimeMs = null
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
