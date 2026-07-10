export const isMac = navigator.platform.toUpperCase().includes('MAC')

/** 平台化快捷键提示：macOS 显示符号，其他平台转换为文字组合键。 */
export function keyHint(macHint: string): string {
  if (isMac) return macHint
  return macHint
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⌃/g, 'Ctrl+')
}
