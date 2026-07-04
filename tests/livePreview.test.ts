import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { buildInlineDecorations } from '../core/preview/livePreview'

function stateOf(doc: string, cursor = 0) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [markdown({ base: markdownLanguage })],
  })
  ensureSyntaxTree(state, doc.length, 5_000)
  return state
}

interface Deco {
  from: number
  to: number
  kind: 'hidden' | 'class'
  cls?: string
}

function collect(doc: string, cursor: number): Deco[] {
  const state = stateOf(doc, cursor)
  const set = buildInlineDecorations(state, [{ from: 0, to: doc.length }])
  const out: Deco[] = []
  const it = set.iter()
  while (it.value) {
    const spec = it.value.spec as { class?: string }
    out.push({
      from: it.from,
      to: it.to,
      kind: it.value.spec.widget === undefined && spec.class === undefined ? 'hidden' : 'class',
      cls: spec.class,
    })
    it.next()
  }
  return out
}

const hiddenRanges = (d: Deco[]) => d.filter((x) => x.kind === 'hidden').map((x) => [x.from, x.to])
const classAt = (d: Deco[], cls: string) => d.filter((x) => x.cls === cls).map((x) => [x.from, x.to])

describe('加粗 **bold**', () => {
  const doc = 'aa **bold** bb'
  // StrongEmphasis: 3..11, 定界符 3..5 与 9..11

  it('光标在元素外：定界符隐藏，内容加粗', () => {
    const d = collect(doc, 0)
    expect(hiddenRanges(d)).toEqual([
      [3, 5],
      [9, 11],
    ])
    expect(classAt(d, 'bmd-strong')).toEqual([[3, 11]])
  })

  it('光标在元素内：定界符展开为弱色', () => {
    const d = collect(doc, 7)
    expect(hiddenRanges(d)).toEqual([])
    expect(classAt(d, 'bmd-syntax')).toEqual([
      [3, 5],
      [9, 11],
    ])
    expect(classAt(d, 'bmd-strong')).toEqual([[3, 11]])
  })

  it('光标恰在边界：不展开（Typora 行为）', () => {
    expect(hiddenRanges(collect(doc, 3))).toHaveLength(2)
    expect(hiddenRanges(collect(doc, 11))).toHaveLength(2)
  })
})

describe('嵌套 **bold *em***', () => {
  const doc = '**bold *em***'

  it('光标在外：外层与内层定界符都隐藏', () => {
    const d = collect(doc, 0)
    expect(classAt(d, 'bmd-strong')).toEqual([[0, 13]])
    expect(classAt(d, 'bmd-em')).toEqual([[7, 11]])
    // ** / * / * / ** 四组定界符全部隐藏
    expect(hiddenRanges(d).length).toBe(4)
  })
})

describe('行内代码与删除线', () => {
  it('`code` 定界符隐藏、内容标记', () => {
    const d = collect('x `code` y', 0)
    expect(hiddenRanges(d)).toEqual([
      [2, 3],
      [7, 8],
    ])
    expect(classAt(d, 'bmd-code')).toEqual([[2, 8]])
  })

  it('~~strike~~ 生效', () => {
    const d = collect('~~strike~~', 10)
    // 光标在 10 = node.to，边界不展开
    expect(hiddenRanges(d)).toEqual([
      [0, 2],
      [8, 10],
    ])
    expect(classAt(d, 'bmd-strike')).toEqual([[0, 10]])
  })
})

describe('链接 [text](url)', () => {
  const doc = 'see [bmd](https://x.dev "t") end'
  // Link: 4..28

  it('光标在外：只显示链接文本，[ 与 ](url) 隐藏', () => {
    const d = collect(doc, 0)
    expect(classAt(d, 'bmd-link')).toEqual([[5, 8]])
    expect(hiddenRanges(d)).toEqual([
      [4, 5],
      [8, 28],
    ])
  })

  it('光标在内：完整语法展开，URL 弱色', () => {
    const d = collect(doc, 6)
    expect(hiddenRanges(d)).toEqual([])
    expect(classAt(d, 'bmd-url')).toHaveLength(1)
  })
})

describe('ATX 标题', () => {
  const doc = '## 标题\n\n正文'

  it('光标不在标题行：# 与其后空格一起隐藏', () => {
    const d = collect(doc, doc.length)
    expect(hiddenRanges(d)).toEqual([[0, 3]])
  })

  it('光标在标题行：# 展开为弱色', () => {
    const d = collect(doc, 4)
    expect(hiddenRanges(d)).toEqual([])
    expect(classAt(d, 'bmd-syntax')).toEqual([[0, 2]])
  })
})

describe('普通文本', () => {
  it('无任何装饰', () => {
    expect(collect('plain text without markup', 3)).toEqual([])
  })
})
