<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useFiles } from '@/stores/files'
import { useUi } from '@/stores/ui'
import { useWorkspace } from '@/stores/workspace'

const ui = useUi()
const fileActions = useFiles()
const workspace = useWorkspace()

const query = ref('')
const selected = ref(0)
const input = ref<HTMLInputElement | null>(null)
const files = ref<string[]>([])
let loadRequestSeq = 0

watch(
  () => [ui.quickOpenVisible, workspace.root] as const,
  async ([visible, root]) => {
    const requestId = ++loadRequestSeq
    if (!visible) return
    query.value = ''
    selected.value = 0
    files.value = []
    const collected = await workspace.collectAllText()
    if (requestId !== loadRequestSeq || !ui.quickOpenVisible || root !== workspace.root) return
    files.value = collected
    await nextTick()
    if (requestId !== loadRequestSeq || !ui.quickOpenVisible) return
    input.value?.focus()
  },
)

/** 简单模糊匹配：查询字符按序出现；文件名命中优先 */
const matches = computed(() => {
  const q = query.value.trim().toLowerCase()
  const rel = (p: string) => (workspace.root ? p.slice(workspace.root.length + 1) : p)
  if (!q) return files.value.slice(0, 50).map((p) => ({ path: p, rel: rel(p) }))
  const fuzzy = (text: string) => {
    let i = 0
    for (const ch of text.toLowerCase()) if (ch === q[i]) i++
    return i === q.length
  }
  return files.value
    .map((p) => ({ path: p, rel: rel(p) }))
    .filter((f) => fuzzy(f.rel))
    .sort((a, b) => {
      const an = a.rel.toLowerCase().includes(q) ? 0 : 1
      const bn = b.rel.toLowerCase().includes(q) ? 0 : 1
      return an - bn || a.rel.length - b.rel.length
    })
    .slice(0, 50)
})

async function open(path: string) {
  ui.quickOpenVisible = false
  await fileActions.openPath(path)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    ui.quickOpenVisible = false
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (matches.value.length) selected.value = Math.min(selected.value + 1, matches.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selected.value = Math.max(selected.value - 1, 0)
  } else if (e.key === 'Enter') {
    const m = matches.value[selected.value]
    if (m) void open(m.path)
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.quickOpenVisible" class="overlay" @mousedown.self="ui.quickOpenVisible = false">
        <div class="box" role="dialog" aria-label="快速打开">
          <input
            ref="input"
            v-model="query"
            placeholder="输入文件名跳转…"
            spellcheck="false"
            @keydown="onKey"
            @input="selected = 0"
          />
          <div class="list">
            <button
              v-for="(m, i) in matches"
              :key="m.path"
              class="item"
              :class="{ sel: i === selected }"
              @click="open(m.path)"
              @mousemove="selected = i"
            >
              {{ m.rel }}
            </button>
            <p v-if="!matches.length" class="none">无匹配文件</p>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.3);
}

.box {
  width: 520px;
  max-width: calc(100vw - 48px);
  height: fit-content;
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

input {
  width: 100%;
  padding: 12px 16px;
  font: inherit;
  font-size: 14px;
  color: var(--bmd-text);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--bmd-border);
  outline: none;
}

.list {
  max-height: 320px;
  overflow: auto;
  padding: 6px;
}

.item {
  display: block;
  width: 100%;
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item.sel {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-accent-a) 20%, transparent);
}

.none {
  padding: 14px;
  font-size: 12.5px;
  color: var(--bmd-text-faint);
  text-align: center;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 130ms;
}
</style>
