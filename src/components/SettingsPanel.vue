<script setup lang="ts">
import { exportHtml, exportPdf } from '@/export'
import { useUi } from '@/stores/ui'

const ui = useUi()

function close() {
  ui.settingsVisible = false
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="ui.settingsVisible" class="overlay" @mousedown.self="close">
        <div class="panel" role="dialog" aria-label="设置">
          <header>
            <h2>设置</h2>
            <button class="x" @click="close">×</button>
          </header>

          <section>
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
                :checked="ui.autosaveEnabled"
                @change="ui.setAutosave(($event.target as HTMLInputElement).checked)"
              />
            </label>
          </section>

          <section>
            <h3>导出当前文档</h3>
            <div class="actions">
              <button class="act" @click="exportHtml()">导出 HTML</button>
              <button class="act" @click="exportPdf()">导出 PDF…</button>
            </div>
            <p class="hint">PDF 经系统打印对话框输出（选「存储为 PDF」）。</p>
          </section>
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
  width: 420px;
  max-width: calc(100vw - 48px);
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  padding: 18px 20px 20px;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

h2 {
  margin: 0;
  font-size: 15px;
}

h3 {
  margin: 14px 0 8px;
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
  padding: 9px 0;
  font-size: 13px;
}

.row em {
  font-style: normal;
  color: var(--bmd-text-faint);
  font-size: 11.5px;
}

.row input[type='range'] {
  width: 180px;
  accent-color: var(--bmd-accent);
}

.row input[type='checkbox'] {
  accent-color: var(--bmd-accent);
  width: 16px;
  height: 16px;
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

.act:hover {
  border-color: var(--bmd-text-faint);
}

.hint {
  margin: 8px 0 0;
  font-size: 11.5px;
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
