<script setup lang="ts">
import { computed } from 'vue'
import { ipc, type Entry } from '@/lib/ipc'
import { menu, type MenuItem } from '@/lib/menuBus'
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

/** 右键菜单（FR-04） */
function onContextMenu(e: MouseEvent) {
  const m = menu()
  if (!m) return
  const entry = props.entry
  const parentDir = entry.isDir ? entry.path : entry.path.slice(0, entry.path.lastIndexOf('/'))
  const items: MenuItem[] = [
    {
      label: '新建文件',
      action: async () => {
        const name = await m.askText('新建文件', '未命名.md')
        if (!name) return
        const p = await ipc().createEntry(parentDir, name, false)
        await workspace.refresh()
        if (/\.(md|markdown)$/i.test(p)) await tabs.openFile(p)
      },
    },
    {
      label: '新建文件夹',
      action: async () => {
        const name = await m.askText('新建文件夹', '新文件夹')
        if (!name) return
        await ipc().createEntry(parentDir, name, true)
        await workspace.refresh()
      },
    },
    {
      label: '重命名',
      action: async () => {
        const name = await m.askText('重命名', entry.name)
        if (!name || name === entry.name) return
        const newPath = await ipc().renameEntry(entry.path, name)
        const tab = tabs.tabs.find((t) => t.path === entry.path)
        if (tab) {
          tab.path = newPath
          tab.title = name
        }
        await workspace.refresh()
      },
    },
    {
      label: '在系统中显示',
      action: () => ipc().revealInOs(entry.path),
    },
    {
      label: '删除（移入回收站）',
      danger: true,
      action: async () => {
        if (!(await ipc().confirm(`把「${entry.name}」移入回收站？`, '删除'))) return
        await ipc().trashEntry(entry.path)
        const tab = tabs.tabs.find((t) => t.path === entry.path)
        if (tab) {
          tab.dirty = false
          await tabs.closeTab(tab.id)
        }
        await workspace.refresh()
      },
    },
  ]
  m.showMenu(e.clientX, e.clientY, items)
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
      @contextmenu.prevent="onContextMenu"
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
