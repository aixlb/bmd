<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { preheatRenderers } from '@core/index'
import EditorHost from './components/EditorHost.vue'
import Sidebar from './components/Sidebar.vue'
import StatusBar from './components/StatusBar.vue'
import TitleBar from './components/TitleBar.vue'
import { ipc } from '@/lib/ipc'
import { useShortcuts } from '@/lib/shortcuts'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

const tabs = useTabs()
const ui = useUi()
const workspace = useWorkspace()

useShortcuts()

let sessionTimer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  ui.applyTheme()
  ui.applyFontSize()
  preheatRenderers()

  // 外部变更 → 文件树刷新 + 打开文档的重载/冲突流（FR-05/21）
  void ipc().onFsChanged(async (paths) => {
    await workspace.refresh()
    await tabs.handleExternalChanges(paths)
  })

  const session = await ipc().loadSession()
  if (session?.root) await workspace.openFolder(session.root)
  if (session) await tabs.restoreSession(session)

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
    </div>
    <StatusBar />
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
</style>
