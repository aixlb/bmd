import { describe, expect, it, vi } from 'vitest'
import { parseTable, serializeTable, TableWidget } from '../core/preview/widgets'
import { buildExportHtml } from '../src/export/html'

describe('表格序列化（M4 就地编辑的写回路径）', () => {
  it('parse → serialize 往返稳定', () => {
    const src = '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a | b | c |'
    const model = parseTable(src)!
    const out = serializeTable(model)
    // 再解析应得到相同模型
    expect(parseTable(out)).toEqual(model)
    expect(out).toContain(':---:')
    expect(out).toContain('---:')
  })

  it('单元格中的管道被转义', () => {
    const out = serializeTable({
      header: ['a|b', 'c'],
      aligns: ['left', 'left'],
      rows: [['x', 'y|z']],
    })
    expect(out).toContain('a\\|b')
    expect(parseTable(out)!.rows[0][1]).toBe('y|z')
  })

  it('单元格中的换行折叠为空格', () => {
    const out = serializeTable({
      header: ['h'],
      aligns: ['left'],
      rows: [['多\n行']],
    })
    expect(out).toContain('多 行')
  })

  it('就地编辑工具条提供整表复制入口', () => {
    const dom = new TableWidget('| a | b |\n| - | - |\n| 1 | 2 |').toDOM({} as never)
    const labels = [...dom.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toContain('复制')
  })

  it('点击整表复制会写入当前 Markdown 表格', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const src = '| a | b |\n| - | - |\n| 1 | 2 |'
    const dom = new TableWidget(src).toDOM({} as never)
    const button = [...dom.querySelectorAll('button')].find((item) => item.textContent === '复制')!
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(serializeTable(parseTable(src)!)))
  })
})

describe('导出 HTML（FR-28）', () => {
  it('完整文档：标题/加粗/任务/表格/代码/数学全部渲染', async () => {
    const md = [
      '# 标题',
      '',
      '**加粗** 与 $e=mc^2$',
      '',
      '$$',
      '\\int x dx',
      '$$',
      '',
      '- [x] 完成',
      '- [ ] 待办',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = 1',
      '```',
    ].join('\n')
    const html = await buildExportHtml(md, { title: '测试文档', theme: 'dark' })

    expect(html).toContain('<title>测试文档</title>')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<strong>加粗</strong>')
    // KaTeX MathML 输出（零字体依赖）
    expect(html).toContain('<math')
    expect(html.match(/<math/g)!.length).toBeGreaterThanOrEqual(2)
    // 任务列表
    expect(html).toContain('type="checkbox" disabled checked')
    expect(html).toContain('type="checkbox" disabled>')
    // 表格
    expect(html).toContain('<table>')
    // 代码块 Lezer 高亮（tok-* 类）
    expect(html).toContain('data-lang="js"')
    expect(html).toContain('tok-keyword')
    // 自包含：无外链资源
    expect(html).not.toContain('src="http')
    expect(html).not.toContain('link rel')
  })

  it('HTML 内容被转义（防 XSS）', async () => {
    const html = await buildExportHtml('<script>alert(1)</script>', {
      title: 't',
      theme: 'light',
    })
    expect(html).not.toContain('<script>alert')
  })
})

describe('PDF 静默导出（D8 V2）前端链路', () => {
  it('dirnameOf 兼容两种分隔符', async () => {
    const { dirnameOf } = await import('../src/export')
    expect(dirnameOf('/a/b/c.md')).toBe('/a/b')
    expect(dirnameOf('C:\\docs\\c.md')).toBe('C:\\docs')
    expect(dirnameOf('c.md')).toBeNull()
    expect(dirnameOf('/c.md')).toBeNull()
  })

  it('mock ipc 的 exportPdfNative 拒绝（触发调用方回退）', async () => {
    const { createMockIpc } = await import('../src/lib/ipc')
    await expect(createMockIpc().exportPdfNative('<p>x</p>', null, '/demo/x.pdf')).rejects.toThrow()
  })
})
