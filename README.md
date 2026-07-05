# bmd · Bao Markdown

**bmd（包 markdown）** 是一款所见即所得（WYSIWYG）Markdown 编辑器：极快启动、现代界面、跨 Windows / macOS。

- ⚡ **快**——Tauri 2 原生壳 + 系统 WebView，冷启动 < 1s，安装包 < 20MB
- ✍️ **即时渲染手感**——光标进入元素展开源码标记，离开立即渲染（自研 CodeMirror 6 内核）
- 🧮 **全语法**——GFM 全套 · KaTeX 数学公式 · Mermaid 图表 · 代码高亮
- 🗂 **工作区**——文件树 / 文档大纲 / 多标签页 / 自动保存 / 图片粘贴自动入库
- 📦 **零污染**——文档本体就是 markdown 文本，编辑只改你动过的字符，绝不整篇重排
- 🌗 **现代外观**——暗色/亮色主题、macOS 毛玻璃、Windows Mica、一体化标题栏
- 🤖 **AI 写作副驾**——右侧 AI 面板：多模型可配置（Claude / DeepSeek / Kimi / Qwen / GLM / Ollama…）、流式对话、工作区 RAG 检索、diff 预览一键应用改动；Key 存系统钥匙串、无遥测

## 技术栈

Tauri 2 · Rust · Vue 3 + TypeScript + Vite · CodeMirror 6 / Lezer（自研 live-preview 内核 `bmd-core`）· KaTeX · Mermaid

## 下载与文档

- **[GitHub Releases](https://github.com/aixlb/bmd/releases)**——Windows NSIS 安装包 / macOS dmg（Apple Silicon + Intel）
- **[用户手册](MANUAL.md)**——安装、编辑、工作区、导出、AI 配置与快捷键总表
- **[更新日志](CHANGELOG.md)**——版本变更与升级说明

## 开发

```bash
npm install && npm run tauri dev    # 开发
npm run tauri build                 # 打包（推 v* tag 触发 CI 双平台发布）
npx vitest run && cargo test --manifest-path src-tauri/Cargo.toml   # 测试
```

## License

MIT
