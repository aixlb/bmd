import { defineStore } from 'pinia'
import { refreshPreview, type OutlineItem } from '@core/index'
import { editorRegistry } from '@/lib/editorRegistry'

export type Theme = 'dark' | 'light'

function initialTheme(): Theme {
  const saved = localStorage.getItem('bmd.theme')
  if (saved === 'dark' || saved === 'light') return saved
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key)
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export const useUi = defineStore('ui', {
  state: () => ({
    sidebarVisible: localStorage.getItem('bmd.sidebar') !== 'off',
    sidebarWidth: 260,
    sidebarView: 'files' as 'files' | 'outline',
    theme: initialTheme(),
    fontSize: storedNumber('bmd.fontSize', 16, 12, 24),
    lineWidth: storedNumber('bmd.lineWidth', 760, 560, 1200),
    autosaveEnabled: localStorage.getItem('bmd.autosave') !== 'off',
    settingsVisible: false,
    quickOpenVisible: false,
    cursor: { line: 1, col: 1 },
    cursorPos: 0,
    counts: { words: 0, chars: 0 },
    outline: [] as OutlineItem[],
  }),

  actions: {
    toggleSidebar() {
      this.sidebarVisible = !this.sidebarVisible
      localStorage.setItem('bmd.sidebar', this.sidebarVisible ? 'on' : 'off')
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
      // Mermaid 等 widget 按新主题重渲染（模块已在启动包内，直接静态引用）
      const view = editorRegistry.getActiveView()
      if (view) refreshPreview(view)
    },
    applyFontSize() {
      document.documentElement.style.setProperty('--bmd-font-size', `${this.fontSize}px`)
      localStorage.setItem('bmd.fontSize', String(this.fontSize))
    },
    applyLineWidth() {
      document.documentElement.style.setProperty('--bmd-line-width', `${this.lineWidth}px`)
      localStorage.setItem('bmd.lineWidth', String(this.lineWidth))
    },
    setAutosave(on: boolean) {
      this.autosaveEnabled = on
      localStorage.setItem('bmd.autosave', on ? 'on' : 'off')
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
