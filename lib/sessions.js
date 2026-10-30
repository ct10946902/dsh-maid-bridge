/**
 * 会话清单：从 DSH 的 session 投影缓存里读「非归档会话」列表。
 *
 * 数据源：E:\dsh-home\storages\session_projcache\sessions\*.json
 *   record.rows.title.val             —— 标题
 *   record.rows.titleInput.val.first.text —— 标题输入（标题还没生成时的兜底）
 *   record.rows.sessionListMetadata.val.blank —— 空会话
 *   record.identity.createdAt / cwd   —— 创建时间 / 工作目录
 *
 * 归档标记在 workspace.json 的 global.archivedSessionIds 里。
 * 注意：record.rows.contextTimeline.val.archived 是「上下文折叠记录」（被压缩掉的
 * 历史事件列表），不是会话归档——2026-10-29 曾误用它，导致当前会话被当成归档过滤掉。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh')

export const DEFAULT_SESSIONS_DIR = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
export const DEFAULT_WORKSPACE_FILE = join(DSH_HOME, 'storages', 'workspace.json')

/** 读 workspace.json 里的归档会话 id 列表（DSH 真正的归档标记）。 */
export function readArchivedSessionIds(file = DEFAULT_WORKSPACE_FILE) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const ids = raw?.global?.archivedSessionIds
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
  } catch {
    return []
  }
}

function pickTitle(record) {
  const rows = record?.rows ?? {}
  const direct = rows.title?.val
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  const first = rows.titleInput?.val?.first?.text
  if (typeof first === 'string' && first.trim() !== '') return first.trim()
  return ''
}

export function readSessionFile(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const record = raw?.record ?? {}
    const rows = record.rows ?? {}
    const id = file.split(/[\\/]/).pop().replace(/\.json$/, '')
    return {
      id,
      title: pickTitle(record),
      blank: rows.sessionListMetadata?.val?.blank === true,
      // 归档标记不在这里：见 readArchivedSessionIds()（workspace.json 的 global.archivedSessionIds）
      archived: false,
      createdAt: record.identity?.createdAt ?? 0,
      cwd: record.identity?.cwd ?? '',
    }
  } catch {
    return null
  }
}

/**
 * 列出会话。options:
 *   includeArchived  是否包含已归档（默认 false）
 *   includeBlank     是否包含空会话（默认 false）
 *   whitelist        非空时只保留这些 id
 *   archivedIds      归档 id 集合（不传则现读 workspace.json）
 *   workspaceFile    workspace.json 路径（默认 E:\dsh-home\storages\workspace.json）
 */
export function listSessions(options = {}) {
  const dir = options.sessionsDir || DEFAULT_SESSIONS_DIR
  if (!existsSync(dir)) return []
  const includeArchived = options.includeArchived === true
  const includeBlank = options.includeBlank === true
  const whitelist = Array.isArray(options.whitelist) && options.whitelist.length > 0 ? new Set(options.whitelist) : null
  const archivedIds =
    options.archivedIds instanceof Set ? options.archivedIds : new Set(readArchivedSessionIds(options.workspaceFile))
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const session = readSessionFile(join(dir, name))
    if (session === null) continue
    session.archived = archivedIds.has(session.id)
    if (!includeArchived && session.archived) continue
    if (!includeBlank && session.blank) continue
    if (whitelist !== null && !whitelist.has(session.id)) continue
    out.push(session)
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

/** 校验一个会话 id 是否存在且可用（用于请求里的 model 字段）。 */
export function findSession(sessionId, options = {}) {
  const dir = options.sessionsDir || DEFAULT_SESSIONS_DIR
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null
  const file = join(dir, sessionId + '.json')
  if (!existsSync(file)) return null
  const session = readSessionFile(file)
  if (session === null) return null
  const archivedIds =
    options.archivedIds instanceof Set ? options.archivedIds : new Set(readArchivedSessionIds(options.workspaceFile))
  session.archived = archivedIds.has(session.id)
  return session
}
