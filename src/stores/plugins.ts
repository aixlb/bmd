// 第三方插件运行时：目录发现、启用/禁用、生命周期、UI 贡献点登记。
// 插件目录：{appData}/plugins/<id>/{manifest.json, main.js}（仅桌面端）。
// ⚠ 本文件是插件接口契约的一部分：修改对外行为时必须同步 PLUGINS.md（含「API 变更记录」），
//   见 CLAUDE.md「插件 API 文档同步」。
import { defineStore } from 'pinia'
import { watch } from 'vue'
import { editorRegistry } from '@/lib/editorRegistry'
import { isTauri } from '@/lib/ipc'
import {
  loadPluginModule,
  showNotice,
  validateManifest,
  compareVersions,
  matchHotkey,
  type BmdPluginApp,
  type PluginCommand,
  type PluginEvent,
  type PluginManifest,
  type PluginModule,
  type RibbonItem,
  type SettingTab,
  type StatusItem,
} from '@/lib/pluginApi'
import { isMac } from '@/lib/platform'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'

export const APP_VERSION = '1.0.3'

export interface InstalledPlugin {
  manifest: PluginManifest
  dir: string
  /** 加载/解析失败原因（展示在插件管理页） */
  error?: string
}

/** 已加载实例与其清理器（重对象，不进响应式状态） */
const instances = new Map<string, { mod: PluginModule; offs: (() => void)[] }>()

// 宿主事件总线（file-open / theme-change）
const listeners = new Map<PluginEvent, Set<(payload?: unknown) => void>>()
let bridgeStops: (() => void)[] = []
function emit(event: PluginEvent, payload?: unknown) {
  for (const cb of listeners.get(event) ?? []) {
    try {
      cb(payload)
    } catch (e) {
      console.warn(`[bmd] 插件事件回调出错（${event}）`, e)
    }
  }
}

function loadEnabledIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem('bmd.plugins.enabled') ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

let statusSeq = 0

export const usePlugins = defineStore('plugins', {
  state: () => ({
    /** 桌面端才支持动态插件（浏览器预览无文件系统） */
    supported: isTauri,
    pluginsDir: '' as string,
    installed: [] as InstalledPlugin[],
    enabledIds: loadEnabledIds(),
    scanning: false,
    // ---- 插件贡献的 UI（响应式，供组件渲染） ----
    ribbons: [] as RibbonItem[],
    statusItems: [] as StatusItem[],
    commands: [] as PluginCommand[],
    settingTabs: [] as SettingTab[],
  }),

  getters: {
    isEnabled: (s) => (id: string) => s.enabledIds.includes(id),
  },

  actions: {
    /** App 启动时调用：定位插件目录 → 扫描 → 加载已启用插件 */
    async init() {
      // 宿主事件桥接：活动标签变化 → file-open；主题变化 → theme-change
      if (!bridgeStops.length) {
        const tabs = useTabs()
        const ui = useUi()
        bridgeStops = [
          watch(
            () => tabs.activeId,
            () => {
              const t = tabs.active
              emit('file-open', t ? { path: t.path, title: t.title } : null)
            },
          ),
          watch(
            () => ui.theme,
            (theme) => emit('theme-change', theme),
          ),
        ]
      }

      if (!this.supported) return
      try {
        const { appDataDir, join } = await import('@tauri-apps/api/path')
        this.pluginsDir = await join(await appDataDir(), 'plugins')
        const { exists, mkdir } = await import('@tauri-apps/plugin-fs')
        if (!(await exists(this.pluginsDir))) await mkdir(this.pluginsDir, { recursive: true })
      } catch (e) {
        console.warn('[bmd] 插件目录初始化失败', e)
        this.supported = false
        return
      }
      await this.scan()
      for (const p of this.installed) {
        if (!p.error && this.enabledIds.includes(p.manifest.id)) await this.load(p.manifest.id)
      }
    },

    /** 重新扫描插件目录（不打断已加载插件） */
    async scan() {
      if (!this.supported || this.scanning) return
      this.scanning = true
      try {
        const { readDir, readTextFile, exists } = await import('@tauri-apps/plugin-fs')
        const { join } = await import('@tauri-apps/api/path')
        const out: InstalledPlugin[] = []
        for (const entry of await readDir(this.pluginsDir)) {
          if (!entry.isDirectory) continue
          const dir = await join(this.pluginsDir, entry.name)
          const item: InstalledPlugin = {
            manifest: { id: entry.name, name: entry.name, version: '?' },
            dir,
          }
          try {
            const mfPath = await join(dir, 'manifest.json')
            if (!(await exists(mfPath))) throw new Error('缺少 manifest.json')
            const raw = JSON.parse(await readTextFile(mfPath))
            const err = validateManifest(raw)
            if (err) throw new Error(err)
            item.manifest = raw as PluginManifest
            if (
              item.manifest.minAppVersion &&
              compareVersions(APP_VERSION, item.manifest.minAppVersion) < 0
            )
              throw new Error(`需要 bmd ≥ ${item.manifest.minAppVersion}（当前 ${APP_VERSION}）`)
            if (!(await exists(await join(dir, 'main.js')))) throw new Error('缺少 main.js')
          } catch (e) {
            item.error = e instanceof Error ? e.message : String(e)
          }
          out.push(item)
        }
        this.installed = out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
      } catch (e) {
        console.warn('[bmd] 插件扫描失败', e)
      } finally {
        this.scanning = false
      }
    },

    /** 启用并加载插件；失败时回滚启用状态并把原因写进 installed[].error */
    async enable(id: string) {
      if (!this.enabledIds.includes(id)) {
        this.enabledIds.push(id)
        localStorage.setItem('bmd.plugins.enabled', JSON.stringify(this.enabledIds))
      }
      await this.load(id)
    },

    async disable(id: string) {
      this.enabledIds = this.enabledIds.filter((x) => x !== id)
      localStorage.setItem('bmd.plugins.enabled', JSON.stringify(this.enabledIds))
      this.unload(id)
    },

    async load(id: string) {
      if (instances.has(id)) return
      const p = this.installed.find((x) => x.manifest.id === id)
      if (!p || p.error) return
      try {
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        const { join } = await import('@tauri-apps/api/path')
        const code = await readTextFile(await join(p.dir, 'main.js'))
        await this.loadFromSource(p.manifest, code)
      } catch (e) {
        p.error = `加载失败：${e instanceof Error ? e.message : e}`
        this.enabledIds = this.enabledIds.filter((x) => x !== id)
        localStorage.setItem('bmd.plugins.enabled', JSON.stringify(this.enabledIds))
        console.warn(`[bmd] 插件 ${id} 加载失败`, e)
      }
    },

    /** 从源码字符串装载插件（scan/load 的公共尾段；也便于单元测试） */
    async loadFromSource(manifest: PluginManifest, code: string) {
      const mod = await loadPluginModule(code)
      const offs: (() => void)[] = []
      const app = createPluginApp(this, manifest, offs)
      try {
        await mod.onload(app)
      } catch (e) {
        // onload 半途失败：回收已注册的贡献点，避免残留
        instances.set(manifest.id, { mod: { onload: () => {} }, offs })
        this.unload(manifest.id)
        throw e
      }
      instances.set(manifest.id, { mod, offs })
    },

    /** 卸载：调用 onunload → 取消事件订阅 → 移除全部 UI 贡献点 */
    unload(id: string) {
      const inst = instances.get(id)
      if (inst) {
        try {
          inst.mod.onunload?.()
        } catch (e) {
          console.warn(`[bmd] 插件 ${id} onunload 出错`, e)
        }
        for (const off of inst.offs) off()
        instances.delete(id)
      }
      this.ribbons = this.ribbons.filter((r) => r.pluginId !== id)
      this.statusItems = this.statusItems.filter((s) => s.pluginId !== id)
      this.commands = this.commands.filter((c) => c.pluginId !== id)
      this.settingTabs = this.settingTabs.filter((t) => t.pluginId !== id)
    },

    /** 全局快捷键钩子：命中插件命令热键则消费该事件 */
    handleKey(e: KeyboardEvent): boolean {
      for (const cmd of this.commands) {
        if (cmd.hotkey && matchHotkey(cmd.hotkey, e, isMac)) {
          e.preventDefault()
          try {
            cmd.callback()
          } catch (err) {
            console.warn(`[bmd] 插件命令 ${cmd.pluginId}:${cmd.id} 出错`, err)
          }
          return true
        }
      }
      return false
    },

    /** 应用卸载时释放宿主监听与插件实例；不改变用户的启用设置。 */
    dispose() {
      for (const id of [...instances.keys()]) this.unload(id)
      for (const stop of bridgeStops) stop()
      bridgeStops = []
      listeners.clear()
    },
  },
})

/** 为单个插件构造 API 实例；所有注册均打上 pluginId 以便禁用时回收 */
function createPluginApp(
  store: ReturnType<typeof usePlugins>,
  manifest: PluginManifest,
  offs: (() => void)[],
): BmdPluginApp {
  const id = manifest.id
  return {
    version: APP_VERSION,
    manifest,

    addRibbonIcon(opts) {
      store.ribbons.push({ pluginId: id, ...opts })
    },

    addStatusBarItem(opts) {
      const item: StatusItem = { id: ++statusSeq, pluginId: id, ...opts }
      store.statusItems.push(item)
      return {
        setText(text: string) {
          const t = store.statusItems.find((s) => s.id === item.id)
          if (t) t.text = text
        },
        remove() {
          store.statusItems = store.statusItems.filter((s) => s.id !== item.id)
        },
      }
    },

    addCommand(cmd) {
      store.commands.push({ pluginId: id, ...cmd })
    },

    addSettingTab(tab) {
      store.settingTabs.push({ pluginId: id, title: tab.title ?? manifest.name, render: tab.render })
    },

    notice: showNotice,

    getEditor() {
      const view = editorRegistry.getActiveView()
      if (!view) return null
      return {
        getValue: () => view.state.doc.toString(),
        getSelection: () => {
          const sel = view.state.selection.main
          return view.state.sliceDoc(sel.from, sel.to)
        },
        replaceSelection: (text: string) => {
          view.dispatch(view.state.replaceSelection(text))
        },
        insertAtCursor: (text: string) => {
          const pos = view.state.selection.main.head
          view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } })
        },
      }
    },

    getActiveFile() {
      const t = useTabs().active
      return t ? { path: t.path, title: t.title } : null
    },

    on(event, cb) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(cb)
      const off = () => set.delete(cb)
      offs.push(off)
      return off
    },

    loadData<T>() {
      try {
        return JSON.parse(localStorage.getItem(`bmd.plugin.${id}`) ?? 'null') as T | null
      } catch {
        return null
      }
    },

    saveData(data) {
      localStorage.setItem(`bmd.plugin.${id}`, JSON.stringify(data))
    },
  }
}
