import { Facet } from '@codemirror/state'

export interface BmdFacetConfig {
  /** 把 markdown 中的图片地址解析为可渲染 URL（shell 负责相对路径与 Tauri asset 协议） */
  resolveImageSrc: (src: string) => string
}

const DEFAULTS: BmdFacetConfig = {
  resolveImageSrc: (src) => src,
}

export const bmdConfig = Facet.define<Partial<BmdFacetConfig>, BmdFacetConfig>({
  combine(values) {
    return { ...DEFAULTS, ...values.reduce((a, v) => ({ ...a, ...v }), {}) }
  },
})
