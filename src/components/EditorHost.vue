<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { createBmdState } from '@core/index'
import { editorRegistry } from '@/lib/editorRegistry'
import { isTauri } from '@/lib/ipc'
import { useTabs } from '@/stores/tabs'
import { countWords, useUi } from '@/stores/ui'

const host = ref<HTMLElement | null>(null)
const tabs = useTabs()
const ui = useUi()

let view: EditorView | null = null
let currentTabId: string | null = null
let countTimer: ReturnType<typeof setTimeout> | null = null

function openLink(url: string) {
  // M2 接 shell 插件在系统浏览器打开；浏览器预览环境直接新开页
  if (!isTauri) window.open(url, '_blank', 'noopener')
}

function trackUpdate(tabId: string, update: ViewUpdate) {
  if (update.docChanged) {
    // 注册处始终持有最新快照，保存路径（store）由此取文档
    editorRegistry.set(tabId, update.state)
    if (countTimer) clearTimeout(countTimer)
    countTimer = setTimeout(() => {
      ui.counts = countWords(update.state.doc.toString())
    }, 300)
  }
  const head = update.state.selection.main.head
  const line = update.state.doc.lineAt(head)
  ui.cursor = { line: line.number, col: head - line.from + 1 }
}

function buildState(tabId: string, doc: string): EditorState {
  return createBmdState(doc, {
    onDocChanged: () => tabs.markDirty(tabId),
    onViewUpdate: (u) => trackUpdate(tabId, u),
    onOpenLink: openLink,
  })
}

function syncActive() {
  if (!view) return
  // 收起上一个标签的状态
  if (currentTabId && editorRegistry.get(currentTabId)) {
    editorRegistry.set(currentTabId, view.state)
  }
  const tab = tabs.active
  if (!tab) {
    currentTabId = null
    view.setState(EditorState.create({ doc: '' }))
    return
  }
  let state = editorRegistry.get(tab.id)
  if (!state) {
    state = buildState(tab.id, tab.initialDoc ?? '')
    tab.initialDoc = null
    editorRegistry.set(tab.id, state)
  }
  currentTabId = tab.id
  view.setState(state)
  ui.counts = countWords(state.doc.toString())
  view.focus()
}

onMounted(() => {
  view = new EditorView({ parent: host.value! })
  watch(() => tabs.activeId, syncActive, { immediate: true })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <main class="editor-wrap">
    <div v-show="tabs.active" ref="host" class="editor-host" />
    <div v-if="!tabs.active" class="placeholder">
      <div class="mark">b</div>
      <p>打开文件（⌘O）或新建（⌘N）开始写作</p>
    </div>
  </main>
</template>

<style scoped>
.editor-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  background: var(--bmd-bg);
}

.editor-host {
  height: 100%;
}

.editor-host :deep(.cm-editor) {
  height: 100%;
}

.editor-host :deep(.cm-scroller) {
  overflow: auto;
}

.editor-host :deep(.cm-content) {
  max-width: 760px;
  margin: 0 auto;
  padding-left: 32px;
  padding-right: 32px;
}

.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--bmd-text-faint);
  font-size: 13.5px;
  user-select: none;
}

.mark {
  width: 84px;
  height: 84px;
  display: grid;
  place-items: center;
  font-size: 46px;
  font-weight: 800;
  color: #fff;
  background: var(--bmd-accent-gradient);
  border-radius: 22px;
  opacity: 0.9;
}
</style>
