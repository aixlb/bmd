<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ipc, isTauri, type AiProvider } from '@/lib/ipc'
import { useAi } from '@/stores/ai'

const ai = useAi()

const keyStates = reactive<Record<string, boolean>>({})
const editing = ref<AiProvider | null>(null)
const keyInput = reactive<Record<string, string>>({})

watch(
  () => ai.providerModalVisible,
  async (v) => {
    if (!v) return
    for (const p of ai.providers) {
      keyStates[p.id] = await ipc().hasApiKey(p.id)
    }
  },
)

async function saveKey(id: string) {
  const key = keyInput[id]?.trim()
  if (key === undefined) return
  await ipc().setApiKey(id, key)
  keyStates[id] = key.length > 0
  keyInput[id] = ''
}

function addCustom() {
  editing.value = {
    id: `custom-${Date.now().toString(36)}`,
    name: '',
    protocol: 'openai',
    baseUrl: '',
    model: '',
  }
}

function editProvider(p: AiProvider) {
  if (p.preset) return
  editing.value = { ...p }
}

function saveCustom() {
  const p = editing.value
  if (!p || !p.name || !p.baseUrl || !p.model) return
  const i = ai.customProviders.findIndex((x) => x.id === p.id)
  if (i >= 0) ai.customProviders[i] = { ...p }
  else ai.customProviders.push({ ...p })
  ai.saveCustomProviders()
  editing.value = null
}

function removeCustom(id: string) {
  ai.customProviders = ai.customProviders.filter((p) => p.id !== id)
  ai.saveCustomProviders()
  if (ai.activeProviderId === id) ai.selectProvider('claude')
}

function onEmbedProvider(id: string) {
  if (!id) {
    ai.setEmbed(null)
    return
  }
  const p = ai.providers.find((x) => x.id === id)
  if (!p) return
  ai.setEmbed({
    providerId: p.id,
    baseUrl: p.baseUrl,
    model: ai.embed?.model || 'text-embedding-3-small',
  })
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ai.providerModalVisible"
      class="overlay"
      @mousedown.self="ai.providerModalVisible = false"
    >
      <div class="box">
        <header>
          <h2>模型配置</h2>
          <button class="x" @click="ai.providerModalVisible = false">×</button>
        </header>
        <p class="privacy">
          API Key 保存在系统钥匙串（macOS 钥匙串 / Windows 凭据管理器），不写入任何配置文件；
          请求只发往下列端点，无遥测。{{ isTauri ? '' : '（浏览器预览环境不真正保存）' }}
        </p>

        <div class="list">
          <div v-for="p in ai.providers" :key="p.id" class="row" :class="{ active: p.id === ai.activeProviderId }">
            <div class="meta" @click="ai.selectProvider(p.id)">
              <strong>{{ p.name }}</strong>
              <span class="dim">{{ p.model }} · {{ p.baseUrl }}</span>
            </div>
            <span class="key-state" :class="{ ok: keyStates[p.id] }">
              {{ keyStates[p.id] ? '已配 Key' : '未配 Key' }}
            </span>
            <input
              v-model="keyInput[p.id]"
              type="password"
              class="key-in"
              placeholder="粘贴 API Key"
              @keydown.enter="saveKey(p.id)"
            />
            <button class="mini" @click="saveKey(p.id)">保存</button>
            <template v-if="!p.preset">
              <button class="mini" @click="editProvider(p)">编辑</button>
              <button class="mini danger" @click="removeCustom(p.id)">删</button>
            </template>
          </div>
        </div>

        <div class="embed-sec">
          <h3>RAG 嵌入模型（语义检索）</h3>
          <div class="embed-row">
            <select
              :value="ai.embed?.providerId ?? ''"
              @change="onEmbedProvider(($event.target as HTMLSelectElement).value)"
            >
              <option value="">不使用（BM25 词法检索兜底）</option>
              <option
                v-for="p in ai.providers.filter((x) => x.protocol === 'openai')"
                :key="p.id"
                :value="p.id"
              >
                经 {{ p.name }} 端点
              </option>
            </select>
            <input
              v-if="ai.embed"
              :value="ai.embed.model"
              placeholder="嵌入模型名（如 text-embedding-3-small / bge-m3）"
              @change="
                ai.setEmbed({ ...ai.embed!, model: ($event.target as HTMLInputElement).value })
              "
            />
          </div>
        </div>

        <div v-if="editing" class="edit">
          <input v-model="editing.name" placeholder="名称（如 我的中转）" />
          <select v-model="editing.protocol">
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <input v-model="editing.baseUrl" placeholder="Base URL（如 https://api.xx.com/v1）" />
          <input v-model="editing.model" placeholder="模型名（如 gpt-4o）" />
          <div class="edit-btns">
            <button class="mini" @click="editing = null">取消</button>
            <button class="mini primary" @click="saveCustom()">保存</button>
          </div>
        </div>
        <button v-else class="add" @click="addCustom()">＋ 自定义模型端点</button>
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
  width: 640px;
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

.privacy {
  margin: 8px 0 12px;
  font-size: 11.5px;
  color: var(--bmd-text-faint);
  line-height: 1.6;
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

.row.active {
  border-color: color-mix(in srgb, var(--bmd-accent-a) 60%, transparent);
  background: color-mix(in srgb, var(--bmd-accent-a) 6%, transparent);
}

.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  font-size: 13px;
}

.meta .dim {
  font-size: 11px;
  color: var(--bmd-text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.key-state {
  flex: none;
  font-size: 10.5px;
  color: var(--bmd-text-faint);
}

.key-state.ok {
  color: var(--bmd-accent-b);
}

.key-in {
  width: 130px;
  padding: 4px 8px;
  font: inherit;
  font-size: 11.5px;
  color: var(--bmd-text);
  background: var(--bmd-bg);
  border: 1px solid var(--bmd-border);
  border-radius: 6px;
  outline: none;
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
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 10px;
  padding: 12px;
  border: 1px dashed var(--bmd-border);
  border-radius: 10px;
}

.edit input,
.edit select {
  padding: 6px 9px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: var(--bmd-bg);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  outline: none;
}

.edit-btns {
  grid-column: span 2;
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

.embed-sec {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--bmd-border);
}

.embed-sec h3 {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--bmd-text-faint);
  letter-spacing: 0.05em;
}

.embed-row {
  display: flex;
  gap: 8px;
}

.embed-row select,
.embed-row input {
  flex: 1;
  padding: 6px 9px;
  font: inherit;
  font-size: 12.5px;
  color: var(--bmd-text);
  background: var(--bmd-bg);
  border: 1px solid var(--bmd-border);
  border-radius: 7px;
  outline: none;
}
</style>
