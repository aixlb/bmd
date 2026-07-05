<script setup lang="ts">
// 设置面板（Obsidian 式）：左侧导航（通用 / AI 助手 / 第三方插件 + 插件设置页 / 关于），右侧内容区
import { computed, nextTick, ref, watch } from 'vue'
import logoUrl from '@/assets/logo-md.svg'
import { exportHtml, exportPdf } from '@/export'
import { ipc, isTauri } from '@/lib/ipc'
import { useAi } from '@/stores/ai'
import { APP_VERSION, usePlugins } from '@/stores/plugins'
import { useUi } from '@/stores/ui'

const ai = useAi()
const plugins = usePlugins()
const ui = useUi()

/** 当前导航项：general | ai | plugins | plugin:<id> */
const nav = ref('general')

function close() {
  ui.settingsVisible = false
}

watch(
  () => ui.settingsVisible,
  (v) => {
    // 每次打开回到通用页；导航中的插件页可能已被禁用
    if (v && (nav.value.startsWith('plugin:') || nav.value === '')) nav.value = 'general'
  },
)

// ---- 插件注册的设置页：宿主给容器，插件自渲染 ----
const tabHost = ref<HTMLElement | null>(null)
const activeTab = computed(() =>
  nav.value.startsWith('plugin:')
    ? plugins.settingTabs.find((t) => t.pluginId === nav.value.slice(7))
    : undefined,
)

watch([activeTab, tabHost], async () => {
  await nextTick()
  const el = tabHost.value
  if (!el || !activeTab.value) return
  el.innerHTML = ''
  try {
    activeTab.value.render(el)
  } catch (e) {
    el.textContent = `插件设置页渲染失败：${e instanceof Error ? e.message : e}`
  }
})

async function togglePlugin(id: string, on: boolean) {
  if (on) await plugins.enable(id)
  else await plugins.disable(id)
  if (nav.value === `plugin:${id}` && !on) nav.value = 'plugins'
}

function openPluginsDir() {
  if (plugins.pluginsDir) void ipc().revealInOs(plugins.pluginsDir)
}

/** 外链一律经系统浏览器打开（Tauri 走 opener 插件，浏览器预览新开标签） */
function openLink(url: string) {
  if (isTauri) {
    void import('@tauri-apps/plugin-opener').then((m) => m.openUrl(url))
  } else {
    window.open(url, '_blank', 'noopener')
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.settingsVisible" class="overlay" @mousedown.self="close">
        <div class="panel" role="dialog" aria-label="设置">
          <aside class="nav">
            <div class="nav-group">选项</div>
            <button class="nav-item" :class="{ on: nav === 'general' }" @click="nav = 'general'">
              通用
            </button>
            <button class="nav-item" :class="{ on: nav === 'ai' }" @click="nav = 'ai'">
              AI 助手
            </button>

            <div class="nav-group">插件</div>
            <button class="nav-item" :class="{ on: nav === 'plugins' }" @click="nav = 'plugins'">
              第三方插件
            </button>
            <button
              v-for="t in plugins.settingTabs"
              :key="t.pluginId"
              class="nav-item"
              :class="{ on: nav === `plugin:${t.pluginId}` }"
              @click="nav = `plugin:${t.pluginId}`"
            >
              {{ t.title }}
            </button>

            <div class="nav-group">其他</div>
            <button class="nav-item" :class="{ on: nav === 'about' }" @click="nav = 'about'">
              关于
            </button>
          </aside>

          <main class="content">
            <header>
              <h2>
                {{
                  nav === 'general' ? '通用' :
                  nav === 'ai' ? 'AI 助手' :
                  nav === 'plugins' ? '第三方插件' :
                  nav === 'about' ? '关于' :
                  activeTab?.title ?? '设置'
                }}
              </h2>
              <button class="x" title="关闭" @click="close">×</button>
            </header>

            <!-- 通用 -->
            <section v-if="nav === 'general'">
              <label class="row">
                <span>主题</span>
                <div class="seg">
                  <button :class="{ on: ui.theme === 'light' }" @click="ui.theme !== 'light' && ui.toggleTheme()">
                    亮色
                  </button>
                  <button :class="{ on: ui.theme === 'dark' }" @click="ui.theme !== 'dark' && ui.toggleTheme()">
                    暗色
                  </button>
                </div>
              </label>

              <label class="row">
                <span>正文字号 <em>{{ ui.fontSize }}px</em></span>
                <input
                  type="range"
                  min="12"
                  max="24"
                  :value="ui.fontSize"
                  @input="ui.fontSize = Number(($event.target as HTMLInputElement).value); ui.applyFontSize()"
                />
              </label>

              <label class="row">
                <span>行宽 <em>{{ ui.lineWidth }}px</em></span>
                <input
                  type="range"
                  min="560"
                  max="1200"
                  step="20"
                  :value="ui.lineWidth"
                  @input="ui.lineWidth = Number(($event.target as HTMLInputElement).value); ui.applyLineWidth()"
                />
              </label>

              <label class="row">
                <span>自动保存</span>
                <input
                  type="checkbox"
                  class="switch"
                  :checked="ui.autosaveEnabled"
                  @change="ui.setAutosave(($event.target as HTMLInputElement).checked)"
                />
              </label>

              <h3>导出当前文档</h3>
              <div class="actions">
                <button class="act" @click="exportHtml()">导出 HTML</button>
                <button class="act" @click="exportPdf()">导出 PDF…</button>
              </div>
              <p class="hint">PDF 经系统打印对话框输出（选「存储为 PDF」）。</p>
            </section>

            <!-- AI 助手 -->
            <section v-else-if="nav === 'ai'">
              <label class="row">
                <span>当前模型</span>
                <select
                  class="select"
                  :value="ai.activeProviderId"
                  @change="ai.selectProvider(($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="p in ai.providers" :key="p.id" :value="p.id">
                    {{ p.name }} · {{ p.model }}
                  </option>
                </select>
              </label>

              <label class="row">
                <span>工作区检索（RAG）<em>回答时引用工作区内相关笔记</em></span>
                <input
                  type="checkbox"
                  class="switch"
                  :checked="ai.ragEnabled"
                  @change="ai.toggleRag()"
                />
              </label>

              <h3>配置入口</h3>
              <div class="actions">
                <button class="act" @click="ai.providerModalVisible = true">模型与密钥…</button>
                <button class="act" @click="ai.skillModalVisible = true">技能配置…</button>
              </div>
              <p class="hint">面板快捷键 Ctrl/⌘+J；也可点标题栏或左侧活动栏的 AI 图标。</p>
            </section>

            <!-- 第三方插件管理 -->
            <section v-else-if="nav === 'plugins'">
              <template v-if="plugins.supported">
                <div class="plug-toolbar">
                  <span class="hint dir" :title="plugins.pluginsDir">{{ plugins.pluginsDir }}</span>
                  <div class="actions">
                    <button class="act" @click="openPluginsDir">打开插件目录</button>
                    <button class="act" :disabled="plugins.scanning" @click="plugins.scan()">
                      {{ plugins.scanning ? '扫描中…' : '重新扫描' }}
                    </button>
                  </div>
                </div>

                <p v-if="!plugins.installed.length" class="empty">
                  还没有安装插件。把插件文件夹（含 manifest.json 与 main.js）放入上方目录，
                  点「重新扫描」后即可在此启用。插件开发说明见项目根目录 PLUGINS.md。
                </p>

                <div v-for="p in plugins.installed" :key="p.manifest.id" class="plug">
                  <div class="plug-main">
                    <div class="plug-name">
                      {{ p.manifest.name }}
                      <em>v{{ p.manifest.version }}</em>
                      <em v-if="p.manifest.author">· {{ p.manifest.author }}</em>
                    </div>
                    <div v-if="p.manifest.description" class="plug-desc">{{ p.manifest.description }}</div>
                    <div v-if="p.error" class="plug-err">⚠ {{ p.error }}</div>
                  </div>
                  <input
                    type="checkbox"
                    class="switch"
                    :disabled="!!p.error"
                    :checked="plugins.isEnabled(p.manifest.id)"
                    @change="togglePlugin(p.manifest.id, ($event.target as HTMLInputElement).checked)"
                  />
                </div>
              </template>
              <p v-else class="empty">第三方插件仅在桌面应用中可用（浏览器预览环境无文件系统）。</p>
            </section>

            <!-- 关于 -->
            <section v-else-if="nav === 'about'">
              <div class="about">
                <img class="about-logo" :src="logoUrl" alt="bmd logo" />
                <div class="about-name">bmd · Bao Markdown</div>
                <div class="about-sub">包 markdown</div>
                <div class="about-ver">v{{ APP_VERSION }}</div>
                <p class="about-desc">所见即所得 Markdown 编辑器——极快启动 · 即时渲染 · AI 写作副驾</p>
                <div class="actions">
                  <button class="act" @click="openLink('https://github.com/aixlb/bmd')">GitHub 仓库</button>
                  <button class="act" @click="openLink('https://github.com/aixlb/bmd/blob/main/MANUAL.md')">用户手册</button>
                  <button class="act" @click="openLink('https://github.com/aixlb/bmd/blob/main/CHANGELOG.md')">更新日志</button>
                </div>
                <button class="about-knock" @click="openLink('https://xhslink.com/m/vX0zH462eU')">
                  有需求猛敲我 @玩AI的小笼包
                </button>
                <p class="about-copy">© 2026 玩AI的小笼包 · MIT License</p>
              </div>
            </section>

            <!-- 插件注册的设置页 -->
            <section v-else-if="activeTab">
              <div ref="tabHost" class="tab-host" />
            </section>
          </main>
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
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(2px);
}

.panel {
  display: flex;
  width: 860px;
  max-width: calc(100vw - 48px);
  height: 560px;
  max-height: calc(100vh - 64px);
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

/* ---- 左侧导航 ---- */
.nav {
  flex: none;
  width: 190px;
  padding: 14px 8px;
  overflow-y: auto;
  background: color-mix(in srgb, var(--bmd-text) 3%, transparent);
  border-right: 1px solid var(--bmd-border);
}

.nav-group {
  padding: 10px 10px 4px;
  font-size: 11px;
  color: var(--bmd-text-faint);
  letter-spacing: 0.06em;
}

.nav-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 7px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-item:hover {
  background: color-mix(in srgb, var(--bmd-text) 6%, transparent);
}

.nav-item.on {
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-accent) 14%, transparent);
}

/* ---- 右侧内容 ---- */
.content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 22px 20px;
  overflow: hidden;
}

.content header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.content section {
  flex: 1;
  overflow-y: auto;
  padding-right: 4px;
}

h2 {
  margin: 0;
  font-size: 15px;
}

h3 {
  margin: 18px 0 8px;
  font-size: 12px;
  color: var(--bmd-text-faint);
  letter-spacing: 0.05em;
}

.x {
  font: inherit;
  font-size: 18px;
  color: var(--bmd-text-faint);
  background: none;
  border: none;
  cursor: pointer;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  font-size: 13px;
  border-bottom: 1px solid color-mix(in srgb, var(--bmd-border) 55%, transparent);
}

.row em {
  font-style: normal;
  color: var(--bmd-text-faint);
  font-size: 11.5px;
  display: block;
}

.row input[type='range'] {
  width: 200px;
  accent-color: var(--bmd-accent);
}

.select {
  max-width: 260px;
  padding: 5px 8px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
}

/* 开关（checkbox 拟物） */
.switch {
  appearance: none;
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bmd-text) 18%, transparent);
  position: relative;
  cursor: pointer;
  transition: background 150ms;
}

.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 150ms;
}

.switch:checked {
  background: var(--bmd-accent);
}

.switch:checked::after {
  transform: translateX(14px);
}

.switch:disabled {
  opacity: 0.4;
  cursor: default;
}

.seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  background: color-mix(in srgb, var(--bmd-text) 5%, transparent);
  border-radius: 8px;
}

.seg button {
  padding: 3px 12px;
  font: inherit;
  font-size: 12px;
  color: var(--bmd-text-dim);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.seg button.on {
  color: var(--bmd-text);
  background: var(--bmd-panel);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
}

.actions {
  display: flex;
  gap: 8px;
}

.act {
  padding: 6px 14px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: color-mix(in srgb, var(--bmd-text) 7%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 8px;
  cursor: pointer;
}

.act:hover:not(:disabled) {
  border-color: var(--bmd-text-faint);
}

.act:disabled {
  opacity: 0.5;
  cursor: default;
}

.hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--bmd-text-faint);
}

/* ---- 插件管理 ---- */
.plug-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--bmd-border) 55%, transparent);
}

.dir {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.empty {
  padding: 24px 8px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--bmd-text-faint);
}

.plug {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--bmd-border) 55%, transparent);
}

.plug-main {
  flex: 1;
  min-width: 0;
}

.plug-name {
  font-size: 13px;
  color: var(--bmd-text);
}

.plug-name em {
  font-style: normal;
  font-size: 11px;
  color: var(--bmd-text-faint);
  margin-left: 4px;
}

.plug-desc {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--bmd-text-dim);
}

.plug-err {
  margin-top: 3px;
  font-size: 11.5px;
  color: #e5484d;
}

.tab-host {
  font-size: 13px;
  line-height: 1.7;
}

/* ---- 关于 ---- */
.about {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 34px;
  text-align: center;
}

.about-logo {
  width: 72px;
  height: 72px;
}

.about-name {
  margin-top: 14px;
  font-size: 16px;
  color: var(--bmd-text);
}

.about-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--bmd-text-faint);
}

.about-ver {
  margin-top: 10px;
  padding: 2px 12px;
  font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  font-size: 11.5px;
  color: var(--bmd-text-dim);
  background: color-mix(in srgb, var(--bmd-text) 5%, transparent);
  border: 1px solid var(--bmd-border);
  border-radius: 999px;
}

.about-desc {
  margin: 14px 0 0;
  font-size: 12.5px;
  color: var(--bmd-text-dim);
}

.about .actions {
  margin-top: 16px;
}

.about-knock {
  margin-top: 20px;
  font: inherit;
  font-size: 12px;
  color: var(--bmd-text-faint);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 150ms;
}

.about-knock:hover {
  color: var(--bmd-text);
}

.about-copy {
  margin-top: 12px;
  font-size: 11px;
  color: var(--bmd-text-faint);
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 150ms;
}
</style>
