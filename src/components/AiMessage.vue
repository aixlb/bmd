<script setup lang="ts">
import { ref, watchEffect } from 'vue'
import { renderChatMarkdown } from '@/lib/mdlite'
import type { ChatMsg } from '@/stores/ai'

const props = defineProps<{ msg: ChatMsg }>()
const emit = defineEmits<{ insert: [text: string]; replace: [text: string] }>()

const html = ref('')
watchEffect(() => {
  const content = props.msg.content
  if (props.msg.role === 'assistant') {
    // 流式中间态不进缓存；异步返回时丢弃过期结果
    void renderChatMarkdown(content, !props.msg.streaming).then((h) => {
      if (props.msg.content === content) html.value = h
    })
  }
})

function copy(text: string) {
  void navigator.clipboard.writeText(text)
}

const TOOL_LABELS: Record<string, string> = {
  list_files: '列出目录',
  read_doc: '读取文档',
  search_text: '全文搜索',
}

/** 步骤标题：工具名 + 关键参数摘要 */
function stepTitle(name: string, args: string): string {
  const label = TOOL_LABELS[name] ?? name
  try {
    const a = JSON.parse(args || '{}')
    const key = a.path ?? a.dir ?? a.query ?? ''
    return key ? `${label} ${key}` : label
  } catch {
    return label
  }
}
</script>

<template>
  <div class="msg" :class="msg.role">
    <template v-if="msg.role === 'user'">
      <div class="bubble user-bubble">
        <div v-if="msg.images?.length" class="u-imgs">
          <img
            v-for="(img, i) in msg.images"
            :key="i"
            :src="`data:${img.mediaType};base64,${img.dataB64}`"
            alt="附图"
          />
        </div>
        <span v-else-if="msg.imageCount" class="u-img-note">🖼 附图 ×{{ msg.imageCount }}</span>
        {{ msg.content }}
      </div>
    </template>
    <template v-else>
      <img class="avatar" src="@/assets/ai-avatar.png" alt="" draggable="false" />
      <div class="bubble ai-bubble">
        <div v-if="msg.steps?.length" class="steps">
          <details v-for="(s, i) in msg.steps" :key="i" class="step" :class="{ 'step-err': s.error }">
            <summary>
              <span class="step-icon">{{ s.error ? '⚠' : '🔍' }}</span>
              {{ stepTitle(s.name, s.args) }}
              <em v-if="s.ms">· {{ (s.ms / 1000).toFixed(1) }}s</em>
            </summary>
            <pre class="step-detail">{{ s.args }}</pre>
            <pre class="step-detail">{{ s.summary }}{{ s.summary.length >= 160 ? '…' : '' }}</pre>
          </details>
        </div>
        <div class="md" v-html="html" />
        <span v-if="msg.streaming" class="caret">▍</span>
        <p v-if="msg.error" class="err">⚠ {{ msg.error }}</p>
        <div v-if="!msg.streaming && !msg.error && msg.content" class="apply">
          <button title="插入光标处" @click="emit('insert', msg.content)">插入</button>
          <button title="替换选区（diff 预览）" @click="emit('replace', msg.content)">替换选区</button>
          <button title="复制" @click="copy(msg.content)">复制</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  margin: 8px 0;
}

.msg.user {
  justify-content: flex-end;
}

.avatar {
  width: 26px;
  height: 26px;
  margin: 2px 8px 0 0;
  border-radius: 50%;
  flex-shrink: 0;
  user-select: none;
  -webkit-user-drag: none;
}

.bubble {
  max-width: 92%;
  padding: 8px 12px;
  font-size: 13px;
  line-height: 1.65;
  border-radius: 12px;
}

.user-bubble {
  color: #fff;
  background: var(--bmd-accent-gradient);
  white-space: pre-wrap;
  border-bottom-right-radius: 4px;
}

.u-imgs img {
  display: block;
  max-width: 180px;
  max-height: 130px;
  margin-bottom: 6px;
  border-radius: 8px;
}

.u-img-note {
  display: block;
  margin-bottom: 4px;
  font-size: 11.5px;
  opacity: 0.85;
}

.ai-bubble {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 5%, transparent);
  border: 1px solid var(--bmd-border);
  border-bottom-left-radius: 4px;
  width: fit-content;
  min-width: 120px;
}

.md :deep(p) {
  margin: 0.4em 0;
}

.md :deep(pre) {
  background: var(--bmd-code-bg);
  border-radius: 8px;
  padding: 10px;
  overflow-x: auto;
  font-size: 12px;
}

.md :deep(code) {
  font-family: var(--bmd-font-mono);
}

.md :deep(a) {
  color: var(--bmd-link);
}

.caret {
  color: var(--bmd-accent);
  animation: blink 1s steps(1) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

.err {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--bmd-danger);
}

/* ---- 工具调用步骤 ---- */
.steps {
  margin-bottom: 6px;
}

.step {
  margin: 3px 0;
  font-size: 11.5px;
  color: var(--bmd-text-dim);
  background: color-mix(in srgb, var(--bmd-text) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--bmd-border) 70%, transparent);
  border-radius: 7px;
  padding: 3px 8px;
}

.step summary {
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.step summary::-webkit-details-marker {
  display: none;
}

.step summary em {
  font-style: normal;
  color: var(--bmd-text-faint);
}

.step-icon {
  margin-right: 2px;
}

.step-err {
  color: var(--bmd-danger);
}

.step-detail {
  margin: 4px 0 2px;
  padding: 6px;
  font-family: var(--bmd-font-mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bmd-code-bg);
  border-radius: 5px;
  max-height: 160px;
  overflow-y: auto;
}

.apply {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--bmd-border);
}

.apply button {
  padding: 2px 10px;
  font: inherit;
  font-size: 11.5px;
  color: var(--bmd-text-dim);
  background: transparent;
  border: 1px solid var(--bmd-border);
  border-radius: 6px;
  cursor: pointer;
}

.apply button:hover {
  color: var(--bmd-text);
  border-color: var(--bmd-text-faint);
}
</style>
