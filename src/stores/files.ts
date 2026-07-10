import { defineStore } from 'pinia'
import { ipc } from '@/lib/ipc'
import { menu } from '@/lib/menuBus'
import { useTabs } from '@/stores/tabs'
import { useWorkspace } from '@/stores/workspace'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function reportError(title: string, error: unknown) {
  console.error(`[bmd] ${title}`, error)
  const m = menu()
  if (!m) return
  await m.askChoice(title, errorMessage(error), [
    { value: 'ok', label: '知道了', primary: true },
  ])
}

/** 文件系统事务入口：负责磁盘操作以及工作区、标签和预览状态的同步。 */
export const useFiles = defineStore('files', {
  actions: {
    async previewPath(path: string): Promise<boolean> {
      try {
        await useTabs().previewFile(path)
        return true
      } catch (error) {
        await reportError('预览文件失败', error)
        return false
      }
    },

    async openPath(path: string): Promise<boolean> {
      try {
        await useTabs().openFile(path)
        return true
      } catch (error) {
        await reportError('打开文件失败', error)
        return false
      }
    },

    async createEntry(parent: string, isDir: boolean): Promise<string | null> {
      const m = menu()
      if (!m) return null
      const name = await m.askText(
        isDir ? '新建文件夹' : '新建文件',
        isDir ? '新文件夹' : '未命名.md',
      )
      if (!name) return null
      try {
        const path = await ipc().createEntry(parent, name, isDir)
        await useWorkspace().refresh()
        if (!isDir) await useTabs().openFile(path)
        return path
      } catch (error) {
        await reportError(isDir ? '新建文件夹失败' : '新建文件失败', error)
        return null
      }
    },

    async renameEntry(
      path: string,
      isDir: boolean,
      currentName: string,
      requestedName?: string,
    ): Promise<string | null> {
      const name = requestedName?.trim()
      if (!name || name === currentName) return null
      const tabs = useTabs()
      try {
        if (!(await tabs.savePathPrefix(path, isDir))) {
          throw new Error('受影响的文件未能保存，已取消重命名')
        }
        const newPath = await ipc().renameEntry(path, name)
        await tabs.remapPathPrefix(path, newPath, isDir)
        await useWorkspace().refresh()
        return newPath
      } catch (error) {
        await reportError('重命名失败', error)
        return null
      }
    },

    async trashEntry(path: string, isDir: boolean, name: string): Promise<boolean> {
      if (!(await ipc().confirm(`把「${name}」移入回收站？`, '删除'))) return false
      const tabs = useTabs()
      try {
        // 等待已经开始的保存，避免删除完成后旧保存又把文件写回来。
        if (!(await tabs.awaitPathSaves(path, isDir))) {
          throw new Error('受影响的文件未能保存，已取消删除')
        }
        await ipc().trashEntry(path)
        tabs.forceClosePathPrefix(path, isDir)
        await useWorkspace().refresh()
        return true
      } catch (error) {
        await reportError('删除失败', error)
        return false
      }
    },
  },
})
