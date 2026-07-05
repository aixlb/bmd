import { defineStore } from 'pinia'
import { ipc, type AiProvider, type EmbedConfig, type RagHit } from '@/lib/ipc'
import { editorRegistry } from '@/lib/editorRegistry'
import { useTabs } from '@/stores/tabs'
import { useWorkspace } from '@/stores/workspace'

// AI 写作助手状态（DESIGN.md §13.1/13.3）

export const PRESET_PROVIDERS: AiProvider[] = [
  { id: 'claude', name: 'Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5', preset: true },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', preset: true },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', preset: true },
  { id: 'kimi', name: 'Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', preset: true },
  { id: 'minimax', name: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2', preset: true },
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
  /** 运行时状态（不持久化）：本会话是否有进行中的请求 */
  busy?: boolean
  /** 运行时状态（不持久化）：进行中请求的 id，用于取消 */
  requestId?: string | null
  /** 运行时状态（不持久化）：本会话最近一次 RAG 检索来源 */
  sources?: RagHit[]
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
    /** 会话历史是否已从磁盘恢复过（防止面板反复挂载时覆盖运行中的会话） */
    restored: false,
    includeDoc: true,
    includeSelection: true,
    mentionFiles: [] as string[],
    providerModalVisible: false,
    skillModalVisible: false,
    // ---- RAG（M6/FR-39） ----
    ragEnabled: localStorage.getItem('bmd.ai.rag') === 'on',
    /** 嵌入模型配置；null = BM25 词法兜底 */
    embed: JSON.parse(localStorage.getItem('bmd.ai.embed') ?? 'null') as EmbedConfig | null,
    ragIndexing: false,
    ragIndexed: false,
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
    /** 当前会话是否有进行中的请求（busy 按会话隔离，互不阻塞） */
    busy(): boolean {
      return !!this.current?.busy
    },
    /** 当前会话最近一次 RAG 检索来源（按会话隔离，并行请求不串台） */
    lastSources(): RagHit[] {
      return this.current?.sources ?? []
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
      const target = this.sessions.find((s) => s.id === id)
      if (target?.requestId) void ipc().aiCancel(target.requestId)
      this.sessions = this.sessions.filter((s) => s.id !== id)
      if (this.currentSessionId === id) this.currentSessionId = this.sessions[0]?.id ?? null
      void this.persist()
    },

    async restore() {
      if (this.restored) return
      this.restored = true
      const ws = useWorkspace()
      try {
        const raw = await ipc().loadChats(ws.root ?? '__global__')
        const data = JSON.parse(raw)
        if (Array.isArray(data?.sessions)) {
          // 剥离历史数据里可能残留的运行时字段
          this.sessions = data.sessions.map((s: ChatSession) => ({
            id: s.id,
            title: s.title,
            messages: s.messages ?? [],
          }))
          this.currentSessionId = data.current ?? this.sessions[0]?.id ?? null
        }
      } catch {
        // 无历史或损坏，忽略
      }
    },

    /** 落盘；rootOverride 用于工作区切换时把会话写回旧工作区（undefined = 当前根） */
    async persist(rootOverride?: string | null) {
      const ws = useWorkspace()
      const root = rootOverride === undefined ? ws.root : rootOverride
      // 流式中间态与运行时字段不落盘
      const sessions = this.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        messages: s.messages.filter((m) => !m.streaming),
      }))
      await ipc().saveChats(
        root ?? '__global__',
        JSON.stringify({ sessions, current: this.currentSessionId }),
      )
    },

    /** 工作区切换（FR 修复 #7）：会话按旧根落盘，再按新根恢复，避免串档 */
    async reloadForWorkspace(prevRoot: string | null) {
      // 旧工作区进行中的请求全部取消
      for (const s of this.sessions) {
        if (s.requestId) void ipc().aiCancel(s.requestId)
        s.busy = false
        s.requestId = null
      }
      if (this.restored) {
        await this.persist(prevRoot)
      }
      this.sessions = []
      this.currentSessionId = null
      this.restored = false
      await this.restore()
      if (!this.sessions.length) this.newSession()
    },

    async toggleRag() {
      this.ragEnabled = !this.ragEnabled
      localStorage.setItem('bmd.ai.rag', this.ragEnabled ? 'on' : 'off')
      if (this.ragEnabled) await this.ensureIndex()
    },

    setEmbed(cfg: EmbedConfig | null) {
      this.embed = cfg
      localStorage.setItem('bmd.ai.embed', JSON.stringify(cfg))
      this.ragIndexed = false
    },

    async ensureIndex(force = false) {
      const ws = useWorkspace()
      if (!ws.root || this.ragIndexing || (this.ragIndexed && !force)) return
      this.ragIndexing = true
      try {
        await ipc().ragIndex(ws.root, this.embed)
        this.ragIndexed = true
      } catch (e) {
        console.warn('[bmd] RAG 索引失败', e)
      } finally {
        this.ragIndexing = false
      }
    },

    /** 组装 system 上下文（DESIGN §13.3 预算与优先级：选区 > 文档 > @文件 > RAG） */
    async buildSystem(query = '', session?: ChatSession): Promise<string | null> {
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

      // RAG 检索片段（FR-39）；来源挂在发起请求的会话上
      if (session) session.sources = []
      const ws = useWorkspace()
      if (this.ragEnabled && ws.root && query && budget > 500) {
        await this.ensureIndex()
        try {
          const hits = await ipc().ragSearch(ws.root, query, this.embed, 6)
          const active = tabs.active?.path
          const usable = hits.filter((h) => h.path !== active)
          if (usable.length) {
            if (session) session.sources = usable
            const block = usable
              .map((h) => `《${h.path.split('/').pop()} · ${h.heading}》\n${h.snippet}`)
              .join('\n---\n')
              .slice(0, Math.max(0, budget))
            parts.push(`【工作区相关片段（自动检索）】\n${block}`)
          }
        } catch (e) {
          console.warn('[bmd] RAG 检索失败', e)
        }
      }
      return parts.join('\n\n')
    },

    async send(text: string) {
      if (!text.trim()) return
      const session = this.current ?? this.newSession()
      if (session.busy) return
      if (session.messages.length === 0) {
        session.title = text.slice(0, 24)
      }
      session.messages.push({ role: 'user', content: text })
      session.messages.push({ role: 'assistant', content: '', streaming: true })
      // 经响应式代理操作，流式增量才会驱动界面
      const assistant = session.messages[session.messages.length - 1]

      session.busy = true
      const requestId = nextId('req')
      session.requestId = requestId
      const system = await this.buildSystem(text, session)
      // 历史裁剪：最近 12 条
      const history = session.messages
        .filter((m) => !m.streaming && !m.error)
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }))

      try {
        await ipc().aiChat(
          {
            requestId,
            provider: { ...this.activeProvider },
            system,
            messages: history,
          },
          (e) => {
            // 用户已「停止」后迟到的增量直接丢弃
            if (e.type === 'delta') {
              if (assistant.streaming) assistant.content += e.text
            } else if (e.type === 'error') {
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
        // 仅当仍是本请求时才清理，避免 stop 后新请求的状态被旧请求的 finally 误清
        if (session.requestId === requestId) {
          session.busy = false
          session.requestId = null
        }
        void this.persist()
      }
    },

    /** 停止指定会话的生成；缺省停止当前会话 */
    async stop(sessionId?: string) {
      const session = sessionId
        ? this.sessions.find((s) => s.id === sessionId)
        : this.current
      if (!session) return
      if (session.requestId) await ipc().aiCancel(session.requestId)
      const streaming = session.messages.find((m) => m.streaming)
      if (streaming) streaming.streaming = false
      session.busy = false
      session.requestId = null
    },

    /** 快捷指令：填充 {sel}/{doc} 占位后发送 */
    async runCommand(cmd: QuickCommand) {
      const view = editorRegistry.getActiveView()
      const sel = view?.state.selection.main
      const selText = sel && !sel.empty ? view!.state.doc.sliceString(sel.from, sel.to) : ''
      const tabs = useTabs()
      const docText = tabs.active
        ? (editorRegistry.getDoc(tabs.active.id) ?? tabs.active.initialDoc ?? '').slice(0, CONTEXT_CHAR_BUDGET)
        : ''
      const fill = (p: string) => p.replace('{doc}', docText)
      if (cmd.prompt.includes('{sel}') && !selText) {
        await this.send(fill(cmd.prompt).replace('{sel}', '（用户未选中文本，请基于当前文档处理）'))
        return
      }
      await this.send(fill(cmd.prompt).replace('{sel}', selText))
    },
  },
})
