// 文件类型判定：各打开入口（拖拽 / ⌘O / 文件树 / 启动参数）与渲染层共用

/** 可编辑的 Markdown 文档 */
export const isMarkdownPath = (p: string): boolean => /\.(md|markdown)$/i.test(p)

/** 只读预览的 HTML 文档（FR：支持预览，不支持编辑） */
export const isHtmlPath = (p: string): boolean => /\.html?$/i.test(p)

/** 应用可打开为标签页的文件 */
export const isOpenablePath = (p: string): boolean => isMarkdownPath(p) || isHtmlPath(p)
