<script setup lang="ts">
// 通用右键菜单 + 轻量输入弹窗（文件树 FR-04 使用）
import { onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { ChoiceItem, MenuItem } from '@/lib/menuBus'

const state = reactive({
  visible: false,
  x: 0,
  y: 0,
  items: [] as MenuItem[],
})

const prompt = reactive({
  visible: false,
  title: '',
  value: '',
  resolve: null as ((v: string | null) => void) | null,
})
const promptInput = ref<HTMLInputElement | null>(null)

const choice = reactive({
  visible: false,
  title: '',
  message: '',
  items: [] as ChoiceItem[],
  resolve: null as ((v: string | null) => void) | null,
})

function showMenu(x: number, y: number, items: MenuItem[]) {
  const margin = 8
  state.items = items
  state.x = Math.max(margin, Math.min(x, window.innerWidth - 180 - margin))
  state.y = Math.max(margin, Math.min(y, window.innerHeight - items.length * 34 - margin))
  state.visible = true
}

function askText(title: string, initial = ''): Promise<string | null> {
  prompt.resolve?.(null) // 前一个未决弹窗按取消收尾，Promise 不悬挂
  prompt.title = title
  prompt.value = initial
  prompt.visible = true
  setTimeout(() => {
    promptInput.value?.focus()
    promptInput.value?.select()
  }, 30)
  return new Promise((resolve) => {
    prompt.resolve = resolve
  })
}

function settlePrompt(v: string | null) {
  prompt.visible = false
  prompt.resolve?.(v)
  prompt.resolve = null
}

function askChoice(title: string, message: string, items: ChoiceItem[]): Promise<string | null> {
  choice.resolve?.(null)
  choice.title = title
  choice.message = message
  choice.items = items
  choice.visible = true
  return new Promise((resolve) => {
    choice.resolve = resolve
  })
}

function settleChoice(v: string | null) {
  choice.visible = false
  choice.resolve?.(v)
  choice.resolve = null
}

function hide() {
  state.visible = false
}

function runItem(item: MenuItem) {
  state.visible = false
  void Promise.resolve(item.action()).catch((error) =>
    console.error('[bmd] 菜单操作失败', error),
  )
}

defineExpose({ showMenu, askText, askChoice })

onMounted(() => {
  window.addEventListener('mousedown', hide)
  window.addEventListener('blur', hide)
})
onBeforeUnmount(() => {
  prompt.resolve?.(null)
  choice.resolve?.(null)
  prompt.resolve = null
  choice.resolve = null
  window.removeEventListener('mousedown', hide)
  window.removeEventListener('blur', hide)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.visible"
      class="menu"
      :style="{ left: `${state.x}px`, top: `${state.y}px` }"
      @mousedown.stop
    >
      <button
        v-for="(item, i) in state.items"
        :key="i"
        :class="{ danger: item.danger }"
        @click="runItem(item)"
      >
        {{ item.label }}
      </button>
    </div>

    <div v-if="prompt.visible" class="prompt-overlay" @mousedown.self="settlePrompt(null)">
      <div class="prompt">
        <p>{{ prompt.title }}</p>
        <input
          ref="promptInput"
          v-model="prompt.value"
          spellcheck="false"
          @keydown.enter="settlePrompt(prompt.value.trim() || null)"
          @keydown.esc="settlePrompt(null)"
        />
        <div class="btns">
          <button @click="settlePrompt(null)">取消</button>
          <button class="primary" @click="settlePrompt(prompt.value.trim() || null)">确定</button>
        </div>
      </div>
    </div>

    <div v-if="choice.visible" class="prompt-overlay" @mousedown.self="settleChoice(null)">
      <div class="prompt choice" role="dialog" :aria-label="choice.title" @keydown.esc="settleChoice(null)">
        <p>{{ choice.title }}</p>
        <div class="message">{{ choice.message }}</div>
        <div class="btns">
          <button
            v-for="item in choice.items"
            :key="item.value"
            :class="{ primary: item.primary, danger: item.danger }"
            @click="settleChoice(item.value)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.menu {
  position: fixed;
  z-index: 200;
  min-width: 160px;
  padding: 5px;
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 10px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
}

.menu button {
  display: block;
  width: 100%;
  padding: 6px 12px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--bmd-text);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.menu button:hover {
  background: color-mix(in srgb, var(--bmd-accent-a) 18%, transparent);
}

.menu button.danger {
  color: var(--bmd-danger);
}

.prompt-overlay {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
}

.prompt {
  width: 320px;
  padding: 16px;
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
}

.prompt p {
  margin: 0 0 10px;
  font-size: 13px;
}

.prompt .message {
  margin-bottom: 14px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bmd-text-dim);
  white-space: pre-wrap;
}

.prompt input {
  width: 100%;
  padding: 7px 10px;
  font: inherit;
  font-size: 13px;
  color: var(--bmd-text);
  background: var(--bmd-bg);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  outline: none;
}

.prompt input:focus {
  border-color: color-mix(in srgb, var(--bmd-accent-a) 55%, transparent);
}

.btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.btns button {
  padding: 5px 14px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 7%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  cursor: pointer;
}

.btns .primary {
  color: #fff;
  background: var(--bmd-accent-gradient);
  border: none;
}

.btns .danger {
  color: var(--bmd-danger);
}
</style>
