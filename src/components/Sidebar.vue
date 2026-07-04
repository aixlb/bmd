<script setup lang="ts">
import { ref, watch } from 'vue'
import FileNode from './FileNode.vue'
import Outline from './Outline.vue'
import { ipc, type SearchHit } from '@/lib/ipc'
import { keyHint } from '@/lib/shortcuts'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

const ui = useUi()
const workspace = useWorkspace()
const tabs = useTabs()
const resizing = ref(false)

/** 全文搜索：防抖后调用后端在整个工作区内匹配文件名与内容 */
const hits = ref<SearchHit[]>([])
const searching = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => workspace.filter,
  (raw) => {
    if (searchTimer) clearTimeout(searchTimer)
    const query = raw.trim()
    if (!query || !workspace.root) {
      hits.value = []
      searching.value = false
      return
    }
    searching.value = true
    searchTimer = setTimeout(async () => {
      try {
        const result = await ipc().searchText(workspace.root!, query, 50)
        // 输入可能已变化，丢弃过期结果
        if (workspace.filter.trim() === query) hits.value = result
      } finally {
        searching.value = false
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
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  e.preventDefault()
}
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

      <div class="tree">
        <template v-if="!workspace.root">
          <div class="empty">
            <p>还没有打开文件夹</p>
            <button class="primary" @click="workspace.openFolder()">打开文件夹</button>
            <p class="hint">{{ keyHint('⌘⇧O') }}</p>
          </div>
        </template>
        <template v-else-if="workspace.filter.trim()">
          <button v-for="h in hits" :key="h.path" class="hit" :title="h.path" @click="tabs.openFile(h.path)">
            <div class="hit-top">
              <span class="hit-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10" />
                  <path d="M7 15v-6l2 2l2 -2v6" />
                  <path d="M14 13l2 2l2 -2m-2 2v-6" />
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
          <div class="root-name" :title="workspace.root">{{ workspace.rootName }}</div>
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
  padding: 2px 10px 8px;
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
  padding: 4px 10px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--bmd-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
