import { defineStore } from 'pinia'
import {
  ipc,
  type AiImage,
  type AiProvider,
  type AiToolCall,
  type AiToolDef,
  type ChatWireMsg,
  type EmbedConfig,
  type RagHit,
  nextSearchRequestId,
} from '@/lib/ipc'
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

/** 一次工具调用的可视轨迹（随消息持久化；旧存档无此字段照常加载） */
export interface ToolStep {
  name: string
  /** 调用参数 JSON 原文 */
  args: string
  /** 结果摘要（截断展示用） */
  summary: string
  ms: number
  error?: string
}

export interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  error?: string
  /** 本条回复产生过的工具调用轨迹 */
  steps?: ToolStep[]
  /** 随消息发送的图片（识图）；仅会话内展示，落盘时剥离数据只留张数 */
  images?: AiImage[]
  /** 落盘保留的附图张数（数据已剥离） */
  imageCount?: number
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
/** 单个工具结果喂回模型的上限（字符） */
const TOOL_RESULT_BUDGET = 32_000
/** read_doc 单段返回长度（字符），超长带续读提示 */
const TOOL_READ_CHUNK = 32_000
/** 单次提问的最大工具轮数，超限后不再下发工具、强制作答 */
const MAX_TOOL_ROUNDS = 8

/** 只读三件套（docs/AI-TOOLS-DESIGN.md P1）：全部映射到现有 Rust 命令 */
export const TOOL_DEFS: AiToolDef[] = [
  {
    name: 'list_files',
    description:
      '列出工作区内某个目录下的文件与子目录。dir 传相对工作区根的路径，省略或传空表示根目录。',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string', description: '相对工作区根的目录路径，省略=根目录' } },
    },
  },
  {
    name: 'read_doc',
    description:
      '读取工作区内一个文本文件的内容。超长文件分段返回并附续读提示，可再次调用并传 offset 继续读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根的文件路径' },
        offset: { type: 'number', description: '起始字符偏移，续读时使用' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_text',
    description: '在工作区全部文档中按关键词搜索（匹配文件名与内容），返回命中文件、行号与命中次数。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
]

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
    /** 工具调用（Agent）：默认开，设置里可关（bmd.ai.tools=off） */
    toolsEnabled: localStorage.getItem('bmd.ai.tools') !== 'off',
    /** 待发送的识图附件（随下一条消息发出后清空） */
    pendingImages: [] as AiImage[],
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

    async restore(rootOverride?: string | null) {
      if (this.restored) return
      this.restored = true
      const ws = useWorkspace()
      const root = rootOverride === undefined ? ws.root : rootOverride
      try {
        const raw = await ipc().loadChats(root ?? '__global__')
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
      // 流式中间态与运行时字段不落盘；图片数据剥离（体积），只留张数标记
      const sessions = this.sessions.map((s) => ({
        id: s.id,
        title: s.title,
        messages: s.messages
          .filter((m) => !m.streaming)
          .map(({ images, ...m }) => (images?.length ? { ...m, imageCount: images.length } : m)),
      }))
      await ipc().saveChats(
        root ?? '__global__',
        JSON.stringify({ sessions, current: this.currentSessionId }),
      )
    },

    /** 工作区切换（FR 修复 #7）：会话按旧根落盘，再按新根恢复，避免串档 */
    async reloadForWorkspace(prevRoot: string | null, nextRoot: string | null) {
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
      await this.restore(nextRoot)
      if (!this.sessions.length) this.newSession()
    },

    async toggleRag() {
      this.ragEnabled = !this.ragEnabled
      localStorage.setItem('bmd.ai.rag', this.ragEnabled ? 'on' : 'off')
      if (this.ragEnabled) await this.ensureIndex()
    },

    toggleTools() {
      this.toolsEnabled = !this.toolsEnabled
      localStorage.setItem('bmd.ai.tools', this.toolsEnabled ? 'on' : 'off')
    },

    /** 附加图片（选图对话框路径 → base64）；失败抛错由调用方提示 */
    async attachImageFromPath(path: string) {
      const img = await ipc().readImageB64(path)
      this.pendingImages.push(img)
    },

    attachImageData(img: AiImage) {
      this.pendingImages.push(img)
    },

    /** 选图对话框 → 附加（AiPanel 附图按钮） */
    async pickAndAttachImage() {
      const path = await ipc().pickImage()
      if (!path) return
      try {
        await this.attachImageFromPath(path)
      } catch (e) {
        console.warn('[bmd] 附加图片失败', e)
      }
    },

    removePendingImage(index: number) {
      this.pendingImages.splice(index, 1)
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
    async buildSystem(query = '', session?: ChatSession, toolsActive = false): Promise<string | null> {
      const tabs = useTabs()
      const parts: string[] = [
        '你是 bmd Markdown 编辑器内置的写作助手。回答使用中文（除非用户要求其他语言）。涉及改写/续写时输出合法的 markdown 正文，不要用代码块包裹整体答案。',
      ]
      if (toolsActive) {
        parts.push(
          '你可以调用工具查阅当前工作区：list_files 列目录、read_doc 读文件、search_text 全文搜索。当问题涉及工作区内容时，先用工具获取事实依据再回答，并在答案中注明依据的文件；不要凭空猜测文件内容。',
        )
      }
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

    /** 执行一次模型发起的工具调用；路径一律经 canonInRoot 约束在工作区内 */
    async executeTool(call: AiToolCall): Promise<string> {
      const ws = useWorkspace()
      if (!ws.root) throw new Error('未打开工作区')
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.arguments || '{}')
      } catch {
        // 参数不是合法 JSON：按空参数处理，让具体工具报缺参错误
      }
      const api = ipc()
      if (call.name === 'list_files') {
        const dirArg = typeof args.dir === 'string' ? args.dir.replace(/\\/g, '/').replace(/^\.\/?|\/+$/g, '') : ''
        const target = await api.canonInRoot(ws.root, dirArg || '.')
        const entries = await api.scanDir(target)
        const label = dirArg || '（工作区根）'
        if (!entries.length) return `目录 ${label} 为空`
        // 条目直接给出相对工作区根的路径，可原样用于 read_doc/list_files
        const prefix = dirArg ? `${dirArg}/` : ''
        return (
          `目录 ${label} 的内容（路径可直接传给 read_doc / list_files）：\n` +
          entries
            .slice(0, 200)
            .map((e) => `${e.isDir ? '[目录]' : '[文件]'} ${prefix}${e.name}`)
            .join('\n')
        )
      }
      if (call.name === 'read_doc') {
        if (typeof args.path !== 'string' || !args.path) throw new Error('缺少 path 参数')
        let p: string
        try {
          p = await api.canonInRoot(ws.root, args.path)
        } catch (e) {
          throw new Error(`${e instanceof Error ? e.message : e}（提示：先用 list_files 确认确切路径）`)
        }
        const { content } = await api.readDoc(p)
        const offset =
          typeof args.offset === 'number' && args.offset > 0
            ? Math.min(Math.floor(args.offset), content.length)
            : 0
        const slice = content.slice(offset, offset + TOOL_READ_CHUNK)
        const end = offset + slice.length
        const more = end < content.length ? `；未完，可传 offset=${end} 续读` : ''
        return `《${args.path}》共 ${content.length} 字符，本段 [${offset}, ${end})${more}\n---\n${slice}`
      }
      if (call.name === 'search_text') {
        if (typeof args.query !== 'string' || !args.query.trim()) throw new Error('缺少 query 参数')
        const hits = await api.searchText(ws.root, args.query, 20, nextSearchRequestId(), 'ai')
        if (!hits.length) return '（无匹配）'
        return hits
          .map((h) => `${h.path}${h.line > 0 ? ` 第${h.line}行` : ''}（命中 ${h.count} 处）`)
          .join('\n')
      }
      throw new Error(`未知工具：${call.name}`)
    },

    async send(text: string) {
      if (!text.trim() && !this.pendingImages.length) return
      const session = this.current ?? this.newSession()
      if (session.busy) return
      if (session.messages.length === 0) {
        session.title = (text.trim() || '看图').slice(0, 24)
      }
      // 消费待发图片（识图）；仅当前这条 user 消息携带，不进后续历史
      const images = this.pendingImages.length ? [...this.pendingImages] : undefined
      this.pendingImages = []
      session.messages.push({ role: 'user', content: text, images })
      session.messages.push({ role: 'assistant', content: '', streaming: true })
      // 经响应式代理操作，流式增量才会驱动界面
      const assistant = session.messages[session.messages.length - 1]

      session.busy = true
      let requestId = nextId('req')
      session.requestId = requestId

      const ws = useWorkspace()
      let useTools = this.toolsEnabled && !!ws.root
      const system = await this.buildSystem(text, session, useTools)
      // 历史裁剪：最近 12 条（工具轨迹不进历史，只保留最终问答文本）
      const wire: ChatWireMsg[] = session.messages
        .filter((m) => !m.streaming && !m.error)
        .slice(-12)
        .map((m, i, arr) => ({
          role: m.role,
          content: m.content,
          // 只有本轮（最后一条 user）携带图片，历史消息不重发图片数据
          ...(i === arr.length - 1 && m.images?.length ? { images: m.images } : {}),
        }))

      try {
        // Agent 循环（docs/AI-TOOLS-DESIGN.md §2/§5）：
        // 模型要工具 → 执行 → 结果回填 → 下一轮；直到直接作答或达轮数上限
        for (let round = 0; ; round++) {
          let roundText = ''
          let calls: AiToolCall[] | null = null
          let errorMsg: string | null = null
          const sendTools = useTools && round < MAX_TOOL_ROUNDS ? TOOL_DEFS : undefined
          await ipc().aiChat(
            {
              requestId,
              provider: { ...this.activeProvider },
              system,
              messages: wire,
              tools: sendTools,
            },
            (e) => {
              // 用户已「停止」后迟到的增量直接丢弃
              if (e.type === 'delta') {
                if (assistant.streaming) {
                  assistant.content += e.text
                  roundText += e.text
                }
              } else if (e.type === 'toolCalls') {
                if (assistant.streaming) calls = e.calls
              } else if (e.type === 'error') {
                errorMsg = e.message
              }
            },
          )
          if (!assistant.streaming) break // 已被停止
          if (errorMsg) {
            // 端点不认 tools 参数：首轮降级为纯对话重试一次
            if (sendTools && round === 0 && /tool|function/i.test(errorMsg)) {
              useTools = false
              requestId = nextId('req')
              session.requestId = requestId
              console.warn('[bmd] 模型不支持工具调用，本次已降级为纯对话：', errorMsg)
              continue
            }
            assistant.error = errorMsg
            break
          }
          const pending = calls as AiToolCall[] | null
          if (!pending || !pending.length) break // 最终回答完成

          wire.push({ role: 'assistant', content: roundText, toolCalls: pending })
          assistant.steps = assistant.steps ?? []
          for (const call of pending) {
            const step: ToolStep = { name: call.name, args: call.arguments, summary: '', ms: 0 }
            assistant.steps.push(step)
            const t0 = Date.now()
            let output: string
            try {
              output = await this.executeTool(call)
            } catch (e) {
              output = `工具执行失败：${e instanceof Error ? e.message : e}`
              step.error = output
            }
            step.ms = Date.now() - t0
            step.summary = output.slice(0, 160)
            wire.push({
              role: 'tool',
              content: output.slice(0, TOOL_RESULT_BUDGET),
              toolCallId: call.id,
            })
          }
          if (!assistant.streaming) break // 执行工具期间被停止
          requestId = nextId('req')
          session.requestId = requestId
        }
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
