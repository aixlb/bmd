// 文件类型判定：各打开入口与 Rust 后端共用 shared/file-types.json 这一份规则。
import policy from '../../shared/file-types.json'

export const MARKDOWN_FILE_EXTENSIONS = policy.markdownExtensions
export const TEXT_FILE_EXTENSIONS = policy.textExtensions
export const TEXT_FILE_NAMES = policy.textNames
export const HTML_FILE_EXTENSIONS = policy.htmlExtensions
export const IMAGE_FILE_EXTENSIONS = policy.imageExtensions

function extensionOf(path: string): string | null {
  const name = path.split(/[/\\]/).pop()?.toLowerCase() ?? path.toLowerCase()
  const match = /\.([^.\\/]+)$/.exec(name)
  return match?.[1] ?? null
}

/** 可编辑的 Markdown 文档 */
export const isMarkdownPath = (p: string): boolean => {
  const ext = extensionOf(p)
  return !!ext && MARKDOWN_FILE_EXTENSIONS.includes(ext)
}

/** 可编辑的普通文本文件：走纯文本编辑，不启用 Markdown 即时渲染 */
export const isPlainTextPath = (p: string): boolean => {
  const name = p.split(/[/\\]/).pop()?.toLowerCase() ?? p.toLowerCase()
  if ((TEXT_FILE_NAMES as readonly string[]).includes(name)) return true
  const ext = extensionOf(name)
  return !!ext && TEXT_FILE_EXTENSIONS.includes(ext)
}

/** 只读预览的 HTML 文档（FR：支持预览，不支持编辑） */
export const isHtmlPath = (p: string): boolean => {
  const ext = extensionOf(p)
  return !!ext && HTML_FILE_EXTENSIONS.includes(ext)
}

/** 只读预览的图片（与 Rust 侧 image_mime 白名单保持一致） */
export const isImagePath = (p: string): boolean => {
  const ext = extensionOf(p)
  return !!ext && IMAGE_FILE_EXTENSIONS.includes(ext)
}

/** 应用可打开为标签页的文件 */
export const isOpenablePath = (p: string): boolean =>
  isMarkdownPath(p) || isPlainTextPath(p) || isHtmlPath(p) || isImagePath(p)

/** 会按文本读取的文件（搜索、AI 附加、普通编辑器） */
export const isReadableTextPath = (p: string): boolean => isMarkdownPath(p) || isPlainTextPath(p)

export const OPENABLE_FILE_EXTENSIONS = [
  ...MARKDOWN_FILE_EXTENSIONS,
  ...TEXT_FILE_EXTENSIONS,
  ...HTML_FILE_EXTENSIONS,
  ...IMAGE_FILE_EXTENSIONS,
]
