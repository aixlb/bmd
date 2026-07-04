import { defineStore } from 'pinia'
import { ipc, type AiProvider } from '@/lib/ipc'
import { editorRegistry } from '@/lib/editorRegistry'
import { useTabs } from '@/stores/tabs'
import { useWorkspace } from '@/stores/workspace'

// AI 写作助手状态（DESIGN.md §13.1/13.3）

export const PRESET_PROVIDERS: AiProvider[] = [
  { id: 'claude', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', preset: true },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', preset: true },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', preset: true },
  { id: 'kimi', name: 'Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', preset: true },
  { id: 'qwen', name: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', preset: true },
  { id: 'glm', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', preset: true },
  { id: 'ollama', name: 'Ollama 本地', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5', preset: true },
]

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: string
}

export interface ChatSession {
  id: string
  title: string
  messages: ChatMsg[]
}

export interface QuickCommand {
  id: string
  label: string
  /** {sel} 选区、{doc} 文档占位 */
  prompt: string
  builtin?: boolean
}

export const BUILTIN_COMMANDS: QuickCommand[] = [
  { id: 'continue', label: '续写', prompt: '请顺着当前文档的内容与风格继续写作。只输出续写的正文，不要解释。', builtin: true },
  { id: 'polish', label: '润色', prompt: '请润色以下内容，保持原意与 markdown 格式，只输出润色后的文本：\n\n{sel}', builtin: true },
  { id: 'translate', label: '翻译', prompt: '请把以下内容翻译成英文（若已是英文则译成中文），保持 markdown 格式，只输出译文：\n\n{sel}', builtin: true },
  { id: 'summarize', label: '总结', prompt: '请用要点总结当前文档的核心内容。', builtin: true },
  { id: 'outline', label: '生成大纲', prompt: '请为当前文档生成一份层级化的 markdown 大纲（只输出大纲）。', builtin: true },
]

const CONTEXT_CHAR_BUDGET = 24_000

function loadCustomProviders(): AiProvider[] {
  try {
    return JSON.parse(localStorage.getItem('bmd.ai.providers') ?? '[]')
  } catch {
    return []
  }
}

function loadCustomCommands(): QuickCommand[] {
  try {
    return JSON.parse(localStorage.getItem('bmd.ai.commands') ?? '[]')
  } catch {
    return []
  }
}

let seq = 0
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${++seq}`

export const useAi = defineStore('ai', {
  state: () => ({
    panelVisible: false,
    panelWidth: Number(localStorage.getItem('bmd.ai.width')) || 360,
    customProviders: loadCustomProviders(),
    activeProviderId: localStorage.getItem('bmd.ai.provider') ?? 'claude',
    customCommands: loadCustomCommands(),
    sessions: [] as ChatSession[],
    currentSessionId: null as string | null,
    busy: false,
    requestId: null as string | null,
    includeDoc: true,
    includeSelection: true,
    mentionFiles: [] as string[],
    providerModalVisible: false,
  }),

  getters: {
    providers(): AiProvider[] {
      return [...PRESET_PROVIDERS, ...this.customProviders]
    },
    activeProvider(): AiProvider {
      return this.providers.find((p) => p.id === this.activeProviderId) ?? PRESET_PROVIDERS[0]
    },
    commands(): QuickCommand[] {
      return [...BUILTIN_COMMANDS, ...this.customCommands]
    },
    current(): ChatSession | null {
      return this.sessions.find((s) => s.id === this.currentSessionId) ?? null
    },
  },

  actions: {
    toggle() {
      this.panelVisible = !this.panelVisible
    },

    setWidth(w: number) {
      this.panelWidth = Math.min(520, Math.max(280, w))
      localStorage.setItem('bmd.ai.width', String(this.panelWidth))
    },

    selectProvider(id: string) {
      this.activeProviderId = id
      localStorage.setItem('bmd.ai.provider', id)
    },

    saveCustomProviders() {
      localStorage.setItem('bmd.ai.providers', JSON.stringify(this.customProviders))
    },

    saveCustomCommands() {
      localStorage.setItem('bmd.ai.commands', JSON.stringify(this.customCommands))
    },

    newSession() {
      const s: ChatSession = { id: nextId('chat'), title: '新会话', messages: [] }
      this.sessions.unshift(s)
      this.currentSessionId = s.id
      // 返回响应式代理（而非原始对象），后续变更才能触发视图更新
      return this.sessions[0]
    },

    deleteSession(id: string) {
      this.sessions = this.sessions.filter((s) => s.id !== id)
      if (this.currentSessionId === id) this.currentSessionId = this.sessions[0]?.id ?? null
      void this.persist()
    },

    async restore() {
      const ws = useWorkspace()
      try {
        const raw = await ipc().loadChats(ws.root ?? '__global__')
        const data = JSON.parse(raw)
        if (Array.isArray(data?.sessions)) {
          this.sessions = data.sessions
          this.currentSessionId = data.current ?? this.sessions[0]?.id ?? null
        }
      } catch {
        // 无历史或损坏，忽略
      }
    },

    async persist() {
      const ws = useWorkspace()
      // 流式中间态不落盘
      const sessions = this.sessions.map((s) => ({
        ...s,
        messages: s.messages.filter((m) => !m.streaming),
      }))
      await ipc().saveChats(
        ws.root ?? '__global__',
        JSON.stringify({ sessions, current: this.currentSessionId }),
      )
    },

    /** 组装 system 上下文（DESIGN §13.3 预算与优先级：选区 > 文档 > @文件） */
    async buildSystem(): Promise<string | null> {
      const tabs = useTabs()
      const parts: string[] = [
        '你是 bmd Markdown 编辑器内置的写作助手。回答使用中文（除非用户要求其他语言）。涉及改写/续写时输出合法的 markdown 正文，不要用代码块包裹整体答案。',
      ]
      let budget = CONTEXT_CHAR_BUDGET

      const view = editorRegistry.getActiveView()
      const sel = view?.state.selection.main
      if (this.includeSelection && view && sel && !sel.empty) {
        const text = view.state.doc.sliceString(sel.from, sel.to).slice(0, budget)
        budget -= text.length
        parts.push(`【用户当前选中的文本】\n${text}`)
      }
      if (this.includeDoc && tabs.active) {
        const doc = (editorRegistry.getDoc(tabs.active.id) ?? tabs.active.initialDoc ?? '').slice(
          0,
          Math.max(0, budget),
        )
        budget -= doc.length
        parts.push(`【当前文档《${tabs.active.title}》】\n${doc}`)
      }
      for (const path of this.mentionFiles) {
        if (budget <= 0) break
        try {
          const { content } = await ipc().readDoc(path)
          const text = content.slice(0, Math.max(0, budget))
          budget -= text.length
          parts.push(`【引用文件 ${path.split('/').pop()}】\n${text}`)
        } catch {
          // 文件不可读，跳过
        }
      }
      return parts.join('\n\n')
    },

    async send(text: string) {
      if (this.busy || !text.trim()) return
      const session = this.current ?? this.newSession()
      if (session.messages.length === 0) {
        session.title = text.slice(0, 24)
      }
      session.messages.push({ role: 'user', content: text })
      session.messages.push({ role: 'assistant', content: '', streaming: true })
      // 经响应式代理操作，流式增量才会驱动界面
      const assistant = session.messages[session.messages.length - 1]

      this.busy = true
      this.requestId = nextId('req')
      const system = await this.buildSystem()
      // 历史裁剪：最近 12 条
      const history = session.messages
        .filter((m) => !m.streaming && !m.error)
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }))

      try {
        await ipc().aiChat(
          {
            requestId: this.requestId,
            provider: { ...this.activeProvider },
            system,
            messages: history,
          },
          (e) => {
            if (e.type === 'delta') assistant.content += e.text
            else if (e.type === 'error') {
              assistant.error = e.message
              assistant.streaming = false
            } else if (e.type === 'done') {
              assistant.streaming = false
            }
          },
        )
      } catch (err) {
        assistant.error = String(err)
      } finally {
        assistant.streaming = false
        this.busy = false
        this.requestId = null
        void this.persist()
      }
    },

    async stop() {
      if (this.requestId) await ipc().aiCancel(this.requestId)
      const streaming = this.current?.messages.find((m) => m.streaming)
      if (streaming) streaming.streaming = false
      this.busy = false
    },

    /** 快捷指令：填充 {sel}/{doc} 占位后发送 */
    async runCommand(cmd: QuickCommand) {
      const view = editorRegistry.getActiveView()
      const sel = view?.state.selection.main
      const selText = sel && !sel.empty ? view!.state.doc.sliceString(sel.from, sel.to) : ''
      if (cmd.prompt.includes('{sel}') && !selText) {
        await this.send(cmd.prompt.replace('{sel}', '（用户未选中文本，请基于当前文档处理）'))
        return
      }
      await this.send(cmd.prompt.replace('{sel}', selText))
    },
  },
})
