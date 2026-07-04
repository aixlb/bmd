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

export async function renderChatMarkdown(src: string): Promise<string> {
  const hit = cache.get(src)
  if (hit) return hit
  const md = await load()
  const html = md.render(src)
  if (cache.size > 300) cache.clear()
  cache.set(src, html)
  return html
}
