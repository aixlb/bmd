import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState, EditorSelection } from '@codemirror/state'
import { createMockIpc, setIpc, type AiEvent, type Ipc } from '../src/lib/ipc'
import { editorRegistry } from '../src/lib/editorRegistry'
import { useAi, BUILTIN_COMMANDS } from '../src/stores/ai'
import { useTabs } from '../src/stores/tabs'

let mock: Ipc

beforeEach(() => {
  setActivePinia(createPinia())
  editorRegistry.clear()
  localStorage.clear()
  mock = createMockIpc({ '/ws/a.md': '# 文档标题\n\n正文内容' })
  setIpc(mock)
})

describe('AI 对话链路（M5）', () => {
  it('发送 → 流式增量 → 完成；会话标题取自首条消息', async () => {
    const ai = useAi()
    mock.aiChat = vi.fn(async (_req, onEvent: (e: AiEvent) => void) => {
      onEvent({ type: 'delta', text: '你' })
      onEvent({ type: 'delta', text: '好' })
      onEvent({ type: 'done' })
    })
    ai.newSession()
    await ai.send('帮我写一段开头')
    const msgs = ai.current!.messages
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: '帮我写一段开头' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: '你好', streaming: false })
    expect(ai.current!.title).toBe('帮我写一段开头')
    expect(ai.busy).toBe(false)
  })

  it('错误事件呈现在消息上', async () => {
    const ai = useAi()
    mock.aiChat = vi.fn(async (_req, onEvent: (e: AiEvent) => void) => {
      onEvent({ type: 'error', message: 'HTTP 401: invalid key' })
    })
    ai.newSession()
    await ai.send('hi')
    expect(ai.current!.messages[1].error).toContain('401')
  })

  it('system 上下文携带当前文档与选区，可单独关闭', async () => {
    const ai = useAi()
    const tabs = useTabs()
    const tab = await tabs.openFile('/ws/a.md')
    editorRegistry.set(tab.id, EditorState.create({ doc: '# 文档标题\n\n正文内容' }))

    let system: string | null = null
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      system = req.system
      onEvent({ type: 'done' })
    })
    ai.newSession()
    await ai.send('问题')
    expect(system).toContain('文档标题')
    expect(system).toContain('a.md')

    ai.includeDoc = false
    await ai.send('问题2')
    expect(system).not.toContain('正文内容')
  })

  it('@文件引用被读入上下文', async () => {
    const ai = useAi()
    ai.mentionFiles = ['/ws/a.md']
    let system: string | null = null
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      system = req.system
      onEvent({ type: 'done' })
    })
    ai.includeDoc = false
    ai.newSession()
    await ai.send('引用测试')
    expect(system).toContain('引用文件 a.md')
    expect(system).toContain('正文内容')
  })

  it('快捷指令 {sel} 用选区填充', async () => {
    const ai = useAi()
    // 模拟一个带选区的活动视图
    const state = EditorState.create({
      doc: '这句话要润色',
      selection: EditorSelection.range(0, 6),
    })
    editorRegistry.setActiveView({ state } as never)

    let sent: string | null = null
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      sent = req.messages[req.messages.length - 1].content
      onEvent({ type: 'done' })
    })
    ai.newSession()
    await ai.runCommand(BUILTIN_COMMANDS.find((c) => c.id === 'polish')!)
    expect(sent).toContain('这句话要润')
  })

  it('停止生成：取消请求并结束流式态', async () => {
    const ai = useAi()
    const cancelSpy = vi.spyOn(mock, 'aiCancel')
    mock.aiChat = vi.fn(async (_req, onEvent: (e: AiEvent) => void) => {
      onEvent({ type: 'delta', text: '一半' })
      // 模拟悬挂的流：等取消
      await new Promise((r) => setTimeout(r, 50))
      onEvent({ type: 'done' })
    })
    ai.newSession()
    const p = ai.send('长任务')
    await new Promise((r) => setTimeout(r, 10))
    await ai.stop()
    expect(cancelSpy).toHaveBeenCalled()
    expect(ai.busy).toBe(false)
    await p
  })

  it('多会话并行提问：busy 按会话隔离，互不阻塞', async () => {
    const ai = useAi()
    // 每次 aiChat 挂起，等待测试手动派发事件
    const pending: Array<(e: AiEvent) => void> = []
    mock.aiChat = vi.fn(async (_req, onEvent: (e: AiEvent) => void) => {
      await new Promise<void>((resolve) => {
        pending.push((e) => {
          onEvent(e)
          if (e.type === 'done') resolve()
        })
      })
    })

    const s1 = ai.newSession()
    const p1 = ai.send('问题一')
    await new Promise((r) => setTimeout(r, 10))
    const s2 = ai.newSession()
    const p2 = ai.send('问题二')
    await new Promise((r) => setTimeout(r, 10))

    // 两个会话同时在等回复
    expect(s1.busy).toBe(true)
    expect(s2.busy).toBe(true)
    expect(pending).toHaveLength(2)

    // 后发的先完成，不影响先发的
    pending[1]({ type: 'delta', text: '答二' })
    pending[1]({ type: 'done' })
    await p2
    expect(s2.busy).toBe(false)
    expect(s1.busy).toBe(true)

    pending[0]({ type: 'delta', text: '答一' })
    pending[0]({ type: 'done' })
    await p1
    expect(s1.messages[1].content).toBe('答一')
    expect(s2.messages[1].content).toBe('答二')
  })

  it('删除进行中的会话会取消其请求', async () => {
    const ai = useAi()
    const cancelSpy = vi.spyOn(mock, 'aiCancel')
    mock.aiChat = vi.fn(async (_req, onEvent: (e: AiEvent) => void) => {
      await new Promise((r) => setTimeout(r, 50))
      onEvent({ type: 'done' })
    })
    const s = ai.newSession()
    const p = ai.send('长任务')
    await new Promise((r) => setTimeout(r, 10))
    ai.deleteSession(s.id)
    expect(cancelSpy).toHaveBeenCalled()
    expect(ai.sessions.find((x) => x.id === s.id)).toBeUndefined()
    await p
  })

  it('会话持久化过滤流式中间态', async () => {
    const ai = useAi()
    const saveSpy = vi.spyOn(mock, 'saveChats')
    ai.newSession()
    ai.current!.messages.push({ role: 'user', content: 'q' })
    ai.current!.messages.push({ role: 'assistant', content: '半截', streaming: true })
    await ai.persist()
    const saved = JSON.parse(saveSpy.mock.calls[0][1] as string)
    expect(saved.sessions[0].messages).toHaveLength(1)
  })

  it('自定义 provider 增删与激活回退', () => {
    const ai = useAi()
    ai.customProviders.push({
      id: 'custom-1',
      name: '中转',
      protocol: 'openai',
      baseUrl: 'https://x.dev/v1',
      model: 'm',
    })
    ai.saveCustomProviders()
    ai.selectProvider('custom-1')
    expect(ai.activeProvider.name).toBe('中转')

    ai.customProviders = []
    ai.saveCustomProviders()
    ai.selectProvider('claude')
    expect(ai.activeProvider.id).toBe('claude')
  })
})

describe('模型预设覆盖（kimi/minimax/glm/deepseek/claude/gpt）', () => {
  it('目标模型全部在预设列表且协议/端点正确', async () => {
    const { PRESET_PROVIDERS } = await import('../src/stores/ai')
    const byId = Object.fromEntries(PRESET_PROVIDERS.map((p) => [p.id, p]))

    // 目标清单逐一在列
    for (const id of ['kimi', 'minimax', 'glm', 'deepseek', 'claude', 'openai']) {
      expect(byId[id], `缺少预设 ${id}`).toBeTruthy()
      expect(byId[id].preset).toBe(true)
    }
    // Claude 走 Anthropic Messages，其余走 OpenAI 兼容
    expect(byId.claude.protocol).toBe('anthropic')
    for (const id of ['kimi', 'minimax', 'glm', 'deepseek', 'openai', 'qwen', 'ollama']) {
      expect(byId[id].protocol).toBe('openai')
    }
    // 端点归属正确（防手滑串门）
    expect(byId.kimi.baseUrl).toContain('moonshot')
    expect(byId.minimax.baseUrl).toContain('minimax')
    expect(byId.glm.baseUrl).toContain('bigmodel')
    expect(byId.deepseek.baseUrl).toContain('deepseek')
    expect(byId.claude.baseUrl).toContain('anthropic')
    expect(byId.openai.model).toContain('gpt')
    // id 唯一
    expect(new Set(PRESET_PROVIDERS.map((p) => p.id)).size).toBe(PRESET_PROVIDERS.length)
  })

  it('预设 provider 可直接激活并进入请求', async () => {
    const { useAi } = await import('../src/stores/ai')
    const ai = useAi()
    let usedProvider: string | null = null
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      usedProvider = req.provider.id
      onEvent({ type: 'delta', text: 'ok' })
      onEvent({ type: 'done' })
    })
    for (const id of ['minimax', 'kimi', 'glm', 'deepseek']) {
      ai.selectProvider(id)
      expect(ai.activeProvider.id).toBe(id)
      ai.newSession()
      await ai.send('测试')
      expect(usedProvider).toBe(id)
    }
  })
})
