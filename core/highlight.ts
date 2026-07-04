import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// 代码块内嵌语言的高亮（One Dark 系，颜色走 CSS 变量以适配双主题）。
// markdown 自身的标记样式由 livePreview 的 bmd-* 类负责，这里只管代码 token。
const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: 'var(--bmd-syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--bmd-syn-string)' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: 'var(--bmd-syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.integer, t.float, t.bool, t.null], color: 'var(--bmd-syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--bmd-syn-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--bmd-syn-type)' },
  { tag: [t.definition(t.variableName), t.propertyName, t.attributeName], color: 'var(--bmd-syn-property)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--bmd-syn-operator)' },
  { tag: [t.regexp, t.escape], color: 'var(--bmd-syn-regexp)' },
  { tag: [t.meta, t.annotation], color: 'var(--bmd-syn-meta)' },
])

export const bmdSyntaxHighlighting = syntaxHighlighting(codeHighlight)
