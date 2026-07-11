# bmd 插件开发手册

> **文档版本**：API v1 · 对应 bmd ≥ 1.0.3 · 最后更新 2026-07-11
>
> **维护约定**：本手册是插件接口的唯一契约文档。任何影响插件开发者的代码改动
>（`src/lib/pluginApi.ts`、`src/stores/plugins.ts`、宿主贡献点的渲染逻辑、CSP 与文件系统权限），
> **必须**在同一次提交中同步更新本手册的对应章节，并在文末「[API 变更记录](#api-变更记录)」追加条目。

---

## 目录

1. [概述](#概述)
2. [快速开始](#快速开始)
3. [插件目录与安装](#插件目录与安装)
4. [manifest.json 参考](#manifestjson-参考)
5. [main.js 与生命周期](#mainjs-与生命周期)
6. [API 参考](#api-参考)
7. [热键语法](#热键语法)
8. [宿主事件](#宿主事件)
9. [主题与样式](#主题与样式)
10. [调试](#调试)
11. [限制与最佳实践](#限制与最佳实践)
12. [FAQ](#faq)
13. [API 变更记录](#api-变更记录)

---

## 概述

bmd 支持动态外部插件：把插件文件夹放进插件目录，在 **设置 → 第三方插件** 里启用即可生效，**无需重新编译应用**。

一个插件可以向宿主注册以下能力（全部可选、可组合）：

| 贡献点 | 出现位置 | 注册方法 |
| --- | --- | --- |
| Ribbon 图标 | 左侧活动栏 | `app.addRibbonIcon()` |
| 状态栏项 | 底部状态栏右侧 | `app.addStatusBarItem()` |
| 命令 + 全局热键 | 键盘 | `app.addCommand()` |
| 设置页 | 设置弹窗左侧「插件」分组 | `app.addSettingTab()` |
| 通知 | 右上角轻提示 | `app.notice()` |

此外插件可以读写当前编辑器内容、订阅宿主事件、持久化自己的数据。

**运行模型与安全**：插件与应用运行在同一 JS 上下文，没有沙箱。启用一个插件等于信任它的全部代码——请只安装可信来源的插件。应用 CSP 为 `script-src 'self' blob:`（无 `unsafe-eval`）：插件代码经 Blob 模块装载，插件内不能使用 `eval` / `new Function`。

## 快速开始

三步写出第一个插件：

**1. 建目录**——在插件目录（见下节）新建文件夹 `my-first-plugin/`。

**2. 写两个文件：**

`manifest.json`

```json
{
  "id": "my-first-plugin",
  "name": "我的第一个插件",
  "version": "0.1.0"
}
```

`main.js`

```js
module.exports = {
  onload(app) {
    app.notice('插件已启用 🎉')
    app.addCommand({
      id: 'hello',
      name: '打招呼',
      hotkey: 'mod+shift+u',
      callback: () => app.getEditor()?.insertAtCursor('Hello, bmd!'),
    })
  },
}
```

**3. 启用**——打开 bmd，`Ctrl/⌘+,` 进设置 → 第三方插件 → 「重新扫描」→ 打开开关。按 `Ctrl/⌘+Shift+U` 试试。

仓库内 `examples/plugins/hello-world/` 是覆盖全部 API 的完整示例，可直接拷入插件目录体验。

## 插件目录与安装

| 平台 | 路径 |
| --- | --- |
| Windows | `%APPDATA%\com.aixlb.bmd\plugins\` |
| macOS | `~/Library/Application Support/com.aixlb.bmd/plugins/` |

在 **设置 → 第三方插件** 页可一键「打开插件目录」。目录结构：

```
plugins/
└── <插件id>/
    ├── manifest.json   # 必需
    └── main.js         # 必需
```

安装 = 拷入文件夹 + 设置里「重新扫描」+ 打开开关。卸载 = 关闭开关 + 删除文件夹。启用状态持久保存（localStorage 键 `bmd.plugins.enabled`），重启应用后自动恢复加载。

**注意**：插件功能仅在桌面应用中可用；浏览器预览环境（直接开 `npm run dev` 的网页）无文件系统，插件管理页会显示提示。

## manifest.json 参考

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `id` | string | ✅ | 唯一标识，须匹配 `/^[a-z0-9][a-z0-9-_]*$/i`（字母数字开头，仅含字母数字、`-`、`_`）。建议与文件夹同名 |
| `name` | string | ✅ | 显示名（插件管理页、设置页导航默认标题） |
| `version` | string | ✅ | 插件自身版本（语义化版本） |
| `description` | string | – | 一句话说明，显示在插件管理页 |
| `author` | string | – | 作者，显示在插件管理页 |
| `minAppVersion` | string | – | 要求的最低 bmd 版本。当前 bmd 版本低于此值时拒绝加载并在管理页显示原因 |

校验失败（缺字段 / id 非法 / JSON 解析失败 / 缺 main.js）的插件会出现在管理页并显示错误，开关置灰不可启用。

## main.js 与生命周期

CommonJS 约定，导出 `onload` / `onunload`。装载机制：宿主把 `main.js` 源码包上 CommonJS 垫片后经 **Blob URL 以 ES 模块方式导入**（bmd ≥ 1.0.1；此前为 `new Function`）。对插件作者透明——源码格式不变，但顶层代码运行于模块作用域（`this` 为 `undefined`、自动严格模式），依赖顶层 `this` 或非严格语义的旧插件需自查：

```js
module.exports = {
  /** 启用时调用。可为 async。抛错 = 加载失败（宿主会回收已注册的贡献点并自动禁用） */
  onload(app) { /* 注册能力 */ },

  /** 禁用/应用关闭前调用。可选 */
  onunload() { /* 清理插件自建的资源 */ },
}
```

也兼容 `module.exports.default = { onload, onunload }`（打包器输出的 default 导出形态）。

生命周期规则：

- **启用**：读 `main.js` → 执行模块代码 → 调用 `onload(app)`。
- **禁用**：调用 `onunload()` → 宿主**自动回收**该插件注册的全部 ribbon 图标、状态栏项、命令、设置页，并取消事件订阅。`onunload` 里只需清理插件自己创建的东西（定时器、自建 DOM、WebSocket 等）。
- **应用关闭**：与禁用相同，宿主会调用每个已加载插件的 `onunload()`，随后释放宿主事件桥；启用设置保持不变，下次启动仍会自动加载。
- **加载失败**：`onload` 抛错或模块非法时，已注册的贡献点会被回收，插件自动回退为禁用，失败原因显示在插件管理页。
- 没有热重载：改完 `main.js` 后需在设置里关→开（或重启应用）。

## API 参考

`onload(app)` 收到的 `app` 是本插件专属的宿主接口实例。完整 TypeScript 类型见 `src/lib/pluginApi.ts` 中的 `BmdPluginApp`。

### app.version / app.manifest

```ts
app.version: string          // 宿主 bmd 版本，与应用安装包版本一致
app.manifest: PluginManifest // 本插件的 manifest 内容
```

### app.addRibbonIcon(opts)

在左侧活动栏（内置按钮之后）追加一个图标按钮。

```ts
app.addRibbonIcon(opts: {
  icon: string          // 完整 <svg> 字符串
  title: string         // 悬停提示
  onClick: () => void
}): void
```

`icon` 要求：`viewBox="0 0 24 24"`，描边用 `stroke="currentColor"`（自动适配明暗主题与悬停态），显示尺寸 20×20。

```js
app.addRibbonIcon({
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/></svg>',
  title: '我的功能',
  onClick: () => app.notice('clicked'),
})
```

### app.addStatusBarItem(opts) → StatusItemHandle

在底部状态栏右侧追加一项，返回句柄可后续更新文字或移除。

```ts
app.addStatusBarItem(opts: {
  text: string
  title?: string        // 悬停提示
  onClick?: () => void  // 提供则可点击（悬停高亮）
}): { setText(text: string): void; remove(): void }
```

```js
const item = app.addStatusBarItem({ text: '待同步 3' })
item.setText('已同步 ✓')
```

### app.addCommand(cmd)

注册命令。带 `hotkey` 时为全局快捷键，**优先级高于宿主内置快捷键**（注意避开 `mod+s` 等常用键，见[热键语法](#热键语法)）。

```ts
app.addCommand(cmd: {
  id: string            // 插件内唯一
  name: string          // 命令名
  hotkey?: string       // 如 'mod+shift+h'
  callback: () => void
}): void
```

### app.addSettingTab(tab)

在设置弹窗左侧「插件」分组下加一个导航项与对应页面。

```ts
app.addSettingTab(tab: {
  title?: string                       // 导航显示名，默认取 manifest.name
  render: (container: HTMLElement) => void
}): void
```

渲染约定：用户每次切到该页，宿主会**清空容器后重新调用** `render(container)`——不要依赖上次渲染残留的 DOM 状态，需要持久的状态放 `saveData`。`render` 抛错时页面显示错误信息，不影响宿主。

```js
app.addSettingTab({
  render(el) {
    const data = app.loadData() ?? { interval: 5 }
    const input = document.createElement('input')
    input.type = 'number'
    input.value = data.interval
    input.addEventListener('input', () => app.saveData({ ...data, interval: Number(input.value) }))
    el.appendChild(input)
  },
})
```

### app.notice(message, timeoutMs?)

右上角轻提示。`timeoutMs` 默认 3000；传 `0` 或负数则不自动消失（点击关闭）。

```ts
app.notice(message: string, timeoutMs?: number): void
```

### app.getEditor() → PluginEditor | null

获取当前活动编辑器的操作面；没有打开文档时返回 `null`（每次调用都判空）。

```ts
interface PluginEditor {
  getValue(): string                    // 全文
  getSelection(): string                // 选区文本（无选区 = ''）
  replaceSelection(text: string): void  // 替换选区（无选区 = 在光标处插入）
  insertAtCursor(text: string): void    // 在光标处插入，光标移到插入内容之后
}
```

### app.getActiveFile()

```ts
app.getActiveFile(): { path: string | null; title: string } | null
// path 为 null 表示尚未保存的新建文件；无打开文档时整体返回 null
```

### app.on(event, cb) → 取消函数

订阅宿主事件（事件与载荷见[宿主事件](#宿主事件)）。返回取消订阅函数；插件禁用时宿主也会自动取消，通常无需手动处理。

```ts
app.on(event: 'file-open' | 'theme-change', cb: (payload?: unknown) => void): () => void
```

### app.loadData() / app.saveData(data)

插件私有数据持久化（JSON 序列化，存 localStorage 键 `bmd.plugin.<id>`）。适合配置项等小数据，不适合大文档。

```ts
app.loadData<T = unknown>(): T | null   // 无数据或解析失败返回 null
app.saveData(data: unknown): void
```

## 热键语法

格式：`修饰键+...+主键`，全小写，`+` 分隔。

| 记号 | 含义 |
| --- | --- |
| `mod` | macOS 上 = ⌘（meta），其余平台 = Ctrl。**推荐使用** |
| `ctrl` / `meta`（别名 `cmd`）/ `shift` / `alt`（别名 `option`） | 对应修饰键 |
| 主键 | 与 `KeyboardEvent.key` 的小写形式比较，如 `h`、`9`、`f5`、`enter` |

规则：修饰键**精确匹配**（`ctrl+j` 不会命中 Ctrl+Alt+J）；插件热键在宿主内置快捷键**之前**分发，同名冲突时插件生效——避开宿主已用的：`mod` + `p j , s n o w \ / = - 0 1~9`、`mod+shift` + `l s n o`、`ctrl+tab`。

## 宿主事件

| 事件 | 触发时机 | 载荷 |
| --- | --- | --- |
| `file-open` | 活动标签切换，或临时预览标签轮播到另一文件（含打开/关闭文件导致的切换） | `{ path: string \| null, title: string }`；全部关闭时为 `null` |
| `theme-change` | 明暗主题切换 | `'dark'` \| `'light'` |

## 主题与样式

插件渲染的 DOM（设置页、自建元素）请使用宿主 CSS 变量适配明暗主题：

| 变量 | 用途 |
| --- | --- |
| `--bmd-text` / `--bmd-text-dim` / `--bmd-text-faint` | 正文 / 次要 / 弱化文字 |
| `--bmd-panel` | 面板背景 |
| `--bmd-border` | 边框 |
| `--bmd-accent` / `--bmd-accent-a` | 强调色 |
| `--bmd-accent-gradient` | 品牌渐变 |
| `--bmd-font-size` | 正文字号（用户可调） |

## 调试

- 用 `npm run tauri dev` 启动开发版，webview 里可打开 DevTools 看控制台；插件的 `console.log` 直接可见。宿主侧插件日志带 `[bmd]` 前缀。
- 加载失败的原因（manifest 错误、`onload` 抛错、版本不满足）显示在 **设置 → 第三方插件** 对应条目下。
- 改完代码后在设置里 关 → 开 即可重新加载该插件，无需重启应用。

## 限制与最佳实践

- **无模块系统**：`main.js` 以 CommonJS 形式执行，但**没有 `require`**，不能引用 npm 包或其他文件——需要依赖时用打包器（esbuild/rollup）把插件打成单文件 `main.js`。
- **同上下文运行**：可以访问 `window`/`document`，但请勿改动宿主 DOM 结构（版本升级不保证结构稳定），只在宿主给的容器（设置页 `container`）里渲染。
- **`onload` 不要做重活**：耗时初始化放异步任务，避免拖慢应用启动。
- **自建资源自己清理**：定时器、事件监听（宿主 `app.on` 之外的）、自建 DOM 在 `onunload` 里移除。
- **`getEditor()` 随用随取**：不要缓存编辑器实例，切换标签后旧引用可能失效。
- 数据量大时不要用 `saveData`（localStorage 容量有限），可提示用户选择导出路径。

## FAQ

**改了 main.js 没生效？** 需要在设置里禁用再启用该插件（重新加载源码），或重启应用。

**能注册编辑器语法扩展/渲染器吗？** v1 暂不支持（未暴露 CodeMirror 扩展点），列入后续版本考虑。

**两个插件热键冲突怎么办？** 按注册顺序（= 启用顺序）先到先得，后注册的不触发。请在文档里注明你的默认热键，便于用户排查。

**插件能发网络请求吗？** `fetch` 受应用 CSP 约束：`connect-src 'self' ipc: http://ipc.localhost`，只能请求应用自身与 Tauri IPC 端点，**不能直接访问外部网络**（此约束自 v1.0.0 起实际存在，早期文档「未额外限制」为勘误前的错误表述）。

---

## API 变更记录

> 新条目追加在最上方。格式：`### vX（bmd 版本 · 日期）` + 变更列表（新增/变更/废弃/破坏性）。
> 兼容性承诺：同一大版本内只增不改；破坏性调整升大版本并附迁移说明。

### v1.5（bmd 1.0.5 · 2026-07-11）

- **修复（版本同步，API 面无变化）**：宿主 `app.version` 与 `minAppVersion` 校验不再维护独立硬编码，改为自动读取应用发布版本；插件接口、manifest、生命周期与权限约束均无变化。

### v1.4（bmd 1.0.4 · 2026-07-11）

- **修复（生命周期，API 面无变化）**：应用卸载时显式调用已加载插件的 `onunload()`，回收贡献点、事件订阅与宿主监听；插件启用状态不受影响。`app` API、manifest、源码格式及示例插件均无需调整。
- **修复（宿主事件，API 面无变化）**：临时预览标签复用同一标签 ID 轮播文件时，现在也会按实际文件变化派发 `file-open`；事件名与载荷格式不变，示例插件无需调整。

### v1.3（bmd 1.0.3 · 2026-07-10）

- **变更（版本同步，API 面无变化）**：宿主 `app.version` 与 `minAppVersion` 校验所用应用版本同步为 `1.0.3`；插件接口、生命周期、贡献点和权限约束均无变化。

### v1.2（bmd 1.0.2 · 2026-07-06）

- **变更（运行环境，API 面无变化）**：应用 CSP 显式声明 `connect-src 'self' ipc: http://ipc.localhost`（此前未声明，回落到 `default-src 'self'` 并误拦 Tauri IPC 探测）。插件可见行为不变：`fetch` 过去与现在都限同源，外部网络请求均被拦截。同时勘误 FAQ 中「`connect-src` 未额外限制」的错误表述。

### v1.1（bmd 1.0.1 · 2026-07-05）

- **变更（装载机制，源码格式不变）**：插件模块由 `new Function` 改为 Blob URL ES 模块导入；应用 CSP 去掉 `'unsafe-eval'`、`script-src` 收紧为 `'self' blob:`。
  - 影响一：插件顶层代码运行于模块作用域（自动严格模式，顶层 `this` 为 `undefined`）。常规 `module.exports = {...}` 写法不受影响。
  - 影响二：插件内部不能再使用 `eval` / `new Function`（会被 CSP 拦截）。
  - 迁移：绝大多数插件无需改动；依赖上述两点的插件需要调整实现。

### v1（bmd 1.0.1 · 2026-07-05）

初版发布。包含：

- 插件装载：`{appData}/plugins/<id>/{manifest.json, main.js}`，CommonJS `onload`/`onunload` 生命周期，启用状态持久化，失败自动禁用与原因展示。
- manifest 字段：`id`、`name`、`version`、`description`、`author`、`minAppVersion`。
- `app` API：`version`、`manifest`、`addRibbonIcon`、`addStatusBarItem`（含 `setText`/`remove` 句柄）、`addCommand`（含全局热键）、`addSettingTab`、`notice`、`getEditor`（`getValue`/`getSelection`/`replaceSelection`/`insertAtCursor`）、`getActiveFile`、`on`（`file-open`、`theme-change`）、`loadData`/`saveData`。
