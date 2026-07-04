<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { isTauri } from '@/lib/ipc'
import { isMac, keyHint } from '@/lib/shortcuts'

const tabs = useTabs()
const ui = useUi()
// macOS Overlay 模式保留原生红绿灯，左侧让位
const trafficLightPad = isTauri && isMac
// Windows/Linux 无边框窗口：自绘窗口控制按钮（参考 v2script TitleBar）
const showWinControls = isTauri && !isMac
const maximized = ref(false)
let win: Awaited<ReturnType<typeof getWin>> | null = null

async function getWin() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

onMounted(async () => {
  if (!showWinControls) return
  win = await getWin()
  maximized.value = await win.isMaximized()
  void win.onResized(async () => {
    maximized.value = (await win?.isMaximized()) ?? false
  })
})

function winMinimize() {
  void win?.minimize()
}
function winToggleMax() {
  void win?.toggleMaximize()
}
function winClose() {
  void win?.close()
}
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <div v-if="trafficLightPad" class="traffic-pad" data-tauri-drag-region />
    <span v-else class="brand" data-tauri-drag-region>bmd</span>

    <div class="tabs" role="tablist">
      <button
        v-for="t in tabs.tabs"
        :key="t.id"
        class="tab"
        :class="{ active: t.id === tabs.activeId }"
        role="tab"
        :aria-selected="t.id === tabs.activeId"
        :title="t.path ?? t.title"
        @click="tabs.activate(t.id)"
        @auxclick.middle.prevent="tabs.closeTab(t.id)"
      >
        <span class="tab-title">{{ t.title }}</span>
        <span v-if="t.dirty" class="dot" aria-label="未保存">●</span>
        <span class="close" aria-label="关闭" @click.stop="tabs.closeTab(t.id)">×</span>
      </button>
      <button class="new-tab" :title="`新建文件 (${keyHint('⌘N')})`" @click="tabs.newFile()">+</button>
    </div>

    <div class="drag-fill" data-tauri-drag-region />

    <div class="tools">
      <button :title="`明暗切换 ${keyHint('⌘⇧L')}`" @click="ui.toggleTheme()">◐</button>
      <button :title="`设置 ${keyHint('⌘,')}`" @click="ui.settingsVisible = true">⚙</button>
    </div>

    <div v-if="showWinControls" class="win-controls">
      <button class="wc" title="最小化" @click="winMinimize">
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
          <path d="M0.5 5h9" />
        </svg>
      </button>
      <button class="wc" :title="maximized ? '还原' : '最大化'" @click="winToggleMax">
        <svg v-if="maximized" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
          <path d="M2.5 2.5V1a0.5 0.5 0 0 1 0.5-0.5h6a0.5 0.5 0 0 1 0.5 0.5v6a0.5 0.5 0 0 1-0.5 0.5H7.5" />
          <rect x="0.5" y="2.5" width="7" height="7" rx="0.5" />
        </svg>
        <svg v-else viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
          <rect x="0.5" y="0.5" width="9" height="9" rx="0.5" />
        </svg>
      </button>
      <button class="wc wc-close" title="关闭" @click="winClose">
        <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.1">
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  height: 42px;
  padding: 0 10px;
  gap: 8px;
  background: color-mix(in srgb, var(--bmd-panel) 82%, transparent);
  border-bottom: 1px solid var(--bmd-border);
  user-select: none;
}

.traffic-pad {
  width: 72px;
  flex: none;
}

.brand {
  flex: none;
  font-weight: 700;
  font-size: 14px;
  padding: 0 6px;
  background: var(--bmd-accent-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  max-width: 70%;
}

.tabs::-webkit-scrollbar {
  display: none;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 180px;
  padding: 5px 8px 5px 12px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text-dim);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: default;
  white-space: nowrap;
  transition: background 120ms, color 120ms;
}

.tab:hover {
  background: color-mix(in srgb, var(--bmd-text) 6%, transparent);
}

.tab.active {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 9%, transparent);
  border-color: var(--bmd-border);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.dot {
  color: var(--bmd-accent);
  font-size: 9px;
}

.close {
  width: 16px;
  height: 16px;
  line-height: 15px;
  text-align: center;
  border-radius: 4px;
  color: var(--bmd-text-faint);
  visibility: hidden;
}

.tab:hover .close,
.tab.active .close {
  visibility: visible;
}

.close:hover {
  background: color-mix(in srgb, var(--bmd-text) 12%, transparent);
  color: var(--bmd-text);
}

.new-tab {
  flex: none;
  width: 24px;
  height: 24px;
  font: inherit;
  font-size: 15px;
  color: var(--bmd-text-faint);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.new-tab:hover {
  background: color-mix(in srgb, var(--bmd-text) 8%, transparent);
  color: var(--bmd-text);
}

.drag-fill {
  flex: 1;
  height: 100%;
}

.tools {
  display: flex;
  gap: 2px;
  flex: none;
}

.tools button {
  width: 28px;
  height: 28px;
  font: inherit;
  font-size: 14px;
  color: var(--bmd-text-faint);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
}

.tools button:hover {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 8%, transparent);
}

.win-controls {
  display: flex;
  gap: 2px;
  flex: none;
  margin-left: 6px;
  padding-left: 8px;
  border-left: 1px solid var(--bmd-border);
}

.wc {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 28px;
  color: var(--bmd-text-faint);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  transition: background 120ms, color 120ms;
}

.wc svg {
  width: 10px;
  height: 10px;
}

.wc:hover {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 8%, transparent);
}

.wc-close:hover {
  color: #ff6b6b;
  background: color-mix(in srgb, #e5484d 18%, transparent);
}
</style>
