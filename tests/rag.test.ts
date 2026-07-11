import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMockIpc, setIpc, type AiEvent, type Ipc } from '../src/lib/ipc'
import { editorRegistry } from '../src/lib/editorRegistry'
import { useAi } from '../src/stores/ai'
import { useWorkspace } from '../src/stores/workspace'

let mock: Ipc

beforeEach(() => {
  setActivePinia(createPinia())
  editorRegistry.clear()
  localStorage.clear()
  mock = createMockIpc({
    '/ws/主题笔记.md': '# 数据库设计\n\n索引与查询计划的要点。',
    '/ws/别的.md': '# 午餐\n\n牛肉面好吃。',
  })
  mock.pickFolder = async () => '/ws'
  setIpc(mock)
})

describe('RAG（M6/FR-39）', () => {
  it('开启 RAG：检索片段注入 system，来源记录可跳转', async () => {
    const ws = useWorkspace()
    await ws.openFolder()
    const ai = useAi()
    ai.ragEnabled = true
    ai.includeDoc = false

    let system: string | null = null
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      system = req.system
      onEvent({ type: 'done' })
    })
    const searchSpy = vi.spyOn(mock, 'ragSearch')
    const indexSpy = vi.spyOn(mock, 'ragIndex')

    ai.newSession()
    await ai.send('数据库设计怎么做')

    expect(indexSpy).toHaveBeenCalledWith('/ws', null)
    expect(searchSpy).toHaveBeenCalled()
    expect(system).toContain('工作区相关片段')
    expect(system).toContain('索引与查询计划')
    expect(ai.lastSources.length).toBeGreaterThan(0)
    expect(ai.lastSources[0].path).toBe('/ws/主题笔记.md')
  })

  it('关闭 RAG：不触发检索', async () => {
    const ws = useWorkspace()
    await ws.openFolder()
    const ai = useAi()
    ai.ragEnabled = false
    const searchSpy = vi.spyOn(mock, 'ragSearch')
    mock.aiChat = vi.fn(async (_req, onEvent: (e: AiEvent) => void) => onEvent({ type: 'done' }))
    ai.newSession()
    await ai.send('随便问问')
    expect(searchSpy).not.toHaveBeenCalled()
    expect(ai.lastSources).toEqual([])
  })

  it('嵌入配置持久化；索引在配置变化后重建', async () => {
    const ai = useAi()
    ai.setEmbed({ providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'bge-m3' })
    expect(JSON.parse(localStorage.getItem('bmd.ai.embed')!)).toMatchObject({ model: 'bge-m3' })
    expect(ai.ragIndexed).toBe(false)

    const ws = useWorkspace()
    await ws.openFolder()
    const indexSpy = vi.spyOn(mock, 'ragIndex')
    await ai.ensureIndex()
    expect(indexSpy).toHaveBeenCalledWith('/ws', expect.objectContaining({ model: 'bge-m3' }))
    expect(ai.ragIndexed).toBe(true)
    // 二次调用（未 force）跳过
    await ai.ensureIndex()
    expect(indexSpy).toHaveBeenCalledTimes(1)
  })

  it('损坏的嵌入配置不会阻断应用启动', () => {
    localStorage.setItem('bmd.ai.embed', '{bad json')
    setActivePinia(createPinia())
    expect(useAi().embed).toBeNull()
  })

  it('切换工作区时旧索引完成不会污染新工作区索引状态', async () => {
    const ws = useWorkspace()
    ws.root = '/workspace-a'
    const ai = useAi()
    let releaseOld!: () => void
    let startedOld!: () => void
    const gate = new Promise<void>((resolve) => (releaseOld = resolve))
    const entered = new Promise<void>((resolve) => (startedOld = resolve))
    const index = vi.fn(async (root: string) => {
      if (root === '/workspace-a') {
        startedOld()
        await gate
      }
      return { files: 0, chunks: 0, embedded: 0, skipped: 0 }
    })
    mock.ragIndex = index

    const oldIndex = ai.ensureIndex()
    await entered
    ws.root = '/workspace-b'
    await ai.reloadForWorkspace('/workspace-a', '/workspace-b')
    await ai.ensureIndex()
    releaseOld()
    await oldIndex

    expect(index.mock.calls.map(([root]) => root)).toEqual(['/workspace-a', '/workspace-b'])
    expect(ai.ragIndexed).toBe(true)
    expect(ai.ragIndexedRoot).toBe('/workspace-b')
    expect(ai.ragIndexing).toBe(false)
  })
})
