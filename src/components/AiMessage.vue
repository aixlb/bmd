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
</script>

<template>
  <div class="msg" :class="msg.role">
    <template v-if="msg.role === 'user'">
      <div class="bubble user-bubble">{{ msg.content }}</div>
    </template>
    <template v-else>
      <img class="avatar" src="@/assets/ai-avatar.png" alt="" draggable="false" />
      <div class="bubble ai-bubble">
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
