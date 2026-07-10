<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { createBmdState, createPlainTextState, getOutline } from '@core/index'
import { editorRegistry } from '@/lib/editorRegistry'
import { ipc, isTauri } from '@/lib/ipc'
import { keyHint } from '@/lib/shortcuts'
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
let stopActiveWatch: (() => void) | null = null

function saveInBackground(tabId: string) {
  void tabs.saveTab(tabId).catch((e) => console.error('[bmd] 自动保存失败', e))
}

function openLink(url: string) {
  if (!/^https?:\/\//.test(url)) return
  if (isTauri) {
    void import('@tauri-apps/plugin-opener').then((m) => m.openUrl(url))
  } else {
    window.open(url, '_blank', 'noopener')
  }
}

/** 相对路径图片基于文档目录解析；Tauri 下走 asset 协议 */
function makeImageResolver(tabId: string) {
  return (src: string): string => {
    if (/^(https?:|data:|asset:)/.test(src)) return src
    const tabPath = tabs.tabs.find((tab) => tab.id === tabId)?.path ?? null
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
      if (tab?.dirty && tab.path && !tab.preview) saveInBackground(tabId)
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
function makePasteHandler(tabId: string) {
  return async (file: File): Promise<string | null> => {
    const path = tabs.tabs.find((tab) => tab.id === tabId)?.path ?? null
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

function buildState(tabId: string, doc: string, kind: 'md' | 'text'): EditorState {
  const config = {
    onViewUpdate: (u: ViewUpdate) => trackUpdate(tabId, u),
    onOpenLink: openLink,
    resolveImageSrc: makeImageResolver(tabId),
    onPasteImage: makePasteHandler(tabId),
  }
  return kind === 'md' ? createBmdState(doc, config) : createPlainTextState(doc, config)
}

/** 活动标签为 HTML：只读 iframe 预览，不进编辑器（不支持编辑） */
const htmlTab = computed(() => (tabs.active?.kind === 'html' ? tabs.active : null))

/** 活动标签为图片：只读 <img> 预览 */
const imageTab = computed(() => (tabs.active?.kind === 'image' ? tabs.active : null))

function syncActive() {
  if (!view) return
  // 收起上一个标签的状态；若有未存内容立即落盘（FR-19）
  if (currentTabId && editorRegistry.get(currentTabId)) {
    editorRegistry.set(currentTabId, view.state)
    const prev = tabs.tabs.find((t) => t.id === currentTabId)
    if (prev?.dirty && prev.path && !prev.preview) saveInBackground(currentTabId)
  }
  const tab = tabs.active
  if (!tab || (tab.kind !== 'md' && tab.kind !== 'text')) {
    currentTabId = null
    view.setState(EditorState.create({ doc: '' }))
    ui.outline = []
    if (tab) ui.counts = countWords('')
    return
  }
  let state = editorRegistry.get(tab.id)
  if (!state) {
    state = buildState(tab.id, tab.initialDoc ?? '', tab.kind)
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
    if (t.dirty && t.path && !t.preview) saveInBackground(t.id)
  }
}

onMounted(() => {
  view = new EditorView({ parent: host.value! })
  editorRegistry.setActiveView(view)
  stopActiveWatch = watch(
    () => [tabs.activeId, tabs.active?.kind] as const,
    syncActive,
    { immediate: true },
  )
  window.addEventListener('blur', saveAllDirty)
})

onBeforeUnmount(() => {
  window.removeEventListener('blur', saveAllDirty)
  stopActiveWatch?.()
  stopActiveWatch = null
  if (countTimer) clearTimeout(countTimer)
  if (outlineTimer) clearTimeout(outlineTimer)
  for (const timer of autosaveTimers.values()) clearTimeout(timer)
  autosaveTimers.clear()
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
    <div v-if="htmlTab" class="html-preview">
      <span class="preview-badge">HTML 预览 · 只读</span>
      <!-- key 含 mtime：外部修改文件后重建 iframe，协议端现读磁盘即拿到新内容 -->
      <iframe
        :key="`${htmlTab.id}:${htmlTab.mtimeMs ?? 0}`"
        class="preview-frame"
        sandbox="allow-scripts"
        v-bind="htmlTab.previewUrl ? { src: htmlTab.previewUrl } : { srcdoc: htmlTab.initialDoc ?? '' }"
      />
    </div>
    <div v-if="imageTab" class="image-preview">
      <span class="preview-badge">图片预览 · 只读</span>
      <!-- key 含 mtime：外部修改后重建 <img>，协议端现读磁盘即拿到新图 -->
      <img
        v-if="imageTab.previewUrl"
        :key="`${imageTab.id}:${imageTab.mtimeMs ?? 0}`"
        class="preview-img"
        :src="imageTab.previewUrl"
        :alt="imageTab.title"
      />
      <p v-else class="image-fallback">图片预览仅在桌面应用中可用</p>
    </div>
    <div v-show="tabs.active && !htmlTab && !imageTab" ref="host" class="editor-host" />
    <div v-if="!tabs.active" class="placeholder">
      <img class="mark-img" src="@/assets/editor-empty.png" alt="" draggable="false" />
      <p>打开文件（{{ keyHint('⌘O') }}）或新建（{{ keyHint('⌘N') }}）开始写作</p>
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

.html-preview {
  position: relative;
  height: 100%;
}

.preview-frame {
  display: block;
  width: 100%;
  height: 100%;
  background: #fff; /* 网页默认白底，与主题无关 */
  border: none;
}

.image-preview {
  position: relative;
  display: grid;
  place-items: center;
  height: 100%;
  overflow: auto;
  padding: 24px;
  /* 棋盘格底：透明图也能看清边界 */
  background:
    repeating-conic-gradient(color-mix(in srgb, var(--bmd-text) 5%, transparent) 0% 25%, transparent 0% 50%)
    0 0 / 22px 22px;
}

.preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 4px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.18);
}

.image-fallback {
  font-size: 12.5px;
  color: var(--bmd-text-faint);
}

.preview-badge {
  position: absolute;
  top: 10px;
  right: 14px;
  z-index: 10;
  padding: 3px 10px;
  font-size: 11.5px;
  color: var(--bmd-text-dim);
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 999px;
  opacity: 0.9;
  pointer-events: none;
  user-select: none;
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

/* 线稿空状态图（透明底墨迹 PNG）：暗色主题反相为浅色线条 */
.mark-img {
  width: 340px;
  max-width: 72%;
  opacity: 0.85;
  user-select: none;
  -webkit-user-drag: none;
}

[data-theme='dark'] .mark-img {
  filter: invert(1) hue-rotate(180deg);
}
</style>
