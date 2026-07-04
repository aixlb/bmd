<script setup lang="ts">
import { computed, ref } from 'vue'
import FileNode from './FileNode.vue'
import Outline from './Outline.vue'
import type { Entry } from '@/lib/ipc'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

const ui = useUi()
const workspace = useWorkspace()
const resizing = ref(false)

/** 过滤模式：在所有已加载目录中按名称扁平匹配 */
const filtered = computed<Entry[]>(() => {
  const q = workspace.filter.trim().toLowerCase()
  if (!q) return []
  const out: Entry[] = []
  for (const entries of Object.values(workspace.children)) {
    for (const e of entries) {
      if (!e.isDir && e.name.toLowerCase().includes(q)) out.push(e)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
})

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
        <input v-model="workspace.filter" placeholder="过滤文件名…" spellcheck="false" />
      </div>

      <div class="tree">
        <template v-if="!workspace.root">
          <div class="empty">
            <p>还没有打开文件夹</p>
            <button class="primary" @click="workspace.openFolder()">打开文件夹</button>
            <p class="hint">⌘⇧O</p>
          </div>
        </template>
        <template v-else-if="workspace.filter.trim()">
          <FileNode v-for="e in filtered" :key="e.path" :entry="e" :depth="0" />
          <p v-if="!filtered.length" class="hint pad">无匹配（仅搜索已展开的目录）</p>
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
