import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(`${root}/${path}`, 'utf8')
const readJson = (path) => JSON.parse(read(path))

const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const tauriConfig = readJson('src-tauri/tauri.conf.json')
const cargoToml = read('src-tauri/Cargo.toml')
const cargoLock = read('src-tauri/Cargo.lock')

const cargoTomlVersion = cargoToml.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1]
const cargoLockVersion = cargoLock.match(
  /^\[\[package\]\]\s*\nname\s*=\s*"bmd"\s*\nversion\s*=\s*"([^"]+)"/m,
)?.[1]
const expected = packageJson.version
const versions = {
  'package-lock.json': packageLock.version,
  'package-lock.json packages[""]': packageLock.packages?.['']?.version,
  'src-tauri/Cargo.toml': cargoTomlVersion,
  'src-tauri/Cargo.lock': cargoLockVersion,
  'src-tauri/tauri.conf.json': tauriConfig.version,
}
const mismatches = Object.entries(versions).filter(([, version]) => version !== expected)

if (mismatches.length) {
  console.error(`版本不一致：package.json=${expected}`)
  for (const [file, version] of mismatches) console.error(`- ${file}=${version ?? '未找到'}`)
  process.exit(1)
}

console.log(`版本一致：${expected}`)
