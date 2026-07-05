// 聊天消息的轻量 markdown 渲染（懒加载 markdown-it，输出净化过的 HTML）
import type MarkdownIt from 'markdown-it'

let mdP: Promise<MarkdownIt> | null = null

function load(): Promise<MarkdownIt> {
  mdP ??= import('markdown-it').then(
    (m) => new m.default({ html: false, linkify: true, breaks: true }),
  )
  return mdP
}

const cache = new Map<string, string>()

/** @param cacheable 流式中间态传 false：一次性内容不进缓存，避免挤掉有效条目 */
export async function renderChatMarkdown(src: string, cacheable = true): Promise<string> {
  if (cacheable) {
    const hit = cache.get(src)
    if (hit) return hit
  }
  const md = await load()
  const html = md.render(src)
  if (cacheable) {
    if (cache.size > 300) cache.clear()
    cache.set(src, html)
  }
  return html
}
