import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/tokens.css'

const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
document.documentElement.dataset.theme = theme

createApp(App).use(createPinia()).mount('#app')

// 无白屏启动（DESIGN.md §7）：窗口以 visible:false 创建，前端就绪后再显示
if ('__TAURI_INTERNALS__' in window) {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  await win.show()
  await win.setFocus()
}
