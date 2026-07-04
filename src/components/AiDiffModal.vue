<script setup lang="ts">
// 替换选区前的 diff 预览（FR-41），@codemirror/merge 只读对比
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ visible: boolean; original: string; proposed: string }>()
const emit = defineEmits<{ apply: []; cancel: [] }>()

const host = ref<HTMLElement | null>(null)
let mergeView: { destroy(): void } | null = null

watch(
  () => props.visible,
  async (v) => {
    mergeView?.destroy()
    mergeView = null
    if (!v) return
    const [{ MergeView }, { EditorState }, { EditorView }] = await Promise.all([
      import('@codemirror/merge'),
      import('@codemirror/state'),
      import('@codemirror/view'),
    ])
    if (!host.value) return
    mergeView = new MergeView({
      a: { doc: props.original, extensions: [EditorState.readOnly.of(true), EditorView.lineWrapping] },
      b: { doc: props.proposed, extensions: [EditorState.readOnly.of(true), EditorView.lineWrapping] },
      parent: host.value,
    })
  },
)

onBeforeUnmount(() => mergeView?.destroy())
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="overlay" @mousedown.self="emit('cancel')">
      <div class="box">
        <header>
          <span>替换选区预览（左：当前选区 → 右：AI 建议）</span>
        </header>
        <div ref="host" class="merge" />
        <footer>
          <button @click="emit('cancel')">取消</button>
          <button class="primary" @click="emit('apply')">应用替换</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.4);
}

.box {
  width: 760px;
  max-width: calc(100vw - 48px);
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

header {
  padding: 12px 16px;
  font-size: 13px;
  color: var(--bmd-text-dim);
  border-bottom: 1px solid var(--bmd-border);
}

.merge {
  max-height: 50vh;
  overflow: auto;
  font-size: 13px;
}

.merge :deep(.cm-editor) {
  background: transparent;
}

.merge :deep(.cm-content) {
  font-family: var(--bmd-font-prose);
}

footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--bmd-border);
}

footer button {
  padding: 5px 16px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 7%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  cursor: pointer;
}

footer .primary {
  color: #fff;
  background: var(--bmd-accent-gradient);
  border: none;
}
</style>
