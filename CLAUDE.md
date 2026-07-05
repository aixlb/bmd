# bmd 项目开发约定

bmd（Bao Markdown）：Vue 3 + Pinia + CodeMirror 6 + Tauri 2 的 Typora 式 markdown 编辑器。

常用命令：`npm run dev`（网页预览）、`npm run tauri dev`（桌面开发）、`npm test`（vitest）、`npm run build`（vue-tsc 类型检查 + vite build）。

## 插件 API 文档同步（强制）

`PLUGINS.md` 是第三方插件接口的唯一契约文档。**修改以下任何内容时，必须在同一次改动中同步更新 `PLUGINS.md` 的对应章节，并在其文末「API 变更记录」追加条目**：

- `src/lib/pluginApi.ts`（API 类型、manifest 校验、热键语法、模块装载约定）
- `src/stores/plugins.ts`（插件生命周期、目录发现、启停行为、事件桥接）
- 插件贡献点的宿主渲染（ActivityBar / StatusBar / SettingsPanel 的插件区块）
- 影响插件运行环境的配置（`src-tauri/tauri.conf.json` 的 CSP、`src-tauri/capabilities/default.json` 的 fs 权限）

同时检查：示例插件 `examples/plugins/hello-world/` 是否需要跟进；`tests/plugins.test.ts` 是否需要补测。

兼容性承诺：API 同一大版本内只增不改；破坏性调整须升大版本并在变更记录附迁移说明。

## 其他约定

- UI 文案与代码注释使用简体中文；设置项持久化用 localStorage，键统一 `bmd.` 前缀（插件私有数据 `bmd.plugin.<id>`）。
- 用户文档：`MANUAL.md`；版本记录：`CHANGELOG.md`。面向用户的功能变化记得同步。
