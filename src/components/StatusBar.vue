<script setup lang="ts">
import { computed } from 'vue'
import { usePlugins } from '@/stores/plugins'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'

const plugins = usePlugins()
const tabs = useTabs()
const ui = useUi()

const savedLabel = computed(() => {
  if (!tabs.savedAt) return ''
  const d = new Date(tabs.savedAt)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `已保存 ${hh}:${mm}`
})
</script>

<template>
  <footer class="statusbar">
    <span v-if="tabs.active?.preview" class="item preview">临时预览</span>
    <span v-if="tabs.active?.kind === 'html'" class="item">HTML 只读预览</span>
    <span v-if="tabs.active?.kind === 'image'" class="item">图片只读预览</span>
    <span v-if="tabs.active?.kind === 'text'" class="item">纯文本</span>
    <span v-if="tabs.active && (tabs.active.kind === 'md' || tabs.active.kind === 'text')" class="item">
      {{ ui.counts.words }} 字 · {{ ui.counts.chars }} 字符
    </span>
    <span v-if="tabs.active && (tabs.active.kind === 'md' || tabs.active.kind === 'text')" class="item">
      行 {{ ui.cursor.line }}，列 {{ ui.cursor.col }}
    </span>
    <span class="spacer" />
    <!-- 插件注册的状态栏项（app.addStatusBarItem） -->
    <span
      v-for="s in plugins.statusItems"
      :key="s.id"
      class="item"
      :class="{ clickable: !!s.onClick }"
      :title="s.title"
      @click="s.onClick?.()"
    >{{ s.text }}</span>
    <span v-if="tabs.active?.dirty" class="item dirty">● 未保存</span>
    <span v-else-if="savedLabel" class="item saved">✓ {{ savedLabel }}</span>
  </footer>
</template>

<style scoped>
.statusbar {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 26px;
  padding: 0 14px;
  font-size: 11.5px;
  color: var(--bmd-text-faint);
  background: color-mix(in srgb, var(--bmd-panel) 82%, transparent);
  border-top: 1px solid var(--bmd-border);
  user-select: none;
}

.spacer {
  flex: 1;
}

.clickable {
  cursor: pointer;
}

.clickable:hover {
  color: var(--bmd-text);
}

.dirty {
  color: var(--bmd-accent);
}

.saved {
  color: var(--bmd-text-dim);
}

.preview {
  color: var(--bmd-accent);
}
</style>
