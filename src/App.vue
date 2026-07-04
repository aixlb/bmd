<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { ref } from 'vue'
import { preheatRenderers } from '@core/index'
import AiPanel from './components/AiPanel.vue'
import ContextMenu from './components/ContextMenu.vue'
import EditorHost from './components/EditorHost.vue'
import QuickOpen from './components/QuickOpen.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import Sidebar from './components/Sidebar.vue'
import SplashScreen from './components/SplashScreen.vue'
import StatusBar from './components/StatusBar.vue'
import TitleBar from './components/TitleBar.vue'
import { ipc, isTauri } from '@/lib/ipc'
import { registerMenu } from '@/lib/menuBus'
import { useShortcuts } from '@/lib/shortcuts'
import { useAi } from '@/stores/ai'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

const ai = useAi()
const tabs = useTabs()
const ui = useUi()
const workspace = useWorkspace()
const ctxMenu = ref<InstanceType<typeof ContextMenu> | null>(null)
const splashDone = ref(false)

useShortcuts()

let sessionTimer: ReturnType<typeof setTimeout> | null = null

/** 打开系统递来的路径（拖拽入窗 / 双击打开方式，FR-24） */
async function openIncoming(paths: string[]) {
  for (const p of paths) {
    if (/\.(md|markdown)$/i.test(p)) {
      await tabs.openFile(p)
    } else if (!/\.\w+$/.test(p)) {
      await workspace.openFolder(p)
    }
  }
}

onMounted(async () => {
  ui.applyTheme()
  ui.applyFontSize()
  ui.applyLineWidth()
  preheatRenderers()
  if (ctxMenu.value) registerMenu(ctxMenu.value)

  if (isTauri) {
    // 拖拽文件/文件夹入窗（FR-24）
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    void getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === 'drop') void openIncoming(e.payload.paths)
    })
    // 系统「打开方式」（macOS Apple Event / 启动参数）
    const { listen } = await import('@tauri-apps/api/event')
    void listen<string[]>('open-file', (e) => void openIncoming(e.payload))
  }

  // 外部变更 → 文件树刷新 + 打开文档的重载/冲突流（FR-05/21）
  void ipc().onFsChanged(async (paths) => {
    await workspace.refresh()
    await tabs.handleExternalChanges(paths)
    // RAG 增量同步（内容 hash 未变的文件在 Rust 侧跳过）
    if (ai.ragEnabled) void ai.ensureIndex(true)
  })

  const session = await ipc().loadSession()
  if (session?.root) await workspace.openFolder(session.root)
  if (session) await tabs.restoreSession(session)

  // 「打开方式」启动参数（Windows/Linux）
  const argsFiles = (await ipc().initialFiles()).filter((p) => /\.(md|markdown)$/i.test(p))
  if (argsFiles.length) await openIncoming(argsFiles)

  // 会话持久化（FR-23）：根目录/打开的标签变化后落盘
  watch(
    () => [workspace.root, tabs.tabs.map((t) => t.path).join('\n'), tabs.activeId],
    () => {
      if (sessionTimer) clearTimeout(sessionTimer)
      sessionTimer = setTimeout(() => {
        ipc().saveSession(tabs.sessionSnapshot(workspace.root))
      }, 500)
    },
  )
})
</script>

<template>
  <div class="app">
    <TitleBar />
    <div class="body">
      <Transition name="sidebar">
        <Sidebar v-if="ui.sidebarVisible" />
      </Transition>
      <EditorHost />
      <Transition name="ai">
        <AiPanel v-if="ai.panelVisible" />
      </Transition>
    </div>
    <StatusBar />
    <SettingsPanel />
    <QuickOpen />
    <ContextMenu ref="ctxMenu" />
    <SplashScreen v-if="!splashDone" @done="splashDone = true" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.sidebar-enter-active,
.sidebar-leave-active {
  transition: margin-left 180ms cubic-bezier(0.25, 0.8, 0.35, 1), opacity 150ms;
}

.sidebar-enter-from,
.sidebar-leave-to {
  margin-left: calc(-1 * v-bind('ui.sidebarWidth + "px"'));
  opacity: 0;
}

.ai-enter-active,
.ai-leave-active {
  transition: margin-right 180ms cubic-bezier(0.25, 0.8, 0.35, 1), opacity 150ms;
}

.ai-enter-from,
.ai-leave-to {
  margin-right: calc(-1 * v-bind('ai.panelWidth + "px"'));
  opacity: 0;
}
</style>
