<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { createBmdState, getOutline } from '@core/index'
import { editorRegistry } from '@/lib/editorRegistry'
import { isTauri } from '@/lib/ipc'
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
  if (isTauri) {
    // M4 接 shell/opener 插件；当前静默忽略非法协议
    if (/^https?:\/\//.test(url)) void import('@tauri-apps/api/core').then(() => {})
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
    scheduleAutosave(tabId)
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

function buildState(tabId: string, doc: string, tabPath: string | null): EditorState {
  return createBmdState(doc, {
    onDocChanged: () => tabs.markDirty(tabId),
    onViewUpdate: (u) => trackUpdate(tabId, u),
    onOpenLink: openLink,
    resolveImageSrc: makeImageResolver(tabPath),
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
  max-width: 760px;
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
