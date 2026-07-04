import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'

// Slash 命令（FR-13）：行首输入 / 弹出块插入菜单

interface SlashItem {
  label: string
  detail: string
  insert: string
  /** 光标相对插入起点的偏移 */
  cursor: number
}

const ITEMS: SlashItem[] = [
  { label: '标题 1', detail: '# ', insert: '# ', cursor: 2 },
  { label: '标题 2', detail: '## ', insert: '## ', cursor: 3 },
  { label: '标题 3', detail: '### ', insert: '### ', cursor: 4 },
  { label: '表格', detail: '3×2', insert: '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n', cursor: 2 },
  { label: '代码块', detail: '```', insert: '```\n\n```', cursor: 3 },
  { label: '公式块', detail: '$$', insert: '$$\n\n$$', cursor: 3 },
  { label: 'Mermaid 图表', detail: '流程图', insert: '```mermaid\ngraph TD\n  A --> B\n```', cursor: 11 },
  { label: '引用', detail: '> ', insert: '> ', cursor: 2 },
  { label: '无序列表', detail: '- ', insert: '- ', cursor: 2 },
  { label: '任务列表', detail: '- [ ] ', insert: '- [ ] ', cursor: 6 },
  { label: '分割线', detail: '---', insert: '---\n', cursor: 4 },
  { label: '图片', detail: '![]()', insert: '![描述](路径)', cursor: 2 },
]

function slashSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/^\s*\/[^\s/]*/)
  if (!match && !context.explicit) return null
  if (!match) return null
  const slashAt = match.text.indexOf('/')
  const query = match.text.slice(slashAt + 1)
  const options: Completion[] = ITEMS.filter(
    (it) => !query || it.label.includes(query) || it.detail.includes(query),
  ).map((it) => ({
    label: it.label,
    detail: it.detail,
    apply(view, _c, _from, to) {
      view.dispatch({
        changes: { from: match.from + slashAt, to, insert: it.insert },
        selection: { anchor: match.from + slashAt + it.cursor },
        userEvent: 'input.complete',
      })
    },
  }))
  return {
    from: match.from,
    to: match.to,
    options,
    filter: false,
  }
}

export const slashMenu = autocompletion({
  override: [slashSource],
  icons: false,
  activateOnTyping: true,
  defaultKeymap: true,
})
