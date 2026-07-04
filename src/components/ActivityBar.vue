<script setup lang="ts">
// 左侧活动栏（Obsidian ribbon 式）：AI 面板开关 + 技能配置入口
import { keyHint } from '@/lib/shortcuts'
import { useAi } from '@/stores/ai'

const ai = useAi()
</script>

<template>
  <nav class="rail">
    <button
      class="item"
      :class="{ active: ai.panelVisible }"
      :title="`AI 助手 ${keyHint('⌘J')}`"
      @click="ai.toggle()"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 9 L5 7.5 L3.5 5 L7 6.2" />
        <path d="M19 9 L19 7.5 L20.5 5 L17 6.2" />
        <rect x="4.5" y="6" width="15" height="12" rx="5" />
        <circle cx="9.5" cy="11.5" r="0.6" fill="currentColor" />
        <circle cx="14.5" cy="11.5" r="0.6" fill="currentColor" />
        <path d="M10 14.6 Q11 15.6 12 14.6 Q13 15.6 14 14.6" />
        <path d="M12 6 L12 3.6" />
        <circle cx="12" cy="3" r="0.7" fill="currentColor" />
      </svg>
    </button>
    <button
      class="item"
      :title="'技能配置'"
      @click="ai.skillModalVisible = true"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M15 4 L20 9 L9 20 L4 20 L4 15 Z" />
        <path d="M12.5 6.5 L17.5 11.5" />
        <path d="M19 2.8 L19.4 4.1 L20.7 4.5 L19.4 4.9 L19 6.2 L18.6 4.9 L17.3 4.5 L18.6 4.1 Z" fill="currentColor" stroke="none" />
      </svg>
    </button>
  </nav>
</template>

<style scoped>
.rail {
  flex: none;
  width: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  background: var(--bmd-panel);
  border-right: 1px solid var(--bmd-border);
}

.item {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  color: var(--bmd-text-faint);
  background: transparent;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}

.item svg {
  width: 20px;
  height: 20px;
}

.item:hover {
  color: var(--bmd-text-dim);
  background: color-mix(in srgb, var(--bmd-text) 7%, transparent);
}

.item.active {
  color: var(--bmd-accent-a);
  background: color-mix(in srgb, var(--bmd-accent-a) 12%, transparent);
}
</style>
