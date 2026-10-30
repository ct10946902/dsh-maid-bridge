/**
 * dsh-maid-bridge — 安装 / 卸载 / 自检
 * ============================================================================
 * 官方首选路径是 DSH 的 Plugin Manager（install_bundle），本脚本是等价兜底：
 *   ① 先 import 一次插件入口，确认能被 Node 加载（语法错/依赖缺失当场暴露）
 *   ② 备份 profile 的 package.json → dependencies 里加 link: 依赖 → bundles 加入
 *   ③ 建 Junction 到 node_modules
 *   ④ 复核，失败自动回滚
 * 绝不重启 DSH（时机交给主人）。
 *
 * 用法：
 *   node scripts/install.mjs               安装到 desktop profile
 *   node scripts/install.mjs --uninstall    卸载
 *   node scripts/install.mjs --dry-run      只看会做什么
 * ============================================================================
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 && args[profileIndex + 1] ? args[profileIndex + 1] : 'desktop'
const uninstall = args.includes('--uninstall')
const dryRun = args.includes('--dry-run')

const LINK_SPEC = `link:${ROOT.replace(/\\/g, '/')}`

function timestamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

function verifyEntryLoads() {
  const entry = pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href
  const probe = [
    `import(${JSON.stringify(entry)})`,
    '.then((m) => {',
    "  if (typeof m.apply !== 'function') { console.error('缺 apply 导出'); process.exit(3) }",
    "  if (typeof m.name !== 'string' || m.name.length === 0) { console.error('导出 name 缺失'); process.exit(2) }",
    "  console.log('entry-ok cordis-name=' + m.name)",
    '})',
    ".catch((e) => { console.error('加载失败：' + (e && e.message ? e.message : e)); process.exit(1) })",
  ].join('\n')
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' })
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() }
}

function inspectProfile(pkgFile) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  const bundles = pkg.dsh?.profile?.bundles
  return {
    pkg,
    inDeps: Object.hasOwn(pkg.dependencies ?? {}, PKG.name),
    inBundles: Array.isArray(bundles) && bundles.includes(PKG.name),
    bundlesIsArray: Array.isArray(bundles),
  }
}

console.log(`插件　：${PKG.name}@${PKG.version}　（${PKG.meta?.title ?? ''}）`)
console.log(`目录　：${ROOT}`)
console.log(`profile：${profile}　（DSH_HOME=${DSH_HOME}）`)
console.log('')

const profileDir = path.join(DSH_HOME, 'profiles', profile)
const pkgFile = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', PKG.name)

if (!fs.existsSync(pkgFile)) {
  console.error(`✗ 找不到 ${pkgFile}`)
  process.exit(1)
}

const before = inspectProfile(pkgFile)
if (!before.bundlesIsArray) {
  console.error('✗ profile 的 dsh.profile.bundles 不是数组，停手不动它。')
  process.exit(1)
}

if (dryRun) {
  console.log('（--dry-run）将要做的事：')
  console.log(`  1. 备份 ${pkgFile}`)
  console.log(`  2. dependencies["${PKG.name}"] = "${LINK_SPEC}"`)
  console.log(`  3. bundles ${uninstall ? '移除' : '加入'} "${PKG.name}"`)
  console.log(`  4. Junction：${linkPath} → ${ROOT}`)
  process.exit(0)
}

if (uninstall) {
  const backupDir = path.join(profileDir, `_backup-${PKG.name}-uninstall-${timestamp()}`)
  fs.mkdirSync(backupDir, { recursive: true })
  fs.copyFileSync(pkgFile, path.join(backupDir, 'package.json'))
  const pkg = before.pkg
  delete pkg.dependencies?.[PKG.name]
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((n) => n !== PKG.name)
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false })
  if (stat) {
    if (stat.isSymbolicLink()) fs.unlinkSync(linkPath)
    else fs.rmSync(linkPath, { recursive: true, force: true })
  }
  console.log('✓ 已卸载。重启 DSH 后生效。')
  process.exit(0)
}

console.log('① 验证插件入口能被 Node 加载…')
const probe = verifyEntryLoads()
if (!probe.ok) {
  console.error(`✗ 入口验证失败，没有动 profile：\n${probe.output}`)
  process.exit(1)
}
console.log(`  ✓ ${probe.output}`)

console.log('② 备份 + 改 profile…')
const backupDir = path.join(profileDir, `_backup-${PKG.name}-${timestamp()}`)
fs.mkdirSync(backupDir, { recursive: true })
fs.copyFileSync(pkgFile, path.join(backupDir, 'package.json'))
console.log(`  备份：${backupDir}`)

const pkg = before.pkg
pkg.dependencies = pkg.dependencies ?? {}
pkg.dependencies[PKG.name] = LINK_SPEC
if (!pkg.dsh.profile.bundles.includes(PKG.name)) pkg.dsh.profile.bundles.push(PKG.name)
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

console.log('③ Junction…')
fs.mkdirSync(path.dirname(linkPath), { recursive: true })
const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false })
if (existing) {
  if (existing.isSymbolicLink()) fs.unlinkSync(linkPath)
  else fs.rmSync(linkPath, { recursive: true, force: true })
}
fs.symlinkSync(ROOT, linkPath, 'junction')
console.log(`  ${linkPath} → ${ROOT}`)

console.log('④ 复核…')
const after = inspectProfile(pkgFile)
if (!(after.inDeps && after.inBundles && fs.existsSync(linkPath))) {
  console.error('✗ 复核没过，回滚 package.json…')
  fs.copyFileSync(path.join(backupDir, 'package.json'), pkgFile)
  const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false })
  if (stat) fs.rmSync(linkPath, { recursive: true, force: true })
  process.exit(1)
}

console.log('')
console.log('✓ 安装完成（幂等）。')
console.log('★ 彻底退出 DSH 再打开，接口与「桥」面板才会出现。')
