import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import FileNode from '../src/components/FileNode.vue'
import { createMockIpc, setIpc, type Entry } from '../src/lib/ipc'
import { useWorkspace } from '../src/stores/workspace'

let app: App<Element> | null = null
let root: HTMLDivElement | null = null
let pinia: ReturnType<typeof createPinia>

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  setIpc(createMockIpc())
  root = document.createElement('div')
  document.body.appendChild(root)
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
})

describe('FileNode 目录交互', () => {
  it('双击目录只执行一次展开，不会误触发重命名', async () => {
    const workspace = useWorkspace()
    const toggle = vi.spyOn(workspace, 'toggleDir').mockResolvedValue()
    const entry: Entry = {
      name: '章节',
      path: '/ws/章节',
      isDir: true,
      isMd: false,
      isText: false,
    }
    app = createApp(FileNode, { entry, depth: 0 })
    app.use(pinia)
    app.mount(root!)
    const button = root!.querySelector<HTMLButtonElement>('.node')!

    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }))
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    await nextTick()

    expect(toggle).toHaveBeenCalledOnce()
    expect(toggle).toHaveBeenCalledWith('/ws/章节')
    expect(root!.querySelector('.rename-input')).toBeNull()
  })
})
