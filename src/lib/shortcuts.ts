// 应用级快捷键（REQUIREMENTS.md §3.8 的 M1 子集；编辑类快捷键在内核 keymap 中）
import { onBeforeUnmount, onMounted } from 'vue'
import { ipc } from '@/lib/ipc'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

export const isMac = navigator.platform.toUpperCase().includes('MAC')

export function useShortcuts() {
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
    if (!mod) return

    if (key >= '1' && key <= '9' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      const n = Number(key)
      tabs.activateIndex(n === 9 ? tabs.tabs.length - 1 : n - 1)
      return
    }

    switch (key) {
      case 's':
        e.preventDefault()
        if (tabs.activeId) await tabs.saveTab(tabs.activeId, { saveAs: e.shiftKey })
        break
      case 'n':
        if (e.shiftKey) return
        e.preventDefault()
        tabs.newFile()
        break
      case 'o': {
        e.preventDefault()
        if (e.shiftKey) {
          await workspace.openFolder()
        } else {
          const path = await ipc().pickFile()
          if (path) await tabs.openFile(path)
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
    }
  }

  onMounted(() => window.addEventListener('keydown', handle))
  onBeforeUnmount(() => window.removeEventListener('keydown', handle))
}
