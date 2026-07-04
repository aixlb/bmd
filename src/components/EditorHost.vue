<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { createBmdState, getOutline } from '@core/index'
import { editorRegistry } from '@/lib/editorRegistry'
import { ipc, isTauri } from '@/lib/ipc'
import { useTabs } from '@/stores/tabs'
import { countWords, useUi } from '@/stores/ui'

const host = ref<HTMLElement | null>(null)
const tabs = useTabs()
const ui = useUi()

let view: EditorView | null = null
let currentTabId: string | null = null
let countTimer: ReturnType<typeof setTimeout> | null = null
let outlineTimer: ReturnType<typeof setTimeout> | null = null
const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

function openLink(url: string) {
  if (!/^https?:\/\//.test(url)) return
  if (isTauri) {
    void import('@tauri-apps/plugin-opener').then((m) => m.openUrl(url))
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

/** 相对路径图片基于文档目录解析；Tauri 下走 asset 协议 */
function makeImageResolver(tabPath: string | null) {
  return (src: string): string => {
    if (/^(https?:|data:|asset:)/.test(src)) return src
    if (!isTauri || !tabPath) return src
    const dir = tabPath.slice(0, Math.max(tabPath.lastIndexOf('/'), tabPath.lastIndexOf('\\')))
    const abs = /^([a-zA-Z]:[\\/]|\/)/.test(src) ? src : `${dir}/${src}`
    // convertFileSrc 是同步纯函数，但模块是异步加载的；首帧后已预热
    return tauriConvert ? tauriConvert(abs) : src
  }
}

let tauriConvert: ((p: string) => string) | null = null
if (isTauri) {
  void import('@tauri-apps/api/core').then((m) => (tauriConvert = m.convertFileSrc))
}

function scheduleAutosave(tabId: string) {
  if (!ui.autosaveEnabled) return
  const prev = autosaveTimers.get(tabId)
  if (prev) clearTimeout(prev)
  autosaveTimers.set(
    tabId,
    setTimeout(() => {
      autosaveTimers.delete(tabId)
      const tab = tabs.tabs.find((t) => t.id === tabId)
      // 未命名文件不自动弹保存框（FR-22）
      if (tab?.dirty && tab.path) void tabs.saveTab(tabId)
    }, 800),
  )
}

function pushOutline(state: EditorState) {
  if (outlineTimer) clearTimeout(outlineTimer)
  outlineTimer = setTimeout(() => {
    ui.outline = getOutline(state)
  }, 200)
}

function trackUpdate(tabId: string, update: ViewUpdate) {
  if (update.docChanged) {
    editorRegistry.set(tabId, update.state)
    // 外部重载（fs-changed 静默刷新）不算用户编辑
    const external = update.transactions.every((tr) => tr.isUserEvent('external'))
    if (!external) {
      tabs.markDirty(tabId)
      scheduleAutosave(tabId)
    }
    pushOutline(update.state)
    if (countTimer) clearTimeout(countTimer)
    countTimer = setTimeout(() => {
      ui.counts = countWords(update.state.doc.toString())
    }, 300)
  }
  const head = update.state.selection.main.head
  const line = update.state.doc.lineAt(head)
  ui.cursor = { line: line.number, col: head - line.from + 1 }
  ui.cursorPos = head
}

/** 粘贴图片 → base64 → Rust 落盘 assets/，返回相对路径（FR-25/26） */
function makePasteHandler(tabPath: string | null) {
  return async (file: File): Promise<string | null> => {
    const path = tabPath ?? tabs.active?.path
    if (!path) return null // 未命名文件先保存才能贴图
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    const CHUNK = 0x8000
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
    }
    const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '')
    try {
      return await ipc().savePastedImage(path, btoa(bin), ext)
    } catch (e) {
      console.error('[bmd] 图片保存失败', e)
      return null
    }
  }
}

function buildState(tabId: string, doc: string, tabPath: string | null): EditorState {
  return createBmdState(doc, {
    onViewUpdate: (u) => trackUpdate(tabId, u),
    onOpenLink: openLink,
    resolveImageSrc: makeImageResolver(tabPath),
    onPasteImage: makePasteHandler(tabPath),
  })
}

function syncActive() {
  if (!view) return
  // 收起上一个标签的状态；若有未存内容立即落盘（FR-19）
  if (currentTabId && editorRegistry.get(currentTabId)) {
    editorRegistry.set(currentTabId, view.state)
    const prev = tabs.tabs.find((t) => t.id === currentTabId)
    if (prev?.dirty && prev.path) void tabs.saveTab(currentTabId)
  }
  const tab = tabs.active
  if (!tab) {
    currentTabId = null
    view.setState(EditorState.create({ doc: '' }))
    ui.outline = []
    return
  }
  let state = editorRegistry.get(tab.id)
  if (!state) {
    state = buildState(tab.id, tab.initialDoc ?? '', tab.path)
    tab.initialDoc = null
    editorRegistry.set(tab.id, state)
  }
  currentTabId = tab.id
  view.setState(state)
  ui.counts = countWords(state.doc.toString())
  pushOutline(state)
  view.focus()
}

function saveAllDirty() {
  for (const t of tabs.tabs) {
    if (t.dirty && t.path) void tabs.saveTab(t.id)
  }
}

onMounted(() => {
  view = new EditorView({ parent: host.value! })
  editorRegistry.setActiveView(view)
  watch(() => tabs.activeId, syncActive, { immediate: true })
  window.addEventListener('blur', saveAllDirty)
})

onBeforeUnmount(() => {
  window.removeEventListener('blur', saveAllDirty)
  editorRegistry.setActiveView(null)
  view?.destroy()
  view = null
})
</script>

<template>
  <main class="editor-wrap">
    <Transition name="banner">
      <div v-if="tabs.active?.conflict" class="conflict-banner">
        <span>⚠ 「{{ tabs.active.title }}」在磁盘上已被其他程序修改</span>
        <button @click="tabs.keepLocal(tabs.active!.id)">保留本地版本</button>
        <button @click="tabs.reloadFromDisk(tabs.active!.id)">加载磁盘版本</button>
      </div>
    </Transition>
    <div v-show="tabs.active" ref="host" class="editor-host" />
    <div v-if="!tabs.active" class="placeholder">
      <div class="mark">b</div>
      <p>打开文件（⌘O）或新建（⌘N）开始写作</p>
    </div>
  </main>
</template>

<style scoped>
.editor-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  background: var(--bmd-bg);
}

.conflict-banner {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: var(--bmd-panel);
  border: 1px solid color-mix(in srgb, var(--bmd-danger) 50%, transparent);
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
}

.conflict-banner button {
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 7%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 6px;
  cursor: pointer;
}

.conflict-banner button:hover {
  border-color: var(--bmd-text-faint);
}

.banner-enter-from,
.banner-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}

.banner-enter-active,
.banner-leave-active {
  transition: all 180ms ease;
}

.editor-host {
  height: 100%;
}

.editor-host :deep(.cm-editor) {
  height: 100%;
}

.editor-host :deep(.cm-scroller) {
  overflow: auto;
}

.editor-host :deep(.cm-content) {
  max-width: var(--bmd-line-width, 760px);
  margin: 0 auto;
  padding-left: 32px;
  padding-right: 32px;
}

.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--bmd-text-faint);
  font-size: 13.5px;
  user-select: none;
}

.mark {
  width: 84px;
  height: 84px;
  display: grid;
  place-items: center;
  font-size: 46px;
  font-weight: 800;
  color: #fff;
  background: var(--bmd-accent-gradient);
  border-radius: 22px;
  opacity: 0.9;
}
</style>
