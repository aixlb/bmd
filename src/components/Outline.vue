<script setup lang="ts">
import { computed } from 'vue'
import { EditorView } from '@codemirror/view'
import { editorRegistry } from '@/lib/editorRegistry'
import { useUi } from '@/stores/ui'

const ui = useUi()

/** 当前光标所处的大纲条目（其 pos 是不超过光标的最大值） */
const activePos = computed(() => {
  let pos = -1
  for (const item of ui.outline) {
    if (item.pos <= ui.cursorPos) pos = item.pos
    else break
  }
  return pos
})

function jump(pos: number) {
  const view = editorRegistry.getActiveView()
  if (!view) return
  const scroller = view.scrollDOM
  scroller.style.scrollBehavior = 'smooth'
  view.dispatch({
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 48 }),
  })
  setTimeout(() => (scroller.style.scrollBehavior = ''), 500)
}
</script>

<template>
  <div class="outline">
    <p v-if="!ui.outline.length" class="hint">当前文档没有标题</p>
    <button
      v-for="item in ui.outline"
      :key="item.pos"
      class="item"
      :class="{ active: item.pos === activePos }"
      :style="{ paddingLeft: `${10 + (item.level - 1) * 14}px` }"
      :title="item.text"
      @click="jump(item.pos)"
    >
      {{ item.text }}
    </button>
  </div>
</template>

<style scoped>
.outline {
  flex: 1;
  overflow: auto;
  padding: 4px 6px 12px;
}

.item {
  position: relative;
  display: block;
  width: 100%;
  padding: 4px 8px;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 120ms, background 120ms;
}

.item:hover {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 6%, transparent);
}

.item.active {
  color: var(--bmd-text);
}

.item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 20%;
  bottom: 20%;
  width: 2.5px;
  border-radius: 2px;
  background: var(--bmd-accent-gradient);
}

.hint {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--bmd-text-faint);
  text-align: center;
}
</style>
