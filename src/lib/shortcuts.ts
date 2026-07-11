// 应用级快捷键（REQUIREMENTS.md §3.8；编辑类快捷键在内核 keymap 中）。
// 插件命令热键经 usePlugins().handleKey 优先分发。
import { onBeforeUnmount, onMounted } from 'vue'
import { toggleSourceMode } from '@core/index'
import { editorRegistry } from '@/lib/editorRegistry'
import { ipc } from '@/lib/ipc'
import { menu } from '@/lib/menuBus'
import { isMac } from '@/lib/platform'
import { useAi } from '@/stores/ai'
import { useFiles } from '@/stores/files'
import { usePlugins } from '@/stores/plugins'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

export { isMac, keyHint } from '@/lib/platform'

export function useShortcuts() {
  const ai = useAi()
  const plugins = usePlugins()
  const files = useFiles()
  const tabs = useTabs()
  const ui = useUi()
  const workspace = useWorkspace()

  async function handle(e: KeyboardEvent) {
    const mod = isMac ? e.metaKey : e.ctrlKey
    const key = e.key.toLowerCase()

    // Ctrl+Tab 标签轮换（两平台一致）
    if (e.ctrlKey && key === 'tab') {
      e.preventDefault()
      tabs.cycle(e.shiftKey ? -1 : 1)
      return
    }
    // 插件命令热键（app.addCommand 的 hotkey）
    if (plugins.handleKey(e)) return

    // Alt+1..9 标签直达（v1.0.3 起：Mod+数字让位给标题切换；9 恒为最后一个标签）
    // 用 e.code 判定：macOS 上 ⌥+数字的 e.key 是变音字符
    if (e.altKey && !mod && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      e.preventDefault()
      const n = Number(e.code.slice(5))
      tabs.activateIndex(n === 9 ? tabs.tabs.length - 1 : n - 1)
      return
    }
    if (!mod) return

    switch (key) {
      case 'p':
        e.preventDefault()
        ui.quickOpenVisible = true
        break
      case 'j':
        e.preventDefault()
        ai.toggle()
        break
      case ',':
        e.preventDefault()
        ui.settingsVisible = true
        break
      case 's':
        e.preventDefault()
        if (tabs.activeId) {
          try {
            await tabs.saveTab(tabs.activeId, { saveAs: e.shiftKey })
          } catch (error) {
            console.error('[bmd] 保存文件失败', error)
            await menu()?.askChoice(
              '保存文件失败',
              error instanceof Error ? error.message : String(error),
              [{ value: 'ok', label: '知道了', primary: true }],
            )
          }
        }
        break
      case 'n':
        if (e.shiftKey) return
        e.preventDefault()
        await tabs.newFile()
        break
      case 'o': {
        e.preventDefault()
        if (e.shiftKey) {
          await workspace.openFolder()
        } else {
          const path = await ipc().pickFile()
          if (path) await files.openPath(path)
        }
        break
      }
      case 'w':
        e.preventDefault()
        if (tabs.activeId) await tabs.closeTab(tabs.activeId)
        break
      case '\\':
        e.preventDefault()
        ui.toggleSidebar()
        break
      case 'l':
        if (!e.shiftKey) return
        e.preventDefault()
        ui.toggleTheme()
        break
      case '/': {
        e.preventDefault()
        if (tabs.active?.kind !== 'md') return
        const v = editorRegistry.getActiveView()
        if (v) toggleSourceMode(v)
        break
      }
      case '=':
      case '+':
        e.preventDefault()
        ui.zoom(1)
        break
      case '-':
        e.preventDefault()
        ui.zoom(-1)
        break
      case '0':
        e.preventDefault()
        ui.zoom(0)
        break
    }
  }

  onMounted(() => window.addEventListener('keydown', handle))
  onBeforeUnmount(() => window.removeEventListener('keydown', handle))
}
