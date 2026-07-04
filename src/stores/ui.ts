import { defineStore } from 'pinia'

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
    cursor: { line: 1, col: 1 },
    counts: { words: 0, chars: 0 },
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
    },
  },
})

/** 中英混排字数统计：CJK 每字计 1，拉丁按词计 */
export function countWords(text: string): { words: number; chars: number } {
  const cjk = (text.match(/[一-鿿㐀-䶿぀-ヿ가-힯]/g) ?? []).length
  const latinWords = (text.replace(/[一-鿿㐀-䶿぀-ヿ가-힯]/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length
  return { words: cjk + latinWords, chars: [...text.replace(/\s/g, '')].length }
}
