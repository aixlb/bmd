// 应用级菜单/对话框端口：只声明纯类型，由 App 注入 Vue 实现。
export interface MenuItem {
  label: string
  danger?: boolean
  action: () => void | Promise<void>
}

export interface ChoiceItem {
  value: string
  label: string
  primary?: boolean
  danger?: boolean
}

export interface MenuApi {
  showMenu(x: number, y: number, items: MenuItem[]): void
  askText(title: string, initial?: string): Promise<string | null>
  askChoice(title: string, message: string, items: ChoiceItem[]): Promise<string | null>
}

let api: MenuApi | null = null

export function registerMenu(a: MenuApi | null) {
  api = a
}

export function menu(): MenuApi | null {
  return api
}
