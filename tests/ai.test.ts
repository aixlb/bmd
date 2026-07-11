import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { EditorState, EditorSelection } from '@codemirror/state'
import {
  createMockIpc,
  setIpc,
  type AiChatRequest,
  type AiEvent,
  type Ipc,
} from '../src/lib/ipc'
import { editorRegistry } from '../src/lib/editorRegistry'
import { useAi, BUILTIN_COMMANDS } from '../src/stores/ai'
import { useTabs } from '../src/stores/tabs'
import { useWorkspace } from '../src/stores/workspace'

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

  it('后端取消命令失败时仍立即停止本地流式状态', async () => {
    const ai = useAi()
    const session = ai.newSession()
    session.busy = true
    session.requestId = 'req-fail'
    session.messages.push({ role: 'assistant', content: '半截', streaming: true })
    mock.aiCancel = vi.fn(async () => {
      throw new Error('cancel unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await ai.stop(session.id)

    expect(session.busy).toBe(false)
    expect(session.requestId).toBeNull()
    expect(session.messages[0].streaming).toBe(false)
    warn.mockRestore()
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

  it('快速切换工作区时按任务快照保存旧根并加载目标根', async () => {
    const ai = useAi()
    useWorkspace().root = '/already-moved'
    ai.sessions = [{ id: 'a', title: 'A 会话', messages: [] }]
    ai.currentSessionId = 'a'
    ai.restored = true
    const saveSpy = vi.spyOn(mock, 'saveChats')
    const loadSpy = vi.spyOn(mock, 'loadChats').mockImplementation(async (root) =>
      JSON.stringify({
        sessions: [{ id: 'b', title: `${root} 会话`, messages: [] }],
        current: 'b',
      }),
    )

    await ai.reloadForWorkspace('/workspace-a', '/workspace-b')

    expect(saveSpy).toHaveBeenCalledWith('/workspace-a', expect.any(String))
    expect(loadSpy).toHaveBeenCalledWith('/workspace-b')
    expect(ai.current?.title).toBe('/workspace-b 会话')
  })

  it('工作区切换会停止旧请求、清空旧引用，且不会把旧会话写入新根', async () => {
    const ws = useWorkspace()
    ws.root = '/workspace-a'
    const ai = useAi()
    ai.restored = true
    ai.mentionFiles = ['/workspace-a/a.md']
    ai.newSession()
    let finishChat!: () => void
    let chatStarted!: () => void
    const entered = new Promise<void>((resolve) => (chatStarted = resolve))
    mock.aiChat = vi.fn(async () => {
      chatStarted()
      await new Promise<void>((resolve) => (finishChat = resolve))
    })
    mock.aiCancel = vi.fn(async () => finishChat())
    const saveSpy = vi.spyOn(mock, 'saveChats')

    const sending = ai.send('旧工作区问题')
    await entered
    ws.root = '/workspace-b'
    await ai.reloadForWorkspace('/workspace-a', '/workspace-b')
    await sending

    expect(mock.aiCancel).toHaveBeenCalledOnce()
    expect(ai.mentionFiles).toEqual([])
    expect(saveSpy.mock.calls.some(([root]) => root === '/workspace-b')).toBe(false)
    expect(saveSpy.mock.calls.some(([root]) => root === '/workspace-a')).toBe(true)
  })

  it('启动时较慢的全局会话恢复不能覆盖随后完成的工作区会话', async () => {
    const ws = useWorkspace()
    const ai = useAi()
    let releaseGlobal!: () => void
    let startedGlobal!: () => void
    const gate = new Promise<void>((resolve) => (releaseGlobal = resolve))
    const entered = new Promise<void>((resolve) => (startedGlobal = resolve))
    mock.loadChats = vi.fn(async (root) => {
      if (root === '__global__') {
        startedGlobal()
        await gate
        return JSON.stringify({
          sessions: [{ id: 'global', title: '全局旧会话', messages: [] }],
          current: 'global',
        })
      }
      return JSON.stringify({
        sessions: [{ id: 'workspace', title: '工作区会话', messages: [] }],
        current: 'workspace',
      })
    })

    const initialRestore = ai.restore()
    await entered
    ws.root = '/workspace-b'
    await ai.reloadForWorkspace(null, '/workspace-b')
    releaseGlobal()
    await initialRestore

    expect(ai.currentSessionId).toBe('workspace')
    expect(ai.current?.title).toBe('工作区会话')
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

describe('工具调用（Agent 循环，P1）', () => {
  it('完整循环：模型要求 read_doc → 结果回填 → 二轮作答', async () => {
    const ai = useAi()
    useWorkspace().root = '/ws'
    const seen: AiChatRequest[] = []
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      seen.push(req)
      if (seen.length === 1) {
        onEvent({ type: 'delta', text: '我看一下。' })
        onEvent({
          type: 'toolCalls',
          calls: [{ id: 't1', name: 'read_doc', arguments: '{"path":"a.md"}' }],
        })
        onEvent({ type: 'done' })
      } else {
        onEvent({ type: 'delta', text: '文档讲的是正文内容。' })
        onEvent({ type: 'done' })
      }
    })
    ai.newSession()
    await ai.send('a.md 讲了什么？')

    expect(seen[0].tools).toHaveLength(3)
    const assistant = ai.current!.messages[1]
    expect(assistant.content).toBe('我看一下。文档讲的是正文内容。')
    expect(assistant.steps).toHaveLength(1)
    expect(assistant.steps![0]).toMatchObject({ name: 'read_doc' })
    expect(assistant.steps![0].error).toBeUndefined()
    // 二轮请求历史：assistant 带 toolCalls，tool 结果配对 id 并含文件内容
    const toolMsg = seen[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg?.toolCallId).toBe('t1')
    expect(toolMsg?.content).toContain('正文内容')
    expect(seen[1].messages.find((m) => m.toolCalls)?.toolCalls?.[0].name).toBe('read_doc')
    expect(ai.busy).toBe(false)
  })

  it('路径逃逸：工具报错回填但循环不中断', async () => {
    const ai = useAi()
    useWorkspace().root = '/ws'
    const seen: AiChatRequest[] = []
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      seen.push(req)
      if (seen.length === 1) {
        onEvent({
          type: 'toolCalls',
          calls: [{ id: 'x1', name: 'read_doc', arguments: '{"path":"../机密.md"}' }],
        })
        onEvent({ type: 'done' })
      } else {
        onEvent({ type: 'delta', text: '读不到该文件。' })
        onEvent({ type: 'done' })
      }
    })
    ai.newSession()
    await ai.send('读一下上层目录的机密文件')
    const assistant = ai.current!.messages[1]
    expect(assistant.steps![0].error).toContain('越出工作区')
    expect(seen[1].messages.find((m) => m.role === 'tool')?.content).toContain('工具执行失败')
    expect(assistant.content).toBe('读不到该文件。')
  })

  it('未开工作区或关闭开关时不下发工具', async () => {
    const ai = useAi()
    let tools: unknown = 'sentinel'
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      tools = req.tools
      onEvent({ type: 'done' })
    })
    ai.newSession()
    await ai.send('无工作区')
    expect(tools).toBeUndefined()

    useWorkspace().root = '/ws'
    ai.toolsEnabled = false
    await ai.send('开关已关')
    expect(tools).toBeUndefined()
  })

  it('轮数上限：8 轮后不再下发工具，强制作答', async () => {
    const ai = useAi()
    useWorkspace().root = '/ws'
    let callCount = 0
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      callCount++
      if (req.tools?.length) {
        onEvent({
          type: 'toolCalls',
          calls: [{ id: `c${callCount}`, name: 'list_files', arguments: '{}' }],
        })
        onEvent({ type: 'done' })
      } else {
        onEvent({ type: 'delta', text: '基于已有信息作答。' })
        onEvent({ type: 'done' })
      }
    })
    ai.newSession()
    await ai.send('一直查下去')
    expect(callCount).toBe(9) // 8 轮带工具 + 1 轮强制作答
    expect(ai.current!.messages[1].steps).toHaveLength(8)
    expect(ai.current!.messages[1].content).toBe('基于已有信息作答。')
  })

  it('生成过程中切换模型不会让同一次 Agent 循环中途换端点', async () => {
    const ai = useAi()
    useWorkspace().root = '/ws'
    const providers: string[] = []
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      providers.push(req.provider.id)
      if (providers.length === 1) {
        ai.selectProvider('deepseek')
        onEvent({
          type: 'toolCalls',
          calls: [{ id: 'ls', name: 'list_files', arguments: '{}' }],
        })
      } else {
        onEvent({ type: 'delta', text: '完成' })
      }
      onEvent({ type: 'done' })
    })
    ai.newSession()

    await ai.send('查看工作区')

    expect(providers).toEqual(['claude', 'claude'])
    expect(ai.activeProviderId).toBe('deepseek')
  })

  it('识图附件：仅当前轮携带图片，历史不重发，落盘剥离为张数', async () => {
    const ai = useAi()
    const seen: AiChatRequest[] = []
    mock.aiChat = vi.fn(async (req, onEvent: (e: AiEvent) => void) => {
      seen.push(req)
      onEvent({ type: 'delta', text: '图里是一只猫' })
      onEvent({ type: 'done' })
    })
    ai.newSession()
    ai.attachImageData({ mediaType: 'image/png', dataB64: 'QUJD' })
    await ai.send('这是什么？')

    const wireUser = seen[0].messages[seen[0].messages.length - 1]
    expect(wireUser.images?.[0].dataB64).toBe('QUJD')
    expect(ai.pendingImages).toHaveLength(0)
    expect(ai.current!.messages[0].images).toHaveLength(1)

    // 第二轮提问：历史消息不重发图片数据
    await ai.send('继续')
    expect(seen[1].messages.every((m) => !m.images)).toBe(true)

    // 落盘：图片数据剥离，仅留张数
    const saveSpy = vi.spyOn(mock, 'saveChats')
    await ai.persist()
    const savedUser = JSON.parse(saveSpy.mock.calls[0][1] as string).sessions[0].messages[0]
    expect(savedUser.images).toBeUndefined()
    expect(savedUser.imageCount).toBe(1)
  })

  it('executeTool：列目录/搜索输出可读，越界与未知工具拒绝', async () => {
    const ai = useAi()
    useWorkspace().root = '/ws'
    const ls = await ai.executeTool({ id: '1', name: 'list_files', arguments: '{}' })
    expect(ls).toContain('a.md')
    const sr = await ai.executeTool({ id: '2', name: 'search_text', arguments: '{"query":"正文"}' })
    expect(sr).toContain('a.md')
    await expect(
      ai.executeTool({ id: '3', name: 'read_doc', arguments: '{"path":"../越界"}' }),
    ).rejects.toThrow()
    await expect(ai.executeTool({ id: '4', name: 'rm_rf', arguments: '{}' })).rejects.toThrow('未知工具')
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
