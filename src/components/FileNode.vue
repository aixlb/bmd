<script setup lang="ts">
import { computed } from 'vue'
import type { Entry } from '@/lib/ipc'
import { useTabs } from '@/stores/tabs'
import { useWorkspace } from '@/stores/workspace'

const props = defineProps<{ entry: Entry; depth: number }>()
const workspace = useWorkspace()
const tabs = useTabs()

const expanded = computed(() => !!workspace.expanded[props.entry.path])
const children = computed(() => workspace.children[props.entry.path] ?? [])
const activePath = computed(() => tabs.active?.path)

function onClick() {
  if (props.entry.isDir) {
    workspace.toggleDir(props.entry.path)
  } else if (props.entry.isMd) {
    tabs.openFile(props.entry.path)
  }
}
</script>

<template>
  <div>
    <button
      class="node"
      :class="{
        dir: entry.isDir,
        md: entry.isMd,
        other: !entry.isDir && !entry.isMd,
        active: entry.path === activePath,
      }"
      :style="{ paddingLeft: `${10 + depth * 14}px` }"
      @click="onClick"
    >
      <span v-if="entry.isDir" class="chevron" :class="{ open: expanded }">›</span>
      <span v-else class="icon">{{ entry.isMd ? '¶' : '·' }}</span>
      <span class="name">{{ entry.name }}</span>
    </button>
    <template v-if="entry.isDir && expanded">
      <FileNode v-for="c in children" :key="c.path" :entry="c" :depth="depth + 1" />
    </template>
  </div>
</template>

<style scoped>
.node {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.node:hover {
  background: color-mix(in srgb, var(--bmd-text) 6%, transparent);
}

.node.active {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-accent-a) 16%, transparent);
}

.node.md {
  color: var(--bmd-text);
}

.node.other {
  color: var(--bmd-text-faint);
  cursor: default;
}

.chevron {
  display: inline-block;
  width: 12px;
  color: var(--bmd-text-faint);
  transition: transform 140ms;
}

.chevron.open {
  transform: rotate(90deg);
}

.icon {
  width: 12px;
  color: var(--bmd-text-faint);
  text-align: center;
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
