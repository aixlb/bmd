<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import FileNode from './FileNode.vue'
import Outline from './Outline.vue'
import { ipc, nextSearchRequestId, type SearchHit } from '@/lib/ipc'
import { menu, type MenuItem } from '@/lib/menuBus'
import { keyHint } from '@/lib/shortcuts'
import { useTabs } from '@/stores/tabs'
import { useFiles } from '@/stores/files'
import { useUi } from '@/stores/ui'
import { useWorkspace, type FileSortMode } from '@/stores/workspace'

const ui = useUi()
const workspace = useWorkspace()
const tabs = useTabs()
const files = useFiles()
const resizing = ref(false)
const singleFileTab = computed(() => (!workspace.root ? (tabs.active ?? tabs.tabs[0] ?? null) : null))

/** 全文搜索：防抖后调用后端在整个工作区内匹配文件名与内容 */
const hits = ref<SearchHit[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null
let hitClickTimer: ReturnType<typeof setTimeout> | null = null
let searchRequestId = 0

watch(
  () => workspace.filter,
  (raw) => {
    const requestId = nextSearchRequestId()
    searchRequestId = requestId
    void ipc().cancelSearch(requestId).catch((e) => console.warn('[bmd] 取消旧搜索失败', e))
    if (searchTimer) clearTimeout(searchTimer)
    const query = raw.trim()
    if (!query || !workspace.root) {
      hits.value = []
      searching.value = false
      return
    }
    searching.value = true
    searchTimer = setTimeout(async () => {
      const root = workspace.root
      if (!root || requestId !== searchRequestId) return
      try {
        const result = await ipc().searchText(root, query, 50, requestId)
        // 输入可能已变化，丢弃过期结果
        if (requestId === searchRequestId && workspace.filter.trim() === query) hits.value = result
      } catch (e) {
        if (requestId === searchRequestId) console.warn('[bmd] 全文搜索失败', e)
      } finally {
        if (requestId === searchRequestId) searching.value = false
      }
    }, 220)
  },
)

/** 预览行按关键词切段，命中段高亮 */
function segments(text: string): { t: string; hl: boolean }[] {
  const q = workspace.filter.trim().toLowerCase()
  if (!q) return [{ t: text, hl: false }]
  const lower = text.toLowerCase()
  const out: { t: string; hl: boolean }[] = []
  let i = 0
  for (;;) {
    const idx = lower.indexOf(q, i)
    if (idx === -1) {
      if (i < text.length) out.push({ t: text.slice(i), hl: false })
      return out
    }
    if (idx > i) out.push({ t: text.slice(i, idx), hl: false })
    out.push({ t: text.slice(idx, idx + q.length), hl: true })
    i = idx + q.length
  }
}

function startResize(e: PointerEvent) {
  resizing.value = true
  const move = (ev: PointerEvent) => ui.setSidebarWidth(ev.clientX)
  const up = () => {
    resizing.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up) // 触摸中断等场景也要撤监听
  e.preventDefault()
}

async function openFile() {
  const path = await ipc().pickFile()
  if (path) await files.openPath(path)
}

async function createRootEntry(isDir: boolean) {
  if (!workspace.root) return
  await files.createEntry(workspace.root, isDir)
}

function sortLabel(mode = workspace.sortMode) {
  if (mode === 'nameAsc') return '名称升序'
  if (mode === 'nameDesc') return '名称降序'
  return '类型分组'
}

function showSortMenu(e: MouseEvent) {
  const m = menu()
  if (!m) return
  const item = (mode: FileSortMode): MenuItem => ({
    label: `${workspace.sortMode === mode ? '✓ ' : ''}${sortLabel(mode)}`,
    action: () => workspace.setSortMode(mode),
  })
  m.showMenu(e.clientX, e.clientY, [item('type'), item('nameAsc'), item('nameDesc')])
}

function onHitClick(path: string) {
  if (hitClickTimer) clearTimeout(hitClickTimer)
  hitClickTimer = setTimeout(() => {
    hitClickTimer = null
    void files.previewPath(path)
  }, 180)
}

function onHitDblClick(path: string) {
  if (hitClickTimer) {
    clearTimeout(hitClickTimer)
    hitClickTimer = null
  }
  void files.openPath(path)
}

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  if (hitClickTimer) clearTimeout(hitClickTimer)
  searchRequestId = nextSearchRequestId()
  void ipc().cancelSearch(searchRequestId)
})
</script>

<template>
  <aside class="sidebar" :style="{ width: `${ui.sidebarWidth}px` }">
    <div class="seg" role="tablist">
      <button
        :class="{ on: ui.sidebarView === 'files' }"
        role="tab"
        @click="ui.sidebarView = 'files'"
      >
        文件
      </button>
      <button
        :class="{ on: ui.sidebarView === 'outline' }"
        role="tab"
        @click="ui.sidebarView = 'outline'"
      >
        大纲
      </button>
    </div>

    <template v-if="ui.sidebarView === 'files'">
      <div v-if="workspace.root" class="filter">
        <input v-model="workspace.filter" placeholder="搜索文件名与全文…" spellcheck="false" />
      </div>

      <div v-if="workspace.root" class="file-toolbar">
        <div class="root-name" :title="workspace.root">{{ workspace.rootName }}</div>
        <div class="file-actions" aria-label="文件操作">
          <button title="新建文件" aria-label="新建文件" @click="createRootEntry(false)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
              <path d="M12 18v-6" />
              <path d="M9 15h6" />
            </svg>
          </button>
          <button title="新建文件夹" aria-label="新建文件夹" @click="createRootEntry(true)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              <path d="M12 11v6" />
              <path d="M9 14h6" />
            </svg>
          </button>
          <button :title="`排序：${sortLabel()}`" aria-label="排序" @click="showSortMenu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 5h10" />
              <path d="M11 12h7" />
              <path d="M11 19h4" />
              <path d="m3 17 3 3 3-3" />
              <path d="M6 18V4" />
            </svg>
          </button>
        </div>
      </div>

      <div class="tree">
        <template v-if="!workspace.root">
          <div v-if="singleFileTab" class="empty single-file">
            <img class="empty-img" src="@/assets/sidebar-empty.png" alt="" draggable="false" />
            <p>单文件模式</p>
            <strong :title="singleFileTab.path ?? singleFileTab.title">{{ singleFileTab.title }}</strong>
            <div class="empty-actions">
              <button @click="openFile()">打开文件</button>
              <button class="primary" @click="workspace.openFolder()">打开文件夹</button>
            </div>
          </div>
          <div v-else class="empty">
            <img class="empty-img" src="@/assets/sidebar-empty.png" alt="" draggable="false" />
            <p>还没有打开文件夹</p>
            <button class="primary" @click="workspace.openFolder()">打开文件夹</button>
            <p class="hint">{{ keyHint('⌘⇧O') }}</p>
          </div>
        </template>
        <template v-else-if="workspace.filter.trim()">
          <button
            v-for="h in hits"
            :key="h.path"
            class="hit"
            :title="h.path"
            @click="onHitClick(h.path)"
            @dblclick.prevent="onHitDblClick(h.path)"
          >
            <div class="hit-top">
              <span class="hit-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
                  <path d="M14 2v5a1 1 0 0 0 1 1h5" />
                  <path d="M8 13h8" />
                  <path d="M8 17h5" />
                </svg>
              </span>
              <span class="hit-name">
                <template v-for="(s, i) in segments(h.name)" :key="i"><mark v-if="s.hl">{{ s.t }}</mark><template v-else>{{ s.t }}</template></template>
              </span>
              <span v-if="h.count" class="hit-count">{{ h.count }}</span>
            </div>
            <div v-if="h.preview" class="hit-preview">
              <template v-for="(s, i) in segments(h.preview)" :key="i"><mark v-if="s.hl">{{ s.t }}</mark><template v-else>{{ s.t }}</template></template>
            </div>
          </button>
          <p v-if="searching && !hits.length" class="hint pad">搜索中…</p>
          <p v-else-if="!searching && !hits.length" class="hint pad">无匹配</p>
        </template>
        <template v-else>
          <FileNode v-for="e in workspace.rootEntries" :key="e.path" :entry="e" :depth="0" />
        </template>
      </div>
    </template>

    <Outline v-else />

    <div class="resize-handle" :class="{ resizing }" @pointerdown="startResize" />
  </aside>
</template>

<style scoped>
.sidebar {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: none;
  height: 100%;
  background: color-mix(in srgb, var(--bmd-panel) 62%, transparent);
  border-right: 1px solid var(--bmd-border);
}

.seg {
  display: flex;
  gap: 4px;
  margin: 10px 10px 6px;
  padding: 3px;
  background: color-mix(in srgb, var(--bmd-text) 5%, transparent);
  border-radius: 8px;
}

.seg button {
  flex: 1;
  padding: 4px 0;
  font: inherit;
  font-size: 12px;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 120ms, color 120ms;
}

.seg button.on {
  color: var(--bmd-text);
  background: var(--bmd-panel);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}

.filter {
  padding: 2px 10px 7px;
}

.filter input {
  width: 100%;
  padding: 5px 9px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 5%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  outline: none;
}

.filter input:focus {
  border-color: color-mix(in srgb, var(--bmd-accent-a) 55%, transparent);
}

.tree {
  flex: 1;
  overflow: auto;
  padding: 0 6px 12px;
}

.file-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 7px 10px;
}

.hit {
  display: block;
  width: 100%;
  padding: 6px 10px;
  font: inherit;
  text-align: left;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.hit:hover {
  background: color-mix(in srgb, var(--bmd-text) 6%, transparent);
}

.hit-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.hit-icon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--bmd-accent);
}

.hit-icon svg {
  width: 100%;
  height: 100%;
}

.hit-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--bmd-text);
}

.hit-count {
  flex: none;
  min-width: 18px;
  padding: 0 5px;
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
  color: var(--bmd-text-dim);
  background: color-mix(in srgb, var(--bmd-text) 8%, transparent);
  border-radius: 8px;
}

.hit-preview {
  margin: 2px 0 0 20px;
  font-size: 11.5px;
  color: var(--bmd-text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hit mark {
  color: var(--bmd-accent);
  background: color-mix(in srgb, var(--bmd-accent-a) 18%, transparent);
  border-radius: 2px;
}

.root-name {
  flex: 1;
  min-width: 0;
  padding: 2px 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--bmd-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-actions {
  display: flex;
  flex: none;
  gap: 3px;
}

.file-actions button {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--bmd-text-faint);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
}

.file-actions button:hover {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 6%, transparent);
  border-color: var(--bmd-border);
}

.file-actions svg {
  width: 15px;
  height: 15px;
}

.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--bmd-text-dim);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}

.empty-img {
  width: 150px;
  opacity: 0.9;
  user-select: none;
  -webkit-user-drag: none;
}

.empty.single-file strong {
  max-width: 100%;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  color: var(--bmd-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
}

.empty-actions button {
  padding: 6px 12px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 7%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 8px;
  cursor: pointer;
}

.empty-actions button.primary {
  color: #fff;
  background: var(--bmd-accent-gradient);
  border: none;
}

[data-theme='dark'] .empty-img {
  filter: invert(1) hue-rotate(180deg);
}

.primary {
  padding: 6px 14px;
  font: inherit;
  font-size: 13px;
  color: #fff;
  background: var(--bmd-accent-gradient);
  border: none;
  border-radius: 8px;
  cursor: pointer;
}

.primary:hover {
  filter: brightness(1.08);
}

.hint {
  font-size: 11.5px;
  color: var(--bmd-text-faint);
}

.pad {
  padding: 8px 12px;
}

.resize-handle {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}

.resize-handle:hover,
.resize-handle.resizing {
  background: color-mix(in srgb, var(--bmd-accent-a) 35%, transparent);
}
</style>
