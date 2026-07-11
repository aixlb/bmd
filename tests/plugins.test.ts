// 第三方插件运行时测试：manifest 校验、热键匹配、版本比较、装载/卸载与贡献点回收
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import {
  compareVersions,
  loadPluginModule,
  matchHotkey,
  validateManifest,
} from '../src/lib/pluginApi'
import { createMockIpc, setIpc } from '../src/lib/ipc'
import { usePlugins } from '../src/stores/plugins'
import { useTabs } from '../src/stores/tabs'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  setIpc(createMockIpc({ '/ws/a.md': '# A', '/ws/b.md': '# B' }))
  delete (globalThis as Record<string, unknown>).__openedFiles
})

afterEach(() => {
  usePlugins().dispose()
})

describe('manifest 校验', () => {
  it('合法 manifest 通过', () => {
    expect(validateManifest({ id: 'hello-world', name: 'Hello', version: '0.1.0' })).toBeNull()
  })

  it('缺字段或非法 id 报错', () => {
    expect(validateManifest(null)).toContain('不是对象')
    expect(validateManifest({ name: 'x', version: '1' })).toContain('id')
    expect(validateManifest({ id: '包/坏', name: 'x', version: '1' })).toContain('id')
    expect(validateManifest({ id: 'ok', version: '1' })).toContain('name')
    expect(validateManifest({ id: 'ok', name: 'x' })).toContain('version')
  })
})

describe('版本比较', () => {
  it('语义化比较', () => {
    expect(compareVersions('1.0.1', '1.0.1')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.2', '1.1.9')).toBe(1)
    expect(compareVersions('2.0', '10.0')).toBe(-1)
  })
})

describe('热键匹配', () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    new KeyboardEvent('keydown', { key, ...mods })

  it('mod 在非 mac 平台等于 ctrl', () => {
    expect(matchHotkey('mod+shift+h', ev('H', { ctrlKey: true, shiftKey: true }), false)).toBe(true)
    expect(matchHotkey('mod+shift+h', ev('H', { metaKey: true, shiftKey: true }), false)).toBe(false)
  })

  it('mod 在 mac 平台等于 meta', () => {
    expect(matchHotkey('mod+k', ev('k', { metaKey: true }), true)).toBe(true)
    expect(matchHotkey('mod+k', ev('k', { ctrlKey: true }), true)).toBe(false)
  })

  it('修饰键必须精确匹配', () => {
    expect(matchHotkey('ctrl+j', ev('j', { ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(matchHotkey('ctrl+alt+j', ev('j', { ctrlKey: true, altKey: true }), false)).toBe(true)
  })
})

describe('模块装载', () => {
  it('CommonJS 导出 onload 生效', async () => {
    const mod = await loadPluginModule('module.exports = { onload() { globalThis.__loaded = 1 } }')
    expect(typeof mod.onload).toBe('function')
  })

  it('缺 onload 抛错', async () => {
    await expect(loadPluginModule('module.exports = {}')).rejects.toThrow('onload')
  })
})

describe('插件启停与贡献点回收', () => {
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0' }
  const code = `
    module.exports = {
      onload(app) {
        app.addRibbonIcon({ icon: '<svg></svg>', title: 'demo', onClick() {} })
        const item = app.addStatusBarItem({ text: 'demo' })
        item.setText('demo2')
        app.addCommand({ id: 'run', name: '运行', hotkey: 'mod+shift+9', callback() { globalThis.__ran = true } })
        app.addSettingTab({ render(el) { el.textContent = 'hi' } })
        app.on('file-open', () => {})
        app.saveData({ n: 1 })
      },
      onunload() { globalThis.__unloaded = true },
    }
  `

  it('加载后贡献点齐全、数据持久化、热键可触发', async () => {
    const plugins = usePlugins()
    await plugins.loadFromSource(manifest, code)

    expect(plugins.ribbons).toHaveLength(1)
    expect(plugins.statusItems).toHaveLength(1)
    expect(plugins.statusItems[0].text).toBe('demo2')
    expect(plugins.commands).toHaveLength(1)
    expect(plugins.settingTabs).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('bmd.plugin.demo') ?? '{}')).toEqual({ n: 1 })

    const e = new KeyboardEvent('keydown', { key: '9', ctrlKey: true, shiftKey: true })
    expect(plugins.handleKey(e)).toBe(true)
    expect((globalThis as Record<string, unknown>).__ran).toBe(true)

    // 设置页渲染
    const host = document.createElement('div')
    plugins.settingTabs[0].render(host)
    expect(host.textContent).toBe('hi')
  })

  it('卸载后贡献点清空并调用 onunload', async () => {
    const plugins = usePlugins()
    await plugins.loadFromSource(manifest, code)
    plugins.unload('demo')

    expect(plugins.ribbons).toHaveLength(0)
    expect(plugins.statusItems).toHaveLength(0)
    expect(plugins.commands).toHaveLength(0)
    expect(plugins.settingTabs).toHaveLength(0)
    expect((globalThis as Record<string, unknown>).__unloaded).toBe(true)
  })

  it('onload 抛错不留半截状态', async () => {
    const plugins = usePlugins()
    const bad = `module.exports = { onload() { throw new Error('boom') } }`
    await expect(plugins.loadFromSource(manifest, bad)).rejects.toThrow('boom')
  })

  it('启用列表持久化', async () => {
    const plugins = usePlugins()
    const spy = vi.spyOn(Storage.prototype, 'setItem')
    await plugins.disable('nope')
    expect(spy).toHaveBeenCalledWith('bmd.plugins.enabled', '[]')
  })

  it('应用 dispose 会回收实例与宿主监听，但保留启用设置', async () => {
    const plugins = usePlugins()
    plugins.enabledIds = ['demo']
    await plugins.init()
    await plugins.loadFromSource(manifest, code)
    plugins.dispose()
    expect(plugins.ribbons).toHaveLength(0)
    expect(plugins.commands).toHaveLength(0)
    expect(plugins.enabledIds).toEqual(['demo'])
  })

  it('预览标签复用同一 ID 换文件时仍派发 file-open', async () => {
    const plugins = usePlugins()
    await plugins.loadFromSource(
      manifest,
      `module.exports = { onload(app) { app.on('file-open', (file) => {
        globalThis.__openedFiles = [...(globalThis.__openedFiles || []), file && file.title]
      }) } }`,
    )
    await plugins.init()
    const tabs = useTabs()

    const first = await tabs.previewFile('/ws/a.md')
    await nextTick()
    const second = await tabs.previewFile('/ws/b.md')
    await nextTick()

    expect(second.id).toBe(first.id)
    expect((globalThis as Record<string, unknown>).__openedFiles).toEqual(['a.md', 'b.md'])
  })
})
