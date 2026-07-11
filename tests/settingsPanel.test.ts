import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import { createApp, nextTick, type App } from 'vue'
import packageMetadata from '../package.json'
import SettingsPanel from '../src/components/SettingsPanel.vue'
import { usePlugins } from '../src/stores/plugins'
import { useUi } from '../src/stores/ui'

let app: App<Element> | undefined
let pinia: Pinia
let root: HTMLDivElement

beforeEach(async () => {
  localStorage.clear()
  pinia = createPinia()
  setActivePinia(pinia)
  root = document.createElement('div')
  document.body.appendChild(root)
  useUi().settingsVisible = true
  app = createApp(SettingsPanel)
  app.use(pinia)
  app.mount(root)
  await nextTick()
})

afterEach(() => {
  usePlugins().dispose()
  app?.unmount()
  document.body.innerHTML = ''
})

describe('SettingsPanel 关于页', () => {
  it('显示当前应用发布版本', async () => {
    const about = [...document.querySelectorAll<HTMLButtonElement>('.nav-item')].find(
      (button) => button.textContent?.trim() === '关于',
    )
    expect(about).toBeDefined()
    about!.click()
    await nextTick()

    expect(document.querySelector('.about-ver')?.textContent).toBe(`v${packageMetadata.version}`)
  })
})
