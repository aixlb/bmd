import { defineStore } from 'pinia'
import type { OutlineItem } from '@core/index'

export type Theme = 'dark' | 'light'

function initialTheme(): Theme {
  const saved = localStorage.getItem('bmd.theme')
  if (saved === 'dark' || saved === 'light') return saved
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const useUi = defineStore('ui', {
  state: () => ({
    sidebarVisible: true,
    sidebarWidth: 260,
    sidebarView: 'files' as 'files' | 'outline',
    theme: initialTheme(),
    fontSize: Number(localStorage.getItem('bmd.fontSize')) || 16,
    cursor: { line: 1, col: 1 },
    cursorPos: 0,
    counts: { words: 0, chars: 0 },
    outline: [] as OutlineItem[],
  }),

  actions: {
    toggleSidebar() {
      this.sidebarVisible = !this.sidebarVisible
    },
    setSidebarWidth(w: number) {
      this.sidebarWidth = Math.min(400, Math.max(200, w))
    },
    applyTheme() {
      document.documentElement.dataset.theme = this.theme
      localStorage.setItem('bmd.theme', this.theme)
    },
    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark'
      this.applyTheme()
      // Mermaid 等 widget 按新主题重渲染
      void import('@/lib/editorRegistry').then(async ({ editorRegistry }) => {
        const view = editorRegistry.getActiveView()
        if (view) (await import('@core/index')).refreshPreview(view)
      })
    },
    applyFontSize() {
      document.documentElement.style.setProperty('--bmd-font-size', `${this.fontSize}px`)
      localStorage.setItem('bmd.fontSize', String(this.fontSize))
    },
    zoom(delta: number) {
      this.fontSize = delta === 0 ? 16 : Math.min(24, Math.max(12, this.fontSize + delta))
      this.applyFontSize()
    },
  },
})

/** 中英混排字数统计：CJK 每字计 1，拉丁按词计 */
export function countWords(text: string): { words: number; chars: number } {
  const cjk = (text.match(/[一-鿿㐀-䶿぀-ヿ가-힯]/g) ?? []).length
  const latinWords = (text.replace(/[一-鿿㐀-䶿぀-ヿ가-힯]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length
  return { words: cjk + latinWords, chars: [...text.replace(/\s/g, '')].length }
}
