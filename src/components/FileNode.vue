<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { isHtmlPath, isOpenablePath } from '@/lib/fileTypes'
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
/** HTML 文件：可打开为只读预览标签 */
const isHtml = computed(() => !props.entry.isDir && isHtmlPath(props.entry.name))

/** 行内重命名（双击 / F2 / 右键菜单） */
const renaming = ref(false)
const renameInput = ref<HTMLInputElement | null>(null)

function startRename() {
  if (renaming.value) return
  renaming.value = true
  void nextTick(() => {
    const el = renameInput.value
    if (!el) return
    el.value = props.entry.name
    el.focus()
    // 默认选中主文件名（不含扩展名），文件夹全选
    const dot = props.entry.isDir ? -1 : props.entry.name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : props.entry.name.length)
  })
}

async function commitRename() {
  if (!renaming.value) return
  const value = renameInput.value?.value ?? ''
  renaming.value = false
  const name = value.trim()
  if (!name || name === props.entry.name) return
  try {
    const newPath = await ipc().renameEntry(props.entry.path, name)
    const tab = tabs.tabs.find((t) => t.path === props.entry.path)
    if (tab) {
      tab.path = newPath
      tab.title = name
    }
    await workspace.refresh()
  } catch (e) {
    // 重名/权限等失败：保留原名，不中断（与右键菜单旧行为一致但不再抛未处理拒绝）
    console.error('重命名失败:', e)
  }
}

function onRenameKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    void commitRename()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    renaming.value = false
  }
}

function onClick() {
  if (props.entry.isDir) {
    workspace.toggleDir(props.entry.path)
  } else if (props.entry.isMd || isHtml.value) {
    tabs.openFile(props.entry.path)
  }
}

/** 右键菜单（FR-04） */
function onContextMenu(e: MouseEvent) {
  const m = menu()
  if (!m) return
  const entry = props.entry
  // 兼容 Windows 反斜杠路径
  const sep = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'))
  const parentDir = entry.isDir ? entry.path : entry.path.slice(0, Math.max(sep, 0))
  const items: MenuItem[] = [
    {
      label: '新建文件',
      action: async () => {
        const name = await m.askText('新建文件', '未命名.md')
        if (!name) return
        const p = await ipc().createEntry(parentDir, name, false)
        await workspace.refresh()
        if (isOpenablePath(p)) await tabs.openFile(p)
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
      action: () => startRename(),
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
        html: isHtml,
        other: !entry.isDir && !entry.isMd && !isHtml,
        active: entry.path === activePath,
      }"
      :style="{ paddingLeft: `${10 + depth * 14}px` }"
      @click="onClick"
      @dblclick.prevent="startRename"
      @keydown.f2.prevent="startRename"
      @contextmenu.prevent="onContextMenu"
    >
      <span v-if="entry.isDir" class="chevron" :class="{ open: expanded }">›</span>
      <span v-else class="chevron" aria-hidden="true"></span>
      <!-- 图标：Lucide folder/folder-open/file（ISC）、Tabler markdown（MIT） -->
      <span class="icon">
        <svg v-if="entry.isDir && expanded" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
        </svg>
        <svg v-else-if="entry.isDir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
        <svg v-else-if="entry.isMd" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10" />
          <path d="M7 15v-6l2 2l2 -2v6" />
          <path d="M14 13l2 2l2 -2m-2 2v-6" />
        </svg>
        <svg v-else-if="isHtml" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
          <path d="M14 2v5a1 1 0 0 0 1 1h5" />
          <path d="m9 13-2 2 2 2" />
          <path d="m15 13 2 2-2 2" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
          <path d="M14 2v5a1 1 0 0 0 1 1h5" />
        </svg>
      </span>
      <input
        v-if="renaming"
        ref="renameInput"
        class="rename-input"
        spellcheck="false"
        @click.stop
        @dblclick.stop
        @keydown.stop="onRenameKey"
        @blur="commitRename"
      />
      <span v-else class="name">{{ entry.name }}</span>
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--bmd-text-faint);
}

.icon svg {
  width: 100%;
  height: 100%;
}

.node.dir .icon {
  color: color-mix(in srgb, var(--bmd-accent-a) 42%, var(--bmd-text-dim));
}

.node.md .icon {
  color: var(--bmd-accent);
}

.node.html {
  color: var(--bmd-text);
}

.node.html .icon {
  color: color-mix(in srgb, var(--bmd-accent) 55%, var(--bmd-text-dim));
}

.name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.rename-input {
  flex: 1;
  min-width: 0;
  padding: 1px 5px;
  font: inherit;
  font-size: 13px;
  color: var(--bmd-text);
  background: var(--bmd-panel);
  border: 1px solid color-mix(in srgb, var(--bmd-accent-a) 60%, transparent);
  border-radius: 4px;
  outline: none;
}
</style>
