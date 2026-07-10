import { watch } from 'vue'
import { ipc } from '@/lib/ipc'
import type { useTabs } from '@/stores/tabs'
import type { useWorkspace } from '@/stores/workspace'

type TabsStore = ReturnType<typeof useTabs>
type WorkspaceStore = ReturnType<typeof useWorkspace>

/** 会话持久化控制器：语义状态变更防抖写入，关闭窗口前可显式 flush。 */
export function createSessionPersistence(tabs: TabsStore, workspace: WorkspaceStore) {
  let enabled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let writeChain: Promise<void> = Promise.resolve()

  const enqueue = () => {
    const snapshot = tabs.sessionSnapshot(workspace.root)
    const next = writeChain.catch(() => {}).then(() => ipc().saveSession(snapshot))
    writeChain = next
    return next
  }

  const schedule = () => {
    if (!enabled) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void enqueue().catch((e) => console.error('[bmd] 会话保存失败', e))
    }, 500)
  }

  const stopWatch = watch(
    () => [
      workspace.root,
      tabs.activeId,
      tabs.tabs.map((tab) => `${tab.id}\u0000${tab.path ?? ''}\u0000${tab.preview}`).join('\n'),
    ],
    schedule,
    { flush: 'sync' },
  )

  return {
    async start() {
      enabled = true
      await enqueue()
    },

    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (!enabled) return
      await enqueue()
    },

    dispose() {
      enabled = false
      if (timer) clearTimeout(timer)
      timer = null
      stopWatch()
    },
  }
}
