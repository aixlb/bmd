import { buildExportHtml } from './html'
import { editorRegistry } from '@/lib/editorRegistry'
import { ipc } from '@/lib/ipc'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'

function activeDoc(): { markdown: string; title: string } | null {
  const tabs = useTabs()
  const tab = tabs.active
  if (!tab) return null
  const markdown = editorRegistry.getDoc(tab.id) ?? tab.initialDoc ?? ''
  return { markdown, title: tab.title.replace(/\.(md|markdown)$/i, '') }
}

/** 导出独立 HTML（FR-28） */
export async function exportHtml(): Promise<boolean> {
  const doc = activeDoc()
  if (!doc) return false
  const ui = useUi()
  const html = await buildExportHtml(doc.markdown, { title: doc.title, theme: ui.theme })
  const path = await ipc().pickSavePath(`${doc.title}.html`, {
    name: 'HTML',
    extensions: ['html'],
  })
  if (!path) return false
  await ipc().writeDocAtomic(path, html, null)
  return true
}

/** 导出 PDF（FR-29，V1 打印管线）：隐藏 iframe + 系统打印对话框 */
export async function exportPdf(): Promise<boolean> {
  const doc = activeDoc()
  if (!doc) return false
  // 打印一律用亮色（纸面语义），打印 CSS 已内联在导出样式中
  const html = await buildExportHtml(doc.markdown, { title: doc.title, theme: 'light' })
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  document.body.appendChild(frame)
  const win = frame.contentWindow!
  win.document.open()
  win.document.write(html)
  win.document.close()
  await new Promise((r) => setTimeout(r, 300)) // 等待样式/SVG 布局
  win.focus()
  win.print()
  setTimeout(() => frame.remove(), 60_000)
  return true
}
