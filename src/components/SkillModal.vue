<script setup lang="ts">
import { ref } from 'vue'
import { type QuickCommand, useAi } from '@/stores/ai'

const ai = useAi()

const editing = ref<QuickCommand | null>(null)

function addSkill() {
  editing.value = {
    id: `skill-${Date.now().toString(36)}`,
    label: '',
    prompt: '',
  }
}

function editSkill(c: QuickCommand) {
  if (c.builtin) return
  editing.value = { ...c }
}

function saveSkill() {
  const c = editing.value
  if (!c || !c.label.trim() || !c.prompt.trim()) return
  const i = ai.customCommands.findIndex((x) => x.id === c.id)
  if (i >= 0) ai.customCommands[i] = { ...c }
  else ai.customCommands.push({ ...c })
  ai.saveCustomCommands()
  editing.value = null
}

function removeSkill(id: string) {
  ai.customCommands = ai.customCommands.filter((c) => c.id !== id)
  ai.saveCustomCommands()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="ai.skillModalVisible" class="overlay" @mousedown.self="ai.skillModalVisible = false">
      <div class="box">
        <header>
          <h2>技能配置</h2>
          <button class="x" @click="ai.skillModalVisible = false">×</button>
        </header>
        <p class="hint">
          技能是 AI 面板底部的一键指令。提示词里可用占位符：<code>{sel}</code> 当前选区、
          <code>{doc}</code> 当前文档全文；不含占位符时自动携带当前文档与选区作为上下文。
        </p>

        <div class="list">
          <div v-for="c in ai.commands" :key="c.id" class="row">
            <div class="meta" @click="editSkill(c)">
              <strong>{{ c.label }}<span v-if="c.builtin" class="badge">内置</span></strong>
              <span class="dim">{{ c.prompt }}</span>
            </div>
            <template v-if="!c.builtin">
              <button class="mini" @click="editSkill(c)">编辑</button>
              <button class="mini danger" @click="removeSkill(c.id)">删</button>
            </template>
          </div>
        </div>

        <div v-if="editing" class="edit">
          <input v-model="editing.label" placeholder="技能名（如 去 AI 味）" />
          <textarea
            v-model="editing.prompt"
            rows="5"
            placeholder="提示词（如：请改写以下内容，去掉翻译腔和套话，保持 markdown 格式：&#10;&#10;{sel}）"
          />
          <div class="edit-btns">
            <button class="mini" @click="editing = null">取消</button>
            <button class="mini primary" @click="saveSkill()">保存</button>
          </div>
        </div>
        <button v-else class="add" @click="addSkill()">＋ 新建技能</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 110;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.4);
}

.box {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: 80vh;
  overflow: auto;
  background: var(--bmd-panel);
  border: 1px solid var(--bmd-border);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  padding: 16px 20px 20px;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

h2 {
  margin: 0;
  font-size: 15px;
}

.x {
  font: inherit;
  font-size: 18px;
  color: var(--bmd-text-faint);
  background: none;
  border: none;
  cursor: pointer;
}

.hint {
  margin: 8px 0 12px;
  font-size: 11.5px;
  color: var(--bmd-text-faint);
  line-height: 1.6;
}

.hint code {
  font-family: var(--bmd-font-mono);
  font-size: 10.5px;
  padding: 1px 4px;
  background: var(--bmd-code-bg);
  border-radius: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--bmd-border);
  border-radius: 10px;
  margin-bottom: 6px;
}

.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  font-size: 13px;
}

.badge {
  margin-left: 6px;
  font-size: 10px;
  font-weight: normal;
  color: var(--bmd-text-faint);
  border: 1px solid var(--bmd-border);
  border-radius: 4px;
  padding: 0 4px;
}

.meta .dim {
  font-size: 11px;
  color: var(--bmd-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mini {
  padding: 3px 9px;
  font: inherit;
  font-size: 11.5px;
  color: var(--bmd-text-dim);
  background: transparent;
  border: 1px solid var(--bmd-border);
  border-radius: 6px;
  cursor: pointer;
}

.mini:hover {
  color: var(--bmd-text);
}

.mini.danger {
  color: var(--bmd-danger);
}

.mini.primary {
  color: #fff;
  background: var(--bmd-accent-gradient);
  border: none;
}

.edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  padding: 12px;
  border: 1px dashed var(--bmd-border);
  border-radius: 10px;
}

.edit input,
.edit textarea {
  padding: 6px 9px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: var(--bmd-bg);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  outline: none;
  resize: vertical;
}

.edit-btns {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.add {
  margin-top: 6px;
  padding: 6px 12px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text-dim);
  background: transparent;
  border: 1px dashed var(--bmd-border);
  border-radius: 8px;
  cursor: pointer;
  width: 100%;
}

.add:hover {
  color: var(--bmd-text);
  border-color: var(--bmd-text-faint);
}
</style>
