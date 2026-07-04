// ContextMenu 单例桥：App 挂载后注入，任何组件可唤起右键菜单/输入弹窗
import type { MenuItem } from '@/components/ContextMenu.vue'

interface MenuApi {
  showMenu(x: number, y: number, items: MenuItem[]): void
  askText(title: string, initial?: string): Promise<string | null>
}

let api: MenuApi | null = null

export function registerMenu(a: MenuApi) {
  api = a
}

export function menu(): MenuApi | null {
  return api
}

export type { MenuItem }
