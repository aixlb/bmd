// bmd 示例插件：演示 v1 插件 API 的全部贡献点。
// 用法：把整个 hello-world 文件夹拷到 {appData}/plugins/ 下，
// 在 设置 → 第三方插件 里点「重新扫描」并启用。

let statusItem = null

module.exports = {
  onload(app) {
    // 1) 左侧活动栏图标
    app.addRibbonIcon({
      icon:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">' +
        '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/>' +
        '<circle cx="9" cy="10" r="0.8" fill="currentColor"/><circle cx="15" cy="10" r="0.8" fill="currentColor"/></svg>',
      title: 'Hello World：打个招呼',
      onClick: () => {
        const data = app.loadData() || {}
        app.notice(`${data.greeting || '你好'}，来自 Hello World 插件 👋`)
      },
    })

    // 2) 状态栏项（保存句柄可随后更新文字）
    statusItem = app.addStatusBarItem({
      text: 'Hello ✨',
      title: '示例插件状态栏项',
      onClick: () => app.notice('状态栏项被点击了'),
    })

    // 3) 命令 + 热键：在光标处插入问候语
    app.addCommand({
      id: 'insert-greeting',
      name: '插入问候语',
      hotkey: 'mod+shift+h',
      callback: () => {
        const editor = app.getEditor()
        if (!editor) return app.notice('请先打开一个文档')
        const data = app.loadData() || {}
        editor.insertAtCursor(`${data.greeting || '你好'}！`)
      },
    })

    // 4) 设置页（出现在 设置 → 插件 分组）
    app.addSettingTab({
      render(el) {
        const data = app.loadData() || { greeting: '你好' }
        el.innerHTML = ''

        const label = document.createElement('div')
        label.textContent = '问候语（用于状态栏点击与插入命令）'
        label.style.cssText = 'margin-bottom:8px;color:var(--bmd-text-dim);font-size:12.5px;'

        const input = document.createElement('input')
        input.value = data.greeting || ''
        input.placeholder = '你好'
        input.style.cssText =
          'width:240px;padding:6px 10px;font:inherit;font-size:12.5px;color:var(--bmd-text);' +
          'background:transparent;border:1px solid var(--bmd-border);border-radius:7px;'
        input.addEventListener('input', () => {
          app.saveData({ ...data, greeting: input.value })
        })

        el.appendChild(label)
        el.appendChild(input)
      },
    })

    // 5) 宿主事件：切换文档时更新状态栏
    app.on('file-open', (file) => {
      if (statusItem) statusItem.setText(file ? `Hello · ${file.title}` : 'Hello ✨')
    })
  },

  onunload() {
    // ribbon/状态栏/命令/设置页由宿主自动回收，这里只清理插件自身引用
    statusItem = null
  },
}
