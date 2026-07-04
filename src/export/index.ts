import { buildExportHtml } from './html'
import { editorRegistry } from '@/lib/editorRegistry'
import { ipc } from '@/lib/ipc'
import { useTabs } from '@/stores/tabs'
import { useUi } from '@/stores/ui'

function activeDoc(): { markdown: string; title: string; path: string | null } | null {
  const tabs = useTabs()
  const tab = tabs.active
  if (!tab) return null
  const markdown = editorRegistry.getDoc(tab.id) ?? tab.initialDoc ?? ''
  return { markdown, title: tab.title.replace(/\.(md|markdown)$/i, ''), path: tab.path }
}

/** 文档所在目录（兼容两种分隔符）；无法判定时为 null */
export function dirnameOf(path: string): string | null {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut > 0 ? path.slice(0, cut) : null
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

/** 导出 PDF（FR-29，D8 V2）：原生静默导出；失败回退 V1 打印管线 */
export async function exportPdf(): Promise<boolean> {
  const doc = activeDoc()
  if (!doc) return false
  // 打印一律用亮色（纸面语义），打印 CSS 已内联在导出样式中
  const html = await buildExportHtml(doc.markdown, { title: doc.title, theme: 'light' })
  const path = await ipc().pickSavePath(`${doc.title}.pdf`, { name: 'PDF', extensions: ['pdf'] })
  if (!path) return false
  try {
    await ipc().exportPdfNative(html, doc.path ? dirnameOf(doc.path) : null, path)
    return true
  } catch (e) {
    console.warn('静默导出失败，回退打印管线：', e)
    return printFallback(html)
  }
}

/** V1 打印管线：隐藏 iframe + 系统打印对话框（用户可在对话框中另存 PDF） */
function printFallback(html: string): boolean {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  document.body.appendChild(frame)
  const win = frame.contentWindow!
  win.document.open()
  win.document.write(html)
  win.document.close()
  setTimeout(() => {
    win.focus()
    win.print() // 300ms 等样式/SVG 布局后再弹
    setTimeout(() => frame.remove(), 60_000)
  }, 300)
  return true
}
