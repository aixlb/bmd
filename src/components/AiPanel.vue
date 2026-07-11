<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import AiDiffModal from './AiDiffModal.vue'
import AiMessage from './AiMessage.vue'
import AiProviderModal from './AiProviderModal.vue'
import { editorRegistry } from '@/lib/editorRegistry'
import { keyHint } from '@/lib/shortcuts'
import { useAi } from '@/stores/ai'
import { useTabs } from '@/stores/tabs'
import { useWorkspace } from '@/stores/workspace'

const ai = useAi()
const tabs = useTabs()
const workspace = useWorkspace()

const input = ref('')
const listEl = ref<HTMLElement | null>(null)
const resizing = ref(false)
const mentionOpen = ref(false)
const mentionFiles = ref<string[]>([])
let mentionRequestSeq = 0
const activeDocLabel = computed(() => {
  const t = tabs.active
  if (!t) return '无文档'
  const badges: string[] = []
  if (t.preview) badges.push('临时')
  if (t.kind === 'text') badges.push('纯文本')
  if (t.kind === 'html' || t.kind === 'image') badges.push('只读')
  return badges.length ? `${t.title} · ${badges.join('/')}` : t.title
})

const diff = reactive({
  visible: false,
  tabId: null as string | null,
  revision: 0,
  editorVersion: 0,
  original: '',
  proposed: '',
  from: 0,
  to: 0,
})

async function send() {
  const text = input.value.trim()
  if ((!text && !ai.pendingImages.length) || ai.busy) return
  input.value = ''
  stickToBottom.value = true // 用户主动发送，跳回底部
  await ai.send(text)
}

/** 粘贴截图/图片 → 识图附件 */
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue
    e.preventDefault()
    const file = item.getAsFile()
    if (!file) continue
    const reader = new FileReader()
    reader.onload = () => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(String(reader.result))
      if (m) ai.attachImageData({ mediaType: m[1], dataB64: m[2] })
    }
    reader.readAsDataURL(file)
  }
}

/** 是否吸附底部：用户往上滚后暂停自动滚底，滚回底部附近恢复 */
const stickToBottom = ref(true)
const NEAR_BOTTOM = 40

function onListScroll() {
  const el = listEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM
}

function scrollListToBottom() {
  const el = listEl.value
  if (!el) return
  if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight })
  else el.scrollTop = el.scrollHeight
}

async function scrollToBottom() {
  stickToBottom.value = true
  await nextTick()
  scrollListToBottom()
}

watch(
  () => ai.current?.messages.map((m) => m.content.length).join(),
  async () => {
    if (!stickToBottom.value) return
    await nextTick()
    scrollListToBottom()
  },
)

// 切换会话时重置吸附并滚到底部
watch(() => ai.currentSessionId, () => void scrollToBottom())

function startResize(e: PointerEvent) {
  resizing.value = true
  const move = (ev: PointerEvent) => ai.setWidth(window.innerWidth - ev.clientX)
  const up = () => {
    resizing.value = false
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up) // 触摸中断等场景也要撤监听
  e.preventDefault()
}

/** 插入光标处（单事务，可一次撤销） */
function applyInsert(text: string) {
  if (tabs.active?.kind !== 'md' && tabs.active?.kind !== 'text') return
  const view = editorRegistry.getActiveView()
  if (!view) return
  const pos = view.state.selection.main.to
  view.dispatch({
    changes: { from: pos, insert: (pos > 0 ? '\n\n' : '') + text },
    userEvent: 'input.ai-apply',
  })
  view.focus()
}

/** 替换选区：先 diff 预览（FR-41） */
function applyReplace(text: string) {
  const tab = tabs.active
  if (!tab || (tab.kind !== 'md' && tab.kind !== 'text')) return
  const view = editorRegistry.getActiveView()
  if (!view) return
  const sel = view.state.selection.main
  if (sel.empty) {
    applyInsert(text)
    return
  }
  diff.original = view.state.doc.sliceString(sel.from, sel.to)
  diff.proposed = text
  diff.tabId = tab.id
  diff.revision = tab.revision
  diff.editorVersion = tab.editorVersion
  diff.from = sel.from
  diff.to = sel.to
  diff.visible = true
}

function confirmReplace() {
  diff.visible = false
  const tab = tabs.active
  if (!tab || (tab.kind !== 'md' && tab.kind !== 'text')) return
  if (
    tab.id !== diff.tabId ||
    tab.revision !== diff.revision ||
    tab.editorVersion !== diff.editorVersion
  ) return
  const view = editorRegistry.getActiveView()
  if (!view) return
  view.dispatch({
    changes: { from: diff.from, to: diff.to, insert: diff.proposed },
    userEvent: 'input.ai-apply',
  })
  view.focus()
}

function closeSession(id: string) {
  ai.deleteSession(id) // 进行中的请求由 store 负责取消
  if (!ai.sessions.length) ai.newSession()
}

async function toggleMention() {
  if (mentionOpen.value) {
    mentionOpen.value = false
    mentionRequestSeq++
    return
  }
  mentionOpen.value = true
  const requestId = ++mentionRequestSeq
  const root = workspace.root
  const collected = await workspace.collectAllText()
  if (requestId === mentionRequestSeq && mentionOpen.value && root === workspace.root) {
    mentionFiles.value = collected
  }
}

function toggleMentionFile(path: string) {
  const i = ai.mentionFiles.indexOf(path)
  if (i >= 0) ai.mentionFiles.splice(i, 1)
  else ai.mentionFiles.push(path)
}

// 浮动工具条的 ✦ 按钮（内核经 DOM 事件解耦）
function onAiSelection() {
  ai.panelVisible = true
}

onMounted(() => {
  void ai.restore().then(() => {
    if (!ai.sessions.length) ai.newSession()
  })
  window.addEventListener('bmd:ai-selection', onAiSelection)
})

watch(
  () => workspace.root,
  () => {
    mentionRequestSeq++
    mentionOpen.value = false
    mentionFiles.value = []
  },
)

onUnmounted(() => {
  mentionRequestSeq++
  window.removeEventListener('bmd:ai-selection', onAiSelection)
})
</script>

<template>
  <aside class="ai-panel" :style="{ width: `${ai.panelWidth}px` }">
    <div class="resize-handle" :class="{ resizing }" @pointerdown="startResize" />

    <header class="head">
      <select
        class="provider"
        :value="ai.activeProviderId"
        title="切换模型"
        @change="ai.selectProvider(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in ai.providers" :key="p.id" :value="p.id">
          {{ p.name }} · {{ p.model }}
        </option>
      </select>
      <button class="icon" title="模型配置" @click="ai.providerModalVisible = true">⚙</button>
      <button class="icon" :title="`关闭 ${keyHint('⌘J')}`" @click="ai.panelVisible = false">×</button>
    </header>

    <div class="session-tabs">
      <button
        v-for="s in ai.sessions"
        :key="s.id"
        class="session-tab"
        :class="{ active: s.id === ai.currentSessionId }"
        :title="s.title"
        @click="ai.currentSessionId = s.id"
      >
        <span v-if="s.busy" class="busy-dot" />
        <span class="tab-title">{{ s.title }}</span>
        <span class="tab-close" title="关闭会话" @click.stop="closeSession(s.id)">×</span>
      </button>
      <button class="icon tab-add" title="新会话" @click="ai.newSession()">＋</button>
    </div>

    <div ref="listEl" class="messages" @scroll.passive="onListScroll">
      <div v-if="!ai.current?.messages.length" class="empty">
        <img class="empty-img" src="@/assets/ai-empty.png" alt="" draggable="false" />
        <p>我可以帮你续写、润色、翻译、答疑。</p>
        <p class="dim">已自动携带当前文档与选区作为上下文。</p>
      </div>
      <AiMessage
        v-for="(m, i) in ai.current?.messages ?? []"
        :key="i"
        :msg="m"
        @insert="applyInsert"
        @replace="applyReplace"
      />
    </div>

    <div class="quick">
      <button v-for="c in ai.commands" :key="c.id" @click="ai.runCommand(c)">
        {{ c.label }}
      </button>
    </div>

    <div class="context-chips">
      <button class="chip" :class="{ on: ai.includeDoc }" @click="ai.includeDoc = !ai.includeDoc">
        📄 {{ activeDocLabel }}
      </button>
      <button
        class="chip"
        :class="{ on: ai.includeSelection }"
        @click="ai.includeSelection = !ai.includeSelection"
      >
        ✂ 选区
      </button>
      <button class="chip" :class="{ on: ai.mentionFiles.length > 0 }" @click="toggleMention">
        @ 文件{{ ai.mentionFiles.length ? ` (${ai.mentionFiles.length})` : '' }}
      </button>
      <button
        class="chip"
        :class="{ on: ai.ragEnabled }"
        :title="ai.embed ? `语义检索（${ai.embed.model}）` : '词法检索（BM25，未配置嵌入模型）'"
        @click="ai.toggleRag()"
      >
        🔎 RAG{{ ai.ragIndexing ? ' 索引中…' : ai.ragEnabled && !ai.embed ? ' (BM25)' : '' }}
      </button>
    </div>

    <div v-if="ai.lastSources.length" class="sources">
      <span class="dim">检索来源：</span>
      <button
        v-for="s in ai.lastSources"
        :key="s.path + s.heading"
        class="source"
        :title="`${s.path} · ${s.heading}`"
        @click="tabs.openFile(s.path)"
      >
        {{ s.path.split('/').pop() }}
      </button>
    </div>

    <div v-if="mentionOpen" class="mention-list">
      <button
        v-for="f in mentionFiles"
        :key="f"
        class="mention-item"
        :class="{ on: ai.mentionFiles.includes(f) }"
        @click="toggleMentionFile(f)"
      >
        {{ workspace.root ? f.slice(workspace.root.length + 1) : f }}
      </button>
      <p v-if="!mentionFiles.length" class="dim pad">工作区没有可附加的文本文件</p>
    </div>

    <footer class="composer">
      <div v-if="ai.pendingImages.length" class="attach-strip">
        <div v-for="(img, i) in ai.pendingImages" :key="i" class="attach-thumb">
          <img :src="`data:${img.mediaType};base64,${img.dataB64}`" alt="附图" />
          <button class="attach-x" title="移除" @click="ai.removePendingImage(i)">×</button>
        </div>
      </div>
      <textarea
        v-model="input"
        rows="3"
        placeholder="问点什么…（Enter 发送，Shift+Enter 换行，可粘贴截图）"
        @keydown.enter.exact.prevent="send"
        @paste="onPaste"
      />
      <div class="composer-bar">
        <span class="dim">{{ ai.activeProvider.name }}</span>
        <div class="composer-actions">
          <button class="img-btn" title="附加图片（需模型支持视觉；也可直接粘贴截图）" @click="ai.pickAndAttachImage()">🖼</button>
          <button v-if="ai.busy" class="stop" @click="ai.stop()">■ 停止</button>
          <button v-else class="send" :disabled="!input.trim() && !ai.pendingImages.length" @click="send">发送 ↵</button>
        </div>
      </div>
    </footer>

    <AiProviderModal />
    <AiDiffModal
      :visible="diff.visible"
      :original="diff.original"
      :proposed="diff.proposed"
      @apply="confirmReplace"
      @cancel="diff.visible = false"
    />
  </aside>
</template>

<style scoped>
.ai-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: none;
  height: 100%;
  background: color-mix(in srgb, var(--bmd-panel) 62%, transparent);
  border-left: 1px solid var(--bmd-border);
}

.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 5;
}

.resize-handle:hover,
.resize-handle.resizing {
  background: color-mix(in srgb, var(--bmd-accent-a) 35%, transparent);
}

.head {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 10px 8px;
}

.provider {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 5%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  outline: none;
}

.icon {
  width: 26px;
  height: 26px;
  font: inherit;
  font-size: 13px;
  color: var(--bmd-text-faint);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.icon:hover {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 8%, transparent);
}

.session-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.session-tabs::-webkit-scrollbar {
  display: none;
}

.session-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  max-width: 150px;
  padding: 3px 8px;
  font: inherit;
  font-size: 11.5px;
  color: var(--bmd-text-faint);
  background: transparent;
  border: 1px solid var(--bmd-border);
  border-radius: 999px;
  cursor: pointer;
}

.session-tab.active {
  color: var(--bmd-text);
  border-color: color-mix(in srgb, var(--bmd-accent-a) 55%, transparent);
  background: color-mix(in srgb, var(--bmd-accent-a) 10%, transparent);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  flex: none;
  opacity: 0.5;
  padding: 0 1px;
}

.tab-close:hover {
  opacity: 1;
}

.tab-add {
  flex: none;
}

.busy-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--bmd-accent-a);
  animation: bmd-busy-pulse 1s ease-in-out infinite;
}

@keyframes bmd-busy-pulse {
  0%,
  100% {
    opacity: 0.3;
  }

  50% {
    opacity: 1;
  }
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 4px 12px;
}

.empty {
  padding: 32px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--bmd-text-dim);
}

.empty-img {
  width: 140px;
  margin-bottom: 10px;
  opacity: 0.9;
  user-select: none;
  -webkit-user-drag: none;
}

[data-theme='dark'] .empty-img {
  filter: invert(1) hue-rotate(180deg);
}

.dim {
  color: var(--bmd-text-faint);
  font-size: 12px;
}

.pad {
  padding: 8px;
}

.quick {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 12px 0;
}

.quick button {
  padding: 3px 10px;
  font: inherit;
  font-size: 11.5px;
  color: var(--bmd-text-dim);
  background: color-mix(in srgb, var(--bmd-text) 5%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 999px;
  cursor: pointer;
}

.quick button:hover {
  color: var(--bmd-text);
  border-color: color-mix(in srgb, var(--bmd-accent-a) 50%, transparent);
}

.context-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 12px 0;
}

.chip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 10px;
  font: inherit;
  font-size: 11.5px;
  color: var(--bmd-text-faint);
  background: transparent;
  border: 1px dashed var(--bmd-border);
  border-radius: 999px;
  cursor: pointer;
}

.chip.on {
  color: var(--bmd-text);
  border-style: solid;
  border-color: color-mix(in srgb, var(--bmd-accent-a) 55%, transparent);
  background: color-mix(in srgb, var(--bmd-accent-a) 10%, transparent);
}

.sources {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  padding: 6px 12px 0;
}

.source {
  padding: 2px 9px;
  font: inherit;
  font-size: 11px;
  color: var(--bmd-link);
  background: color-mix(in srgb, var(--bmd-accent-a) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--bmd-accent-a) 30%, transparent);
  border-radius: 999px;
  cursor: pointer;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-list {
  max-height: 140px;
  overflow: auto;
  margin: 6px 12px 0;
  border: 1px solid var(--bmd-border);
  border-radius: 8px;
  padding: 4px;
}

.mention-item {
  display: block;
  width: 100%;
  padding: 4px 8px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-item.on {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-accent-a) 16%, transparent);
}

.composer {
  padding: 10px 12px 12px;
}

.composer textarea {
  width: 100%;
  resize: none;
  padding: 8px 10px;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--bmd-text);
  background: var(--bmd-bg);
  border: 1px solid var(--bmd-border);
  border-radius: 10px;
  outline: none;
}

.composer textarea:focus {
  border-color: color-mix(in srgb, var(--bmd-accent-a) 55%, transparent);
}

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.composer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.img-btn {
  padding: 2px 8px;
  font: inherit;
  font-size: 13px;
  background: transparent;
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  cursor: pointer;
}

.img-btn:hover {
  border-color: var(--bmd-text-faint);
}

/* ---- 识图附件条 ---- */
.attach-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.attach-thumb {
  position: relative;
}

.attach-thumb img {
  width: 52px;
  height: 52px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--bmd-border);
  display: block;
}

.attach-x {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: #fff;
  background: rgba(0, 0, 0, 0.65);
  border: none;
  border-radius: 50%;
  cursor: pointer;
}

.send,
.stop {
  padding: 4px 14px;
  font: inherit;
  font-size: 12px;
  color: #fff;
  background: var(--bmd-accent-gradient);
  border: none;
  border-radius: 7px;
  cursor: pointer;
}

.send:disabled {
  opacity: 0.4;
  cursor: default;
}

.stop {
  background: var(--bmd-danger);
}
</style>
