/** 剪贴板写入：优先异步 API，不可用或被拒绝时回退隐藏 textarea。 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 继续走兼容兜底。
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    return typeof document.execCommand === 'function' && document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}
