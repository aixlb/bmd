# bmd · Bao Markdown

**bmd（包 markdown）** 是一款 Typora 式所见即所得 Markdown 编辑器：极快启动、现代界面、跨 Windows / macOS。

- ⚡ **快**——Tauri 2 原生壳 + 系统 WebView，冷启动 < 1s，安装包 < 20MB
- ✍️ **Typora 手感**——即时渲染，光标进入元素展开源码标记，离开立即渲染（自研 CodeMirror 6 内核）
- 🧮 **全语法**——GFM 全套 · KaTeX 数学公式 · Mermaid 图表 · 代码高亮
- 🗂 **工作区**——文件树 / 文档大纲 / 多标签页 / 自动保存 / 图片粘贴自动入库
- 📦 **零污染**——文档本体就是 markdown 文本，编辑只改你动过的字符，绝不整篇重排
- 🌗 **现代外观**——暗色/亮色主题、macOS 毛玻璃、Windows Mica、一体化标题栏

## 文档

- [需求文档](docs/REQUIREMENTS.md)
- [设计文档](docs/DESIGN.md)

## 技术栈

Tauri 2 · Rust · Vue 3 + TypeScript + Vite · CodeMirror 6 / Lezer（自研 live-preview 内核 `bmd-core`）· KaTeX · Mermaid

## 状态

🚧 开发中（里程碑见需求文档 §5）。

## License

MIT
