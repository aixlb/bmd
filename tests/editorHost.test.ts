import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { EditorSelection } from '@codemirror/state'
import AiPanel from '../src/components/AiPanel.vue'
import EditorHost from '../src/components/EditorHost.vue'
import { editorRegistry } from '../src/lib/editorRegistry'
import { createMockIpc, setIpc } from '../src/lib/ipc'
import { useTabs } from '../src/stores/tabs'
import { useUi } from '../src/stores/ui'
import { useAi } from '../src/stores/ai'

let app: App<Element> | null = null
let root: HTMLDivElement | null = null
const Harness = defineComponent({
  components: { AiPanel, EditorHost },
  template: '<div><EditorHost /><AiPanel /></div>',
})

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  editorRegistry.clear()
  setIpc(
    createMockIpc({
      '/ws/a.md': '# 第一篇\n\n旧内容',
      '/ws/b.md': '# 第二篇\n\n新内容',
      '/ws/page.html': '<h1>HTML</h1>',
    }),
  )
  root = document.createElement('div')
  document.body.appendChild(root)
  app = createApp(Harness)
  app.use(pinia)
  app.mount(root)
})

afterEach(() => {
  app?.unmount()
  root?.remove()
  app = null
  root = null
  editorRegistry.clear()
})

describe('EditorHost 预览同步', () => {
  it('同一预览标签轮播 Markdown 时重建正文内容', async () => {
    const tabs = useTabs()
    const first = await tabs.previewFile('/ws/a.md')
    await nextTick()
    expect(editorRegistry.getDoc(first.id)).toBe('# 第一篇\n\n旧内容')

    const second = await tabs.previewFile('/ws/b.md')
    await nextTick()

    expect(second.id).toBe(first.id)
    expect(tabs.active?.title).toBe('b.md')
    expect(editorRegistry.getDoc(second.id)).toBe('# 第二篇\n\n新内容')
    expect(root?.querySelector('.cm-content')?.textContent).toContain('第二篇')
    expect(root?.querySelector('.cm-content')?.textContent).not.toContain('第一篇')
    expect(root?.querySelector('.ai-panel')).not.toBeNull()
    expect(root?.querySelector('.context-chips')?.textContent).toContain('b.md')
  })

  it('切到只读预览后丢弃上一文档尚未执行的字数与大纲任务', async () => {
    const tabs = useTabs()
    const ui = useUi()
    await tabs.previewFile('/ws/a.md')
    await nextTick()
    const view = editorRegistry.getActiveView()!
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '# 不应回写的大纲\n\n很多旧文字' },
      userEvent: 'external.audit',
    })

    const html = await tabs.previewFile('/ws/page.html')
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(html.kind).toBe('html')
    expect(ui.counts).toEqual({ words: 0, chars: 0 })
    expect(ui.outline).toEqual([])
  })

  it('AI 替换预览打开后切换文件，不会把旧建议写进新文档', async () => {
    const tabs = useTabs()
    const ai = useAi()
    const first = await tabs.previewFile('/ws/a.md')
    await nextTick()
    const view = editorRegistry.getActiveView()!
    view.dispatch({ selection: EditorSelection.range(2, 5) })
    ai.sessions = [{
      id: 'audit',
      title: '审计',
      messages: [{ role: 'assistant', content: 'AI 替换内容' }],
    }]
    ai.currentSessionId = 'audit'
    await nextTick()
    const replace = [...root!.querySelectorAll<HTMLButtonElement>('.apply button')]
      .find((button) => button.textContent === '替换选区')!
    replace.click()
    await nextTick()

    const second = await tabs.previewFile('/ws/b.md')
    await nextTick()
    const apply = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '应用替换')!
    apply.click()
    await nextTick()

    expect(second.id).toBe(first.id)
    expect(editorRegistry.getDoc(second.id)).toBe('# 第二篇\n\n新内容')
    expect(second.dirty).toBe(false)
  })
})
