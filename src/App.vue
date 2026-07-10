<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { ref } from 'vue'
import { preheatRenderers } from '@core/index'
import ActivityBar from './components/ActivityBar.vue'
import AiPanel from './components/AiPanel.vue'
import ContextMenu from './components/ContextMenu.vue'
import EditorHost from './components/EditorHost.vue'
import QuickOpen from './components/QuickOpen.vue'
import SettingsPanel from './components/SettingsPanel.vue'
import Sidebar from './components/Sidebar.vue'
import SkillModal from './components/SkillModal.vue'
import SplashScreen from './components/SplashScreen.vue'
import StatusBar from './components/StatusBar.vue'
import TitleBar from './components/TitleBar.vue'
import { isImagePath } from '@/lib/fileTypes'
import { ipc, isTauri } from '@/lib/ipc'
import { registerMenu } from '@/lib/menuBus'
import { createSessionPersistence } from '@/lib/sessionPersistence'
import { useShortcuts } from '@/lib/shortcuts'
import { useAi } from '@/stores/ai'
import { usePlugins } from '@/stores/plugins'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

const ai = useAi()
const plugins = usePlugins()
const tabs = useTabs()
const ui = useUi()
const workspace = useWorkspace()
const ctxMenu = ref<InstanceType<typeof ContextMenu> | null>(null)
const splashDone = ref(false)
const sessionPersistence = createSessionPersistence(tabs, workspace)

useShortcuts()

let closingWindow = false
let closeRequestPending = false
let runtimeDisposed = false
let unlistenCloseRequested: (() => void) | null = null
let unlistenDragDrop: (() => void) | null = null
let unlistenOpenFile: (() => void) | null = null
let unlistenFsChanged: (() => void) | null = null

let aiWorkspaceTask: Promise<void> = Promise.resolve()
const stopAiWorkspaceWatch = watch(
  () => workspace.root,
  (root, previousRoot) => {
    if (root === previousRoot) return
    aiWorkspaceTask = aiWorkspaceTask
      .catch(() => {})
      .then(() => ai.reloadForWorkspace(previousRoot, root))
      .catch((e) => console.warn('[bmd] 切换工作区时聊天存档迁移失败', e))
  },
  { flush: 'sync' },
)

function hasDirtyTabs() {
  return tabs.tabs.some((t) => t.dirty)
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (closingWindow || !hasDirtyTabs()) return
  e.preventDefault()
  e.returnValue = ''
}

function disposeRuntime() {
  if (runtimeDisposed) return
  runtimeDisposed = true
  window.removeEventListener('beforeunload', onBeforeUnload)
  unlistenCloseRequested?.()
  unlistenDragDrop?.()
  unlistenOpenFile?.()
  unlistenFsChanged?.()
  stopAiWorkspaceWatch()
  sessionPersistence.dispose()
  plugins.dispose()
  registerMenu(null)
}

async function requestWindowClose() {
  if (closingWindow || closeRequestPending) return
  closeRequestPending = true
  try {
    if (!(await tabs.confirmAllDirtyForClose())) return
    await aiWorkspaceTask
    try {
      await sessionPersistence.flush()
    } catch (e) {
      console.error('[bmd] 关闭前保存会话失败', e)
    }
    closingWindow = true
    disposeRuntime()
    if (isTauri) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().destroy()
    } else {
      window.close()
    }
  } finally {
    closeRequestPending = false
  }
}

function comparablePath(path: string) {
  const slash = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^[a-z]:/i.test(slash) ? slash.toLowerCase() : slash
}

function isInsideRoot(path: string, root: string | null) {
  if (!root) return false
  const p = comparablePath(path)
  const r = comparablePath(root)
  return p === r || p.startsWith(`${r}/`)
}

type IncomingKind = 'file' | 'dir' | 'unsupported'

/** 先探测目录，再按内容探测文本；因此带扩展名的目录与冷门文本格式都能正确分类。 */
async function classifyIncoming(path: string): Promise<IncomingKind> {
  try {
    await ipc().scanDir(path)
    return 'dir'
  } catch {
    // 不是目录，继续判断文件。
  }
  if (isImagePath(path)) return 'file'
  try {
    await ipc().readDoc(path)
    return 'file'
  } catch {
    return 'unsupported'
  }
}

/** 打开系统递来的路径（拖拽入窗 / 双击打开方式，FR-24）。 */
async function openIncoming(paths: string[], source: 'add' | 'system' = 'add') {
  const classified = await Promise.all(paths.map(async (path) => ({ path, kind: await classifyIncoming(path) })))
  const incomingFiles = classified.filter((item) => item.kind === 'file').map((item) => item.path)
  if (
    source === 'system' &&
    workspace.root &&
    incomingFiles.length === paths.length &&
    incomingFiles.length > 0 &&
    incomingFiles.every((path) => !isInsideRoot(path, workspace.root))
  ) {
    await workspace.clear()
  }
  for (const item of classified) {
    if (item.kind === 'file') {
      try {
        await tabs.openFile(item.path)
      } catch (e) {
        console.warn(`[bmd] 无法打开文件：${item.path}`, e)
      }
    } else if (item.kind === 'dir') {
      await workspace.openFolder(item.path)
    }
  }
}

onMounted(async () => {
  ui.applyTheme()
  ui.applyFontSize()
  ui.applyLineWidth()
  preheatRenderers()
  if (ctxMenu.value) registerMenu(ctxMenu.value)
  // 第三方插件：扫描目录并加载已启用项（FR 见 PLUGINS.md）
  void plugins.init().catch((e) => console.error('[bmd] 插件初始化失败', e))

  if (isTauri) {
    // 拖拽文件/文件夹入窗（FR-24）
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    unlistenDragDrop = await getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === 'drop') void openIncoming(e.payload.paths)
    })
    // 系统「打开方式」（macOS Apple Event / 启动参数）
    const { listen } = await import('@tauri-apps/api/event')
    unlistenOpenFile = await listen<string[]>('open-file', (e) => void openIncoming(e.payload, 'system'))

    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    unlistenCloseRequested = await getCurrentWindow().onCloseRequested(async (e) => {
      if (closingWindow) return
      e.preventDefault()
      await requestWindowClose()
    })
  }
  window.addEventListener('beforeunload', onBeforeUnload)

  // 外部变更 → 文件树刷新 + 打开文档的重载/冲突流（FR-05/21）
  unlistenFsChanged = await ipc().onFsChanged(async (paths) => {
    await workspace.refresh()
    await tabs.handleExternalChanges(paths)
    // RAG 增量同步（内容 hash 未变的文件在 Rust 侧跳过）
    if (ai.ragEnabled) void ai.ensureIndex(true)
  })

  // 先读取启动参数，再决定是否恢复上次工作区：
  // 若本次是从系统打开工作区外的单文件，进入无工作区的单文件窗口。
  const session = await ipc().loadSession()
  const argsPaths = await ipc().initialFiles()
  const argsClassified = await Promise.all(
    argsPaths.map(async (path) => ({ path, kind: await classifyIncoming(path) })),
  )
  const argsFiles = argsClassified.filter((item) => item.kind === 'file').map((item) => item.path)
  const standaloneLaunch =
    !!session?.root &&
    argsFiles.length === argsPaths.length &&
    argsFiles.length > 0 &&
    argsFiles.every((p) => !isInsideRoot(p, session.root))
  if (standaloneLaunch) {
    await workspace.clear()
    for (const p of argsFiles) await tabs.openFile(p)
  } else {
    if (session?.root) await workspace.openFolder(session.root)
    if (session) await tabs.restoreSession(session)
    if (argsPaths.length) await openIncoming(argsPaths)
  }

  // 启动状态完整恢复后立即写一次；后续语义变化由控制器防抖持久化。
  await sessionPersistence.start()
})

onBeforeUnmount(() => {
  disposeRuntime()
})
</script>

<template>
  <div class="app">
    <TitleBar @request-close="requestWindowClose" />
    <div class="body">
      <ActivityBar />
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
    <SkillModal />
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
