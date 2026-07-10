<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAi } from '@/stores/ai'
import { useTabs, type Tab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { isTauri } from '@/lib/ipc'
import { menu, type MenuItem } from '@/lib/menuBus'
import { isMac, keyHint } from '@/lib/shortcuts'

const ai = useAi()
const tabs = useTabs()
const ui = useUi()
const emit = defineEmits<{ requestClose: [] }>()
// macOS Overlay 模式保留原生红绿灯，左侧让位
const trafficLightPad = isTauri && isMac
// Windows/Linux 无边框窗口：自绘窗口控制按钮（参考 v2script TitleBar）
const showWinControls = isTauri && !isMac
const maximized = ref(false)
let win: Awaited<ReturnType<typeof getWin>> | null = null
let unlistenResize: (() => void) | null = null

async function getWin() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

onMounted(async () => {
  if (!showWinControls) return
  win = await getWin()
  maximized.value = await win.isMaximized()
  unlistenResize = await win.onResized(async () => {
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
  emit('requestClose')
}

// 标签溢出翻阅：« » 单向滚动；激活标签自动滚入可视区
const tabsEl = ref<HTMLElement | null>(null)
const canLeft = ref(false)
const canRight = ref(false)

function updateArrows() {
  const el = tabsEl.value
  canLeft.value = !!el && el.scrollLeft > 1
  canRight.value = !!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}

function scrollTabs(dir: 1 | -1) {
  const el = tabsEl.value
  if (!el) return
  el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' })
}

onMounted(() => {
  updateArrows()
  window.addEventListener('resize', updateArrows)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateArrows)
  unlistenResize?.()
})

watch(
  () => [tabs.tabs.length, tabs.activeId] as const,
  async () => {
    await nextTick()
    updateArrows()
    tabsEl.value
      ?.querySelector('.tab.active')
      ?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  },
)

// 标签右键菜单：关闭当前 / 左侧 / 右侧 / 其他（不适用的项不显示）
function onTabContextMenu(e: MouseEvent, t: Tab) {
  const m = menu()
  if (!m) return
  const idx = tabs.tabs.findIndex((x) => x.id === t.id)
  const items: MenuItem[] = [{ label: '关闭', action: () => void tabs.closeTab(t.id) }]
  if (idx > 0) items.push({ label: '关闭左侧文件', action: () => void tabs.closeLeft(t.id) })
  if (idx < tabs.tabs.length - 1)
    items.push({ label: '关闭右侧文件', action: () => void tabs.closeRight(t.id) })
  if (tabs.tabs.length > 1)
    items.push({ label: '关闭其他文件', action: () => void tabs.closeOthers(t.id) })
  m.showMenu(e.clientX, e.clientY, items)
}
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <div v-if="trafficLightPad" class="traffic-pad" data-tauri-drag-region />
    <span v-else class="brand" data-tauri-drag-region>bmd</span>

    <div class="tabs-wrap">
      <button
        v-if="canLeft || canRight"
        class="tab-scroll"
        :disabled="!canLeft"
        title="向左翻阅标签"
        @click="scrollTabs(-1)"
      >
        «
      </button>
      <div ref="tabsEl" class="tabs" role="tablist" @scroll.passive="updateArrows">
      <button
        v-for="t in tabs.tabs"
        :key="t.id"
        class="tab"
        :class="{ active: t.id === tabs.activeId, preview: t.preview }"
        role="tab"
        :aria-selected="t.id === tabs.activeId"
        :title="t.preview ? `${t.path ?? t.title}\n预览中，双击固定打开` : (t.path ?? t.title)"
        @click="tabs.activate(t.id)"
        @dblclick.prevent="tabs.confirmPreview(t.id)"
        @auxclick.middle.prevent="tabs.closeTab(t.id)"
        @contextmenu.prevent="onTabContextMenu($event, t)"
      >
        <span class="tab-title">{{ t.title }}</span>
        <span v-if="t.dirty" class="dot" aria-label="未保存">●</span>
        <span class="close" aria-label="关闭" @click.stop="tabs.closeTab(t.id)">×</span>
      </button>
      </div>
      <button
        v-if="canLeft || canRight"
        class="tab-scroll"
        :disabled="!canRight"
        title="向右翻阅标签"
        @click="scrollTabs(1)"
      >
        »
      </button>
      <button class="new-tab" :title="`新建文件 (${keyHint('⌘N')})`" @click="tabs.newFile()">+</button>
    </div>

    <div class="drag-fill" data-tauri-drag-region />

    <div class="tools">
      <button
        class="ai-toggle"
        :class="{ on: ai.panelVisible }"
        :title="`AI 助手 ${keyHint('⌘J')}`"
        @click="ai.toggle()"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 9 L5 7.5 L3.5 5 L7 6.2" />
          <path d="M19 9 L19 7.5 L20.5 5 L17 6.2" />
          <rect x="4.5" y="6" width="15" height="12" rx="5" />
          <circle cx="9.5" cy="11.5" r="0.6" fill="currentColor" />
          <circle cx="14.5" cy="11.5" r="0.6" fill="currentColor" />
          <path d="M10 14.6 Q11 15.6 12 14.6 Q13 15.6 14 14.6" />
          <path d="M12 6 L12 3.6" />
          <circle cx="12" cy="3" r="0.7" fill="currentColor" />
        </svg>
      </button>
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

.tabs-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 70%;
  min-width: 0;
}

.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  min-width: 0;
  flex: 0 1 auto;
}

.tab-scroll {
  flex: none;
  width: 20px;
  height: 24px;
  padding: 0;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: var(--bmd-text-faint);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.tab-scroll:hover:not(:disabled) {
  background: color-mix(in srgb, var(--bmd-text) 8%, transparent);
  color: var(--bmd-text);
}

.tab-scroll:disabled {
  opacity: 0.35;
  cursor: default;
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

.tab.preview .tab-title {
  font-style: italic;
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

.ai-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ai-toggle svg {
  width: 17px;
  height: 17px;
}

.ai-toggle.on {
  color: var(--bmd-accent-a, var(--bmd-accent));
  background: color-mix(in srgb, var(--bmd-accent-a, var(--bmd-accent)) 12%, transparent);
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
