import { defineStore } from 'pinia'
import { isHtmlPath, isImagePath, isMarkdownPath } from '@/lib/fileTypes'
import { ipc, type Session } from '@/lib/ipc'
import { editorRegistry } from '@/lib/editorRegistry'
import { menu } from '@/lib/menuBus'

export interface Tab {
  id: string
  path: string | null
  title: string
  /** 左侧单击产生的临时预览标签；确认打开后置 false */
  preview: boolean
  /** md/text：可编辑；html/image：只读预览（不创建编辑器状态，不可保存） */
  kind: 'md' | 'text' | 'html' | 'image'
  dirty: boolean
  /** 当前编辑修订号；每次用户修改递增。 */
  revision: number
  /** 最近一次成功写盘对应的修订号。 */
  savedRevision: number
  /** EditorState 被替换的代次；同一预览标签轮播文件时通知 EditorHost 重建内容。 */
  editorVersion: number
  /** 磁盘文本编码；保存时保持原编码。 */
  encoding: string
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
type DirtyPreviewAction = 'save' | 'discard' | 'cancel'
type TabKind = Tab['kind']
/** 所有会改变活动文档的用户意图共用序号，异步读取完成后只允许最新意图抢焦点。 */
let navigationRequestSeq = 0
const saveQueues = new Map<string, Promise<boolean>>()

async function reportSaveError(error: unknown) {
  console.error('[bmd] 保存文件失败', error)
  await menu()?.askChoice(
    '保存文件失败',
    error instanceof Error ? error.message : String(error),
    [{ value: 'ok', label: '知道了', primary: true }],
  )
}

function kindOfPath(path: string): TabKind {
  return isHtmlPath(path) ? 'html' : isImagePath(path) ? 'image' : isMarkdownPath(path) ? 'md' : 'text'
}

function isEditable(kind: TabKind): boolean {
  return kind === 'md' || kind === 'text'
}

function comparablePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[a-z]:/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function samePath(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b)
}

function matchesPathPrefix(path: string, target: string, isDir: boolean): boolean {
  const candidate = comparablePath(path)
  const base = comparablePath(target)
  return candidate === base || (isDir && candidate.startsWith(`${base}/`))
}

function remapPath(path: string, from: string, to: string): string {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedFrom = from.replace(/\\/g, '/').replace(/\/+$/, '')
  const suffix = normalizedPath.slice(normalizedFrom.length)
  const separator = to.includes('\\') && !to.includes('/') ? '\\' : '/'
  return `${to.replace(/[\\/]+$/, '')}${suffix}`.replace(/\//g, separator)
}

async function loadTabPayload(path: string) {
  const kind = kindOfPath(path)
  let content: string | null = null
  let mtimeMs: number | null = null
  let encoding = 'utf-8'
  if (kind !== 'image') {
    // 图片是二进制，不走文本读取；内容由预览协议直接服务
    ;({ content, mtimeMs, encoding } = await ipc().readDoc(path))
  }
  let previewUrl: string | null = null
  if (kind === 'html' || kind === 'image') {
    try {
      previewUrl = await ipc().previewHtmlUrl(path)
    } catch {
      previewUrl = null // 注册失败：html 回退 srcdoc；图片显示占位提示
    }
  }
  return { kind, content, mtimeMs, encoding, previewUrl }
}

async function createPathTab(path: string, preview: boolean): Promise<Tab> {
  const payload = await loadTabPayload(path)
  return {
    id: nextId(),
    path,
    title: titleOf(path),
    preview,
    kind: payload.kind,
    dirty: false,
    revision: 0,
    savedRevision: 0,
    editorVersion: 0,
    encoding: payload.encoding,
    mtimeMs: payload.mtimeMs,
    conflict: false,
    initialDoc: payload.content,
    previewUrl: payload.previewUrl,
  }
}

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
      const requestId = ++navigationRequestSeq
      const existing = this.tabs.find((t) => !!t.path && samePath(t.path, path))
      if (existing) {
        if (existing.id !== this.activeId) {
          const ok = await this.saveDirtyPreviewBeforeLeaving(this.activeId)
          if (requestId !== navigationRequestSeq) return this.active ?? existing
          if (!ok) return this.active ?? existing
        }
        existing.preview = false
        this.activeId = existing.id
        return existing
      }
      const active = this.active
      if (active?.preview && active.dirty) {
        const ok = await this.saveDirtyPreviewBeforeLeaving(active.id)
        if (requestId !== navigationRequestSeq) return this.active ?? active
        if (!ok) return active
      }
      let tab: Tab
      try {
        tab = await createPathTab(path, false)
      } catch (error) {
        if (requestId !== navigationRequestSeq && this.active) return this.active
        throw error
      }
      const loadedWhileWaiting = this.tabs.find((t) => !!t.path && samePath(t.path, path))
      if (loadedWhileWaiting) {
        loadedWhileWaiting.preview = false
        if (requestId === navigationRequestSeq) this.activeId = loadedWhileWaiting.id
        return loadedWhileWaiting
      }
      this.tabs.push(tab)
      if (requestId === navigationRequestSeq) this.activeId = tab.id
      return tab
    },

    /** 左侧单击：共用一个临时预览标签轮播文件，避免标签栏堆积 */
    async previewFile(path: string) {
      const requestId = ++navigationRequestSeq
      const formal = this.tabs.find((t) => !!t.path && samePath(t.path, path) && !t.preview)
      if (formal) {
        const ok = await this.saveDirtyPreviewBeforeLeaving(this.activeId)
        if (requestId !== navigationRequestSeq) return this.active ?? formal
        if (!ok) return this.active ?? formal
        this.activeId = formal.id
        return formal
      }

      const currentPreview = this.tabs.find((t) => t.preview)
      if (currentPreview?.path && samePath(currentPreview.path, path)) {
        this.activeId = currentPreview.id
        return currentPreview
      }

      if (currentPreview) {
        const ok = await this.saveDirtyPreviewBeforeLeaving(currentPreview.id)
        if (requestId !== navigationRequestSeq) return this.active ?? currentPreview
        if (!ok) {
          this.activeId = currentPreview.id
          return currentPreview
        }
        if (currentPreview.preview) return await this.replacePreviewTab(currentPreview, path, requestId)
      }

      let tab: Tab
      try {
        tab = await createPathTab(path, true)
      } catch (error) {
        if (requestId !== navigationRequestSeq) {
          const active = this.active
          if (active) return active
        }
        throw error
      }
      if (requestId !== navigationRequestSeq) return this.active ?? tab
      const formalAfterLoad = this.tabs.find(
        (t) => !!t.path && samePath(t.path, path) && !t.preview,
      )
      if (formalAfterLoad) {
        this.activeId = formalAfterLoad.id
        return formalAfterLoad
      }
      this.tabs.push(tab)
      this.activeId = tab.id
      return tab
    },

    /** 双击文件或预览标签：把临时预览确认成正式标签 */
    confirmPreview(id: string) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return false
      navigationRequestSeq++
      tab.preview = false
      this.activeId = tab.id
      return true
    },

    async replacePreviewTab(tab: Tab, path: string, requestId = navigationRequestSeq) {
      let payload
      try {
        payload = await loadTabPayload(path)
      } catch (error) {
        if (requestId !== navigationRequestSeq || !tab.preview || !this.tabs.includes(tab)) {
          return this.active ?? tab
        }
        throw error
      }
      if (requestId !== navigationRequestSeq || !tab.preview || !this.tabs.includes(tab)) {
        return this.active ?? tab
      }
      editorRegistry.remove(tab.id)
      tab.path = path
      tab.title = titleOf(path)
      tab.preview = true
      tab.kind = payload.kind
      tab.dirty = false
      tab.revision = 0
      tab.savedRevision = 0
      tab.encoding = payload.encoding
      tab.mtimeMs = payload.mtimeMs
      tab.conflict = false
      tab.initialDoc = payload.content
      tab.previewUrl = payload.previewUrl
      tab.editorVersion++
      this.activeId = tab.id
      return tab
    },

    async newFile() {
      const requestId = ++navigationRequestSeq
      const create = () => {
        // 初始不置 dirty：未编辑过的新文件关闭时不弹确认（真实编辑由 markDirty 标记）
        const tab: Tab = {
          id: nextId(),
          path: null,
          title: '未命名',
          preview: false,
          kind: 'md',
          dirty: false,
          revision: 0,
          savedRevision: 0,
          editorVersion: 0,
          encoding: 'utf-8',
          mtimeMs: null,
          conflict: false,
          initialDoc: '',
          previewUrl: null,
        }
        this.tabs.push(tab)
        this.activeId = tab.id
        return tab
      }
      const active = this.active
      if (active?.preview && active.dirty) {
        const ok = await this.saveDirtyPreviewBeforeLeaving(active.id)
        if (!ok || requestId !== navigationRequestSeq) return this.active ?? active
      }
      return create()
    },

    activate(id: string) {
      if (!this.tabs.some((t) => t.id === id)) return false
      const requestId = ++navigationRequestSeq
      if (this.activeId === id) return true
      const active = this.active
      if (active?.preview && active.dirty) {
        return this.saveDirtyPreviewBeforeLeaving(active.id).then((ok) => {
          if (!ok || requestId !== navigationRequestSeq || !this.tabs.some((t) => t.id === id)) {
            return false
          }
          this.activeId = id
          return true
        })
      }
      this.activeId = id
      return true
    },

    activateIndex(i: number) {
      const tab = this.tabs[i]
      if (tab) return this.activate(tab.id)
      return false
    },

    cycle(delta: 1 | -1) {
      if (!this.tabs.length) return false
      const i = (this.activeIndex + delta + this.tabs.length) % this.tabs.length
      return this.activate(this.tabs[i].id)
    },

    markDirty(id: string) {
      const tab = this.tabs.find((t) => t.id === id)
      if (tab) {
        tab.revision++
        tab.dirty = tab.revision !== tab.savedRevision
      }
    },

    /**
     * 保存。零写入保证（FR-17/M1 验收）：非 dirty 且非另存为时直接返回。
     * 冲突（外部修改过）时询问是否覆盖。
     */
    saveTab(id: string, opts: { saveAs?: boolean } = {}): Promise<boolean> {
      const previous = saveQueues.get(id) ?? Promise.resolve(true)
      const queued = previous.catch(() => false).then(() => this.performSave(id, opts))
      saveQueues.set(id, queued)
      return queued.finally(() => {
        if (saveQueues.get(id) === queued) saveQueues.delete(id)
      })
    },

    async performSave(id: string, opts: { saveAs?: boolean } = {}): Promise<boolean> {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return false
      if (!isEditable(tab.kind)) return false // 只读预览（html/图片），不支持编辑/保存
      if (!tab.dirty && tab.path && !opts.saveAs) {
        tab.preview = false
        return true
      }

      let path = tab.path
      if (!path || opts.saveAs) {
        path = await ipc().pickSavePath(tab.path ? tab.title : '未命名.md')
        if (!path) return false
      }

      const duplicate = this.tabs.find(
        (item) => item.id !== id && !!item.path && samePath(item.path, path),
      )
      if (duplicate) {
        await menu()?.askChoice(
          '无法保存',
          `「${duplicate.title}」已在另一个标签中打开。请先关闭该标签，避免两个编辑器互相覆盖。`,
          [{ value: 'ok', label: '知道了', primary: true }],
        )
        return false
      }

      // 选完路径后再取内容，保证“另存为”弹窗期间的输入也包含在本次快照中。
      const revision = tab.revision
      const doc = editorRegistry.getDoc(id) ?? tab.initialDoc
      if (doc === null || doc === undefined) return false
      const nextKind = kindOfPath(path)
      if (nextKind === 'image') throw new Error('文本内容不能另存为图片格式')

      try {
        tab.mtimeMs = await ipc().writeDocAtomic(
          path,
          doc,
          opts.saveAs ? null : tab.mtimeMs,
          tab.encoding,
        )
      } catch (e) {
        if (`${e}` === 'conflict') {
          const overwrite = await ipc().confirm(
            `「${tab.title}」已被其他程序修改。\n覆盖磁盘上的版本？`,
            '文件冲突',
          )
          if (!overwrite) return false
          tab.mtimeMs = await ipc().writeDocAtomic(path, doc, null, tab.encoding)
        } else {
          throw e
        }
      }
      tab.path = path
      tab.title = titleOf(path)
      tab.preview = false
      if (tab.kind !== nextKind) {
        editorRegistry.remove(tab.id)
        tab.kind = nextKind
        tab.initialDoc = doc
        tab.previewUrl =
          nextKind === 'html'
            ? await ipc().previewHtmlUrl(path).catch(() => null)
            : null
        tab.editorVersion++
      }
      tab.savedRevision = revision
      tab.dirty = tab.revision !== revision
      this.savedAt = Date.now()
      return true
    },

    async awaitPendingSave(id: string): Promise<boolean> {
      const pending = saveQueues.get(id)
      if (!pending) return true
      try {
        return await pending
      } catch {
        return false
      }
    },

    async saveDirtyPreviewBeforeLeaving(id: string | null) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab?.preview || !tab.dirty) return true
      const action = await this.askDirtyPreviewAction(tab)
      if (action === 'save') {
        try {
          return await this.saveTab(tab.id)
        } catch (error) {
          await reportSaveError(error)
          return false
        }
      }
      if (action === 'discard') return await this.discardTabChanges(tab.id)
      return false
    },

    async askDirtyPreviewAction(tab: Tab): Promise<DirtyPreviewAction> {
      const m = menu()
      if (m) {
        const action = await m.askChoice(
          '文件已有修改，是否要保存？',
          `「${tab.title}」还是临时预览标签。\n保存后会固定为正式打开；不保存会丢弃这次预览中的修改。`,
          [
            { value: 'save', label: '保存并固定打开', primary: true },
            { value: 'discard', label: '不保存', danger: true },
            { value: 'cancel', label: '取消' },
          ],
        )
        return action === 'save' || action === 'discard' ? action : 'cancel'
      }
      // 测试/兜底环境没有应用内三选项弹窗时，系统确认只提供“保存/取消”。
      return (await ipc().confirm('文件已有修改，是否要保存？', '文件已有修改'))
        ? 'save'
        : 'cancel'
    },

    async discardTabChanges(id: string): Promise<boolean> {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return false
      editorRegistry.remove(id)
      if (tab.path && tab.kind !== 'image') {
        try {
          const payload = await ipc().readDoc(tab.path)
          tab.initialDoc = payload.content
          tab.mtimeMs = payload.mtimeMs
          tab.encoding = payload.encoding
        } catch {
          // 文件可能已被删除；仍允许丢弃当前内存修改
          tab.initialDoc = ''
          tab.mtimeMs = null
        }
      }
      const cleanRevision = tab.revision + 1
      tab.revision = cleanRevision
      tab.savedRevision = cleanRevision
      tab.dirty = false
      tab.conflict = false
      tab.editorVersion++
      return true
    },

    async askDirtyCloseAction(tab: Tab): Promise<DirtyPreviewAction> {
      const m = menu()
      if (m) {
        const action = await m.askChoice(
          '文件已有修改，是否要保存？',
          `「${tab.title}」包含尚未保存的修改。`,
          [
            { value: 'save', label: '保存', primary: true },
            { value: 'discard', label: '不保存', danger: true },
            { value: 'cancel', label: '取消' },
          ],
        )
        return action === 'save' || action === 'discard' ? action : 'cancel'
      }
      return (await ipc().confirm('文件已有修改，是否要保存？', '文件已有修改'))
        ? 'save'
        : 'cancel'
    },

    async confirmDirtyTabForClose(tab: Tab): Promise<boolean> {
      while (tab.dirty) {
        const action = tab.preview
          ? await this.askDirtyPreviewAction(tab)
          : await this.askDirtyCloseAction(tab)
        if (action === 'cancel') return false
        if (action === 'save') {
          try {
            if (!(await this.saveTab(tab.id))) return false
          } catch (error) {
            await reportSaveError(error)
            return false
          }
          continue
        }
        tab.dirty = false
        return true
      }
      return true
    },

    async confirmDirtyPreviewsForClose(): Promise<boolean> {
      for (const tab of [...this.tabs]) {
        if (tab.preview && tab.dirty) {
          const ok = await this.saveDirtyPreviewBeforeLeaving(tab.id)
          if (!ok) return false
        }
      }
      return true
    },

    async closeTab(id: string): Promise<boolean> {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return false
      if (tab.preview) navigationRequestSeq++
      await this.awaitPendingSave(id)
      if (!(await this.confirmDirtyTabForClose(tab))) return false
      const idx = this.tabs.findIndex((t) => t.id === id)
      this.tabs.splice(idx, 1)
      editorRegistry.remove(id)
      if (this.activeId === id) {
        this.activeId = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? null
      }
      return true
    },

    async confirmAllDirtyForClose(): Promise<boolean> {
      await Promise.allSettled([...saveQueues.values()])
      for (const tab of [...this.tabs]) {
        if (!tab.dirty) continue
        if (!(await this.confirmDirtyTabForClose(tab))) return false
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
      if (payload.mtimeMs === tab.mtimeMs) return
      tab.mtimeMs = payload.mtimeMs
      tab.encoding = payload.encoding
      const cleanRevision = tab.revision + 1
      tab.revision = cleanRevision
      tab.savedRevision = cleanRevision
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
        tab.editorVersion++
      }
    },

    /** 冲突处理：保留本地（下次保存直接覆盖磁盘） */
    keepLocal(id: string) {
      const tab = this.tabs.find((t) => t.id === id)
      if (!tab) return
      tab.conflict = false
      tab.mtimeMs = null
    },

    tabsForPath(path: string, isDir: boolean): Tab[] {
      return this.tabs.filter((tab) => !!tab.path && matchesPathPrefix(tab.path, path, isDir))
    },

    async awaitPathSaves(path: string, isDir: boolean): Promise<boolean> {
      const results = await Promise.all(this.tabsForPath(path, isDir).map((tab) => this.awaitPendingSave(tab.id)))
      return results.every(Boolean)
    },

    /** 重命名前把受影响文档写稳，避免目录移动后保存仍落向旧路径。 */
    async savePathPrefix(path: string, isDir: boolean): Promise<boolean> {
      const affected = this.tabsForPath(path, isDir)
      for (const tab of affected) {
        await this.awaitPendingSave(tab.id)
        if (tab.dirty && !(await this.saveTab(tab.id))) return false
      }
      return true
    },

    /** 文件系统重命名成功后，原子映射所有受影响标签的路径与渲染能力。 */
    async remapPathPrefix(from: string, to: string, isDir: boolean) {
      navigationRequestSeq++
      for (const tab of this.tabsForPath(from, isDir)) {
        const mapped = remapPath(tab.path!, from, to)
        const oldKind = tab.kind
        const nextKind = kindOfPath(mapped)
        tab.path = mapped
        tab.title = titleOf(mapped)

        // Markdown/纯文本类型未变时保留 EditorState、撤销栈与光标。
        if (oldKind === nextKind && isEditable(nextKind)) continue

        const payload = await loadTabPayload(mapped)
        editorRegistry.remove(tab.id)
        tab.kind = payload.kind
        tab.mtimeMs = payload.mtimeMs
        tab.encoding = payload.encoding
        tab.initialDoc = payload.content
        tab.previewUrl = payload.previewUrl
        tab.conflict = false
        tab.editorVersion++
        const cleanRevision = tab.revision + 1
        tab.revision = cleanRevision
        tab.savedRevision = cleanRevision
        tab.dirty = false
      }
    },

    /** 文件/目录已被明确删除后，无二次询问地关闭其全部标签。 */
    forceClosePathPrefix(path: string, isDir: boolean) {
      navigationRequestSeq++
      const ids = new Set(this.tabsForPath(path, isDir).map((tab) => tab.id))
      if (!ids.size) return
      for (const id of ids) editorRegistry.remove(id)
      const activeRemoved = !!this.activeId && ids.has(this.activeId)
      this.tabs = this.tabs.filter((tab) => !ids.has(tab.id))
      if (activeRemoved) this.activeId = this.tabs[0]?.id ?? null
    },

    sessionSnapshot(root: string | null): Session {
      const persisted = this.tabs.filter((t) => t.path && !t.preview)
      return {
        root,
        openPaths: persisted.map((t) => t.path as string),
        active:
          this.active?.path && !this.active.preview
            ? persisted.findIndex((t) => t.id === this.activeId)
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
        navigationRequestSeq++
        this.activeId = this.tabs[session.active].id
      }
    },
  },
})
