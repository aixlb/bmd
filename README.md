# bmd · Bao Markdown

**bmd（包 markdown）** 是一款 Typora 式所见即所得 Markdown 编辑器：极快启动、现代界面、跨 Windows / macOS。

- ⚡ **快**——Tauri 2 原生壳 + 系统 WebView，冷启动 < 1s，安装包 < 20MB
- ✍️ **Typora 手感**——即时渲染，光标进入元素展开源码标记，离开立即渲染（自研 CodeMirror 6 内核）
- 🧮 **全语法**——GFM 全套 · KaTeX 数学公式 · Mermaid 图表 · 代码高亮
- 🗂 **工作区**——文件树 / 文档大纲 / 多标签页 / 自动保存 / 图片粘贴自动入库
- 📦 **零污染**——文档本体就是 markdown 文本，编辑只改你动过的字符，绝不整篇重排
- 🌗 **现代外观**——暗色/亮色主题、macOS 毛玻璃、Windows Mica、一体化标题栏
- 🤖 **AI 写作副驾**——右侧 AI 面板（Claudian 式）：多模型可配置（Claude / DeepSeek / Kimi / Qwen / GLM / Ollama…）、流式对话、工作区 RAG 检索、diff 预览一键应用改动；Key 存系统钥匙串、无遥测

## 技术栈

Tauri 2 · Rust · Vue 3 + TypeScript + Vite · CodeMirror 6 / Lezer（自研 live-preview 内核 `bmd-core`）· KaTeX · Mermaid

## 状态

✅ M0–M6 全部里程碑已实现（2026-07-04）：自研内核（reveal-on-cursor / IME 安全 / 视口虚拟化）、
全部语法渲染（GFM/KaTeX/Mermaid/表格就地编辑）、文件树/大纲/多标签/自动保存/会话恢复、
查找替换/Slash/浮动工具条/图片粘贴/外部变更监听、导出 HTML/PDF、AI 助手（双协议多模型 + 工作区 RAG）。

**自动化测试**：69 项前端（vitest）+ 14 项 Rust（cargo test）全绿；入口 273KB gzip；dmg 6.3MB。

```bash
npm install && npm run tauri dev    # 开发
npm run tauri build                 # 打包（推 v* tag 触发 CI 双平台发布）
npx vitest run && cargo test --manifest-path src-tauri/Cargo.toml   # 测试
```

## License

MIT
