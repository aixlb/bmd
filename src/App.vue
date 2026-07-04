<script setup lang="ts">
// M0 spike 壳：验证内核手感。正式壳（标题栏/侧边栏/标签页）在 M1。
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createBmdEditor, type BmdEditor } from '@core/index'

const host = ref<HTMLElement | null>(null)
let editor: BmdEditor | null = null

const SAMPLE = `# bmd · M0 内核 Spike

光标进入下列元素时会展开源码标记，移出后立即渲染——对标 Typora 手感。

这是 **加粗**、*斜体*、~~删除线~~、\`行内代码\`，以及一个 [链接](https://github.com/aixlb/bmd "bmd 仓库")。

## 中文输入法验收

在这一段里用拼音连续输入中文，验证组合期间渲染不打断、不丢字。**中文加粗测试**、*中文斜体*。

### 嵌套与边界

**加粗里带 *斜体* 和 \`代码\`**，以及行尾边界情况**测试**。

#### 四级标题
##### 五级标题
###### 六级标题
`

function toggleTheme() {
  const el = document.documentElement
  el.dataset.theme = el.dataset.theme === 'dark' ? 'light' : 'dark'
}

function loadStress() {
  if (!editor) return
  const section = `## 压测段落标题

这是一段包含 **加粗**、*斜体*、\`code\` 与 [链接](https://example.com) 的压测文本，用于验证大文档下的键入延迟与滚动流畅度。

`
  editor.setMarkdown(`# 5 万行压测\n\n${section.repeat(6250)}`)
}

onMounted(() => {
  editor = createBmdEditor({
    parent: host.value!,
    doc: SAMPLE,
    onOpenLink: (url) => console.info('[bmd] open link:', url),
  })
  editor.focus()
})

onBeforeUnmount(() => editor?.destroy())
</script>

<template>
  <div class="app">
    <header class="bar">
      <span class="brand">bmd</span>
      <span class="stage">M0 内核 Spike</span>
      <span class="spacer" />
      <button class="ghost" @click="loadStress">5 万行压测</button>
      <button class="ghost" @click="toggleTheme">明暗切换</button>
    </header>
    <main ref="host" class="editor-host" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--bmd-border);
  background: var(--bmd-panel);
  user-select: none;
}

.brand {
  font-weight: 700;
  background: var(--bmd-accent-gradient);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.stage {
  font-size: 12px;
  color: var(--bmd-text-dim);
}

.spacer {
  flex: 1;
}

.ghost {
  font: inherit;
  font-size: 12px;
  color: var(--bmd-text-dim);
  background: transparent;
  border: 1px solid var(--bmd-border);
  border-radius: 6px;
  padding: 4px 10px;
  cursor: pointer;
  transition: color 120ms, border-color 120ms;
}

.ghost:hover {
  color: var(--bmd-text);
  border-color: var(--bmd-text-faint);
}

.editor-host {
  flex: 1;
  overflow: auto;
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
  padding-left: 24px;
  padding-right: 24px;
}
</style>
