/**
 * dsh-maid-bridge —— 车万女仆 mod 的 OpenAI 兼容本地桥。
 *
 * 目标：游戏里的女仆把一句话发到本机接口 → 我们把它转给指定 DSH 会话 →
 * 等那个会话里的回复 → 按 OpenAI chat.completion 形状还回去。
 *
 * 端点（只绑 127.0.0.1，走宿主 webServer）：
 *   GET  /v1/models                  会话列表（= 可选的「模型」）
 *   POST /v1/chat/completions        投递一句话并等待回复
 *   GET  /api/maid-bridge/state.json 面板状态
 *   POST /api/maid-bridge/save       面板保存（密钥 / 白名单）
 *
 * 安全：只监听本机；Authorization: Bearer <secretKey> 必须匹配（未配置密钥 =
 * 全部拒绝）；会话白名单；每会话 3 秒限流；单并发；120 秒超时；只取最后一条
 * user 消息。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import os from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { listSessions, findSession, DEFAULT_SESSIONS_DIR } from './sessions.js'

export const name = 'dsh-maid-bridge'
export const inject = ['agents']

const DSH_HOME = process.env.DSH_HOME || join(os.homedir(), '.dsh')

const DEFAULTS = {
  port: 8788,
  secretKey: '',
  sessionWhitelist: [],
  allowArchived: false,
  allowBlank: false,
  prefix: '【车万女仆】',
  timeoutMs: 120000,
  rateLimitMs: 3000,
  maxReplyChars: 4000,
  sessionsDir: DEFAULT_SESSIONS_DIR,
  sessionsRoot: join(DSH_HOME, 'sessions'),
  provider: '',
  model: '',
  logFile: join(DSH_HOME, 'media', 'maid-bridge.log'),
  stateFile: '',
}

const ALLOWED_PATHS = [
  '/v1',
  '/v1/models',
  '/maid-bridge/v1/models',
  '/v1/chat/completions',
  '/maid-bridge/v1/chat/completions',
  '/api/maid-bridge/state.json',
  '/api/maid-bridge/save',
]

/* ------------------------------------------------------------------ 小工具 ---- */

function makeLog(cfg) {
  const file = cfg.logFile
  return (level, message) => {
    const line = new Date().toISOString() + ' [' + level + '] ' + message
    try {
      appendFileSync(file, line + '\n')
    } catch {
      /* 日志写失败不影响主流程 */
    }
    if (level === 'error') console.error('[maid-bridge] ' + message)
    else if (level === 'warn') console.warn('[maid-bridge] ' + message)
    else console.log('[maid-bridge] ' + message)
  }
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function jsonBody(req) {
  const raw = await readBody(req)
  if (raw === '') return {}
  return JSON.parse(raw)
}

function modelItem(session) {
  return {
    id: session.id,
    object: 'model',
    created: Math.floor((session.createdAt || Date.now()) / 1000),
    owned_by: 'dsh',
  }
}

function completionBody(model, reply, toolCalls = null, created = Math.floor(Date.now() / 1000)) {
  const message = { role: 'assistant', content: reply }
  let finishReason = 'stop'
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    message.tool_calls = toolCalls
    finishReason = 'tool_calls'
  }
  return {
    id: 'chatcmpl-maid-' + Math.random().toString(36).slice(2, 10),
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/* ------------------------------------------------------------------ 状态 ---- */

function loadState(cfg, log) {
  const file = cfg.stateFile
  if (!file || !existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    log('warn', '状态文件损坏，忽略：' + String(error?.message ?? error))
    return {}
  }
}

function saveState(cfg, state, log) {
  try {
    writeFileSync(cfg.stateFile, JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch (error) {
    log('warn', '状态文件写入失败：' + String(error?.message ?? error))
    return false
  }
}

/* ------------------------------------------------------------------ 消息构造 ---- */

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const part of content) {
      if (typeof part === 'string') parts.push(part)
      else if (part && typeof part.text === 'string') parts.push(part.text)
    }
    return parts.join('')
  }
  return ''
}

/* ------------------------------------------------------------------ 工具调用 ---- */

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g

/**
 * 从 DSH 会话的回复里拆出 <tool_call>{...}</tool_call> 块。
 * 返回 { text: 剥掉标记后的正文, calls: OpenAI tool_call 结构数组 }。
 * JSON 解析失败的标记原样保留在正文里（当普通文本）。
 */
function parseToolCalls(reply) {
  const calls = []
  const text = String(reply ?? '').replace(TOOL_CALL_RE, (match, json) => {
    try {
      const parsed = JSON.parse(String(json).trim())
      const name = parsed?.name
      if (typeof name !== 'string' || name === '') return match
      const args = parsed?.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {}
      calls.push({
        id: 'call_' + Math.random().toString(36).slice(2, 12),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      })
      return ''
    } catch {
      return match
    }
  })
  // 兜底：整条回复就是一个 {"name":...,"arguments":{...}} 对象
  if (calls.length === 0) {
    const trimmed = text.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed)
        const name = parsed?.name
        if (typeof name === 'string' && name !== '' && parsed?.arguments && typeof parsed.arguments === 'object') {
          calls.push({
            id: 'call_' + Math.random().toString(36).slice(2, 12),
            type: 'function',
            function: { name, arguments: JSON.stringify(parsed.arguments) },
          })
          return { text: '', calls }
        }
      } catch {
        /* 不是工具调用 JSON，保留原文 */
      }
    }
  }
  return { text: text.trim(), calls }
}

/**
 * 构造投递给 DSH 会话的文本：玩家原话 + 上一轮工具执行结果（如果有）+ 本轮可用工具说明。
 * tools 是 OpenAI 形状 [{ type:'function', function:{ name, description, parameters } }]。
 */
function buildDispatchText(cfg, messages, lastUserIdx, tools) {
  const rawText = extractText(messages[lastUserIdx]?.content)
  const parts = [cfg.prefix + rawText]

  const toolResults = []
  for (let i = lastUserIdx + 1; i < messages.length; i += 1) {
    const m = messages[i]
    if (m && m.role === 'tool') {
      toolResults.push({ id: m.tool_call_id, content: extractText(m.content) })
    }
  }
  if (toolResults.length > 0) {
    parts.push('')
    parts.push('[桥·工具执行结果]')
    for (const r of toolResults) {
      parts.push('- tool_call_id=' + (r.id || '?') + ' → ' + r.content)
    }
    parts.push('（以上是你上一轮动作的执行结果，继续回应玩家。）')
  }

  if (Array.isArray(tools) && tools.length > 0) {
    parts.push('')
    parts.push('[桥·本轮可执行工具]')
    let shown = 0
    for (const t of tools) {
      const fn = t?.function ?? t
      if (!fn || typeof fn.name !== 'string' || fn.name === '') continue
      if (shown >= 30) break
      shown += 1
      parts.push('- ' + fn.name + ' — ' + String(fn.description ?? '').replace(/\s+/g, ' ').slice(0, 500))
      if (fn.parameters && typeof fn.parameters === 'object') {
        parts.push('  参数: ' + JSON.stringify(fn.parameters).slice(0, 1200))
      }
    }
    if (shown > 0) {
      parts.push('调用格式：确实需要执行动作时，只输出下面这样的行（可以多行），不要附加解释：')
      parts.push('<tool_call>{"name":"工具名","arguments":{...}}</tool_call>')
      parts.push('不需要动作时正常聊天，不要输出这个标记。')
    }
  }

  return parts.join('\n')
}

/** 优先用宿主的 createUserMessage；拿不到时退化成等价字面量。 */
async function makeUserMessage(text) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (typeof mod.createUserMessage === 'function') {
      return mod.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:dsh-maid-bridge' },
      })
    }
  } catch {
    /* 退化 */
  }
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-maid-bridge' },
  }
}

/**
 * 从会话原始事件流里找最后一条 request/header 的 config.provider/model。
 * 会话文件在 <sessionsRoot>/<workspace目录>/session-<id>/session.v*.jsonl.zstd。
 * 纯本地只读，读不到就返回 undefined。
 */
function readLastRequestConfig(sessionId, sessionsRoot, log) {
  try {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    if (typeof sessionsRoot !== 'string' || sessionsRoot === '' || !existsSync(sessionsRoot)) {
      log?.('warn', '历史配置：sessionsRoot 不可用 ' + String(sessionsRoot))
      return undefined
    }
    for (const dirName of readdirSync(sessionsRoot)) {
      const sessionDir = join(sessionsRoot, dirName, sessionId)
      if (!existsSync(sessionDir)) continue
      const files = readdirSync(sessionDir)
        .filter((f) => f.startsWith('session.') && f.endsWith('.jsonl.zstd'))
        .sort()
        .reverse()
      for (const file of files) {
        let text
        try {
          text = zstdDecompressSync(readFileSync(join(sessionDir, file))).toString('utf8')
        } catch (error) {
          log?.('warn', '历史配置：解压失败 ' + file + '：' + String(error?.message ?? error))
          continue
        }
        const lines = text.split('\n')
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i]
          if (line.indexOf('request/header') === -1) continue
          try {
            const event = JSON.parse(line)
            const config = event?.data?.header?.config
            if (config && typeof config.provider === 'string' && config.provider !== '' && typeof config.model === 'string' && config.model !== '') {
              const options = { provider: config.provider, model: config.model }
              if (typeof config.reasoningEffort === 'string' && config.reasoningEffort !== '') options.reasoningEffort = config.reasoningEffort
              return options
            }
          } catch {
            /* 单行坏了不影响其他行 */
          }
        }
      }
    }
  } catch (error) {
    log?.('warn', '历史配置：读取异常 ' + String(error?.message ?? error))
  }
  log?.('warn', '历史配置：没有找到 request/header（会话 ' + sessionId + '）')
  return undefined
}

/** 决定 resume 时传给宿主的 agentOptions：配置优先，其次历史请求头。 */
function resolveAgentOptions(cfg, sessionId, log) {
  if (typeof cfg.provider === 'string' && cfg.provider !== '' && typeof cfg.model === 'string' && cfg.model !== '') {
    log?.('info', 'agentOptions 来自面板配置 ' + cfg.provider + '/' + cfg.model)
    return { provider: cfg.provider, model: cfg.model }
  }
  const fromHistory = readLastRequestConfig(sessionId, cfg.sessionsRoot, log)
  log?.('info', 'agentOptions 来自历史：' + (fromHistory ? fromHistory.provider + '/' + fromHistory.model : '无'))
  return fromHistory
}

/* ------------------------------------------------------------------ 投递器 ---- */

/**
 * resume 会话 → 投一条 user 消息 → 等 session 事件里的 assistant/message，
 * turn/end 收尾。pending 以会话 id（以及 agent.session.id）为键。
 */
function makeDispatcher(root, cfg, log, pending) {
  // 常驻持有：桥启动时就把白名单里的会话 resume 出来、之后一直拿着同一个 agent，
  // 不再逐轮 resume/dispose。这样 GUI 后打开同一会话时宿主会把已有 agent 挂给 GU-
  // （共用一个写句柄，两边都能说话）；逐轮借用才会和 GUI 抢写句柄报 500。
  let held = null
  let holdingPromise = null

  // 桥 resume 出来的 agent 没有 GUI 客户端的模型选择（宿主只在 GUI/API 入口装
  // installModelSelection），prompt 组装时 {{model}} 没有值、请求也不带 provider/model。
  // 用 resume 的 setup 钩子（官方 headless 的安装路径）补上两个装配监听；
  // setup 没被调用时再兜底挂到 agent.ctx 上，两处都打日志方便排查。
  const installSelection = (agentCtx, where, agentOptions) => {
    if (!agentOptions || typeof agentCtx?.on !== 'function') return
    const { provider, model, reasoningEffort } = agentOptions
    try {
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next()
        log('info', '[' + where + '] assemble 监听触发')
        return { ...assembled, variables: { ...assembled.variables, provider, model } }
      })
      agentCtx.on('agent/request', async (_payload, next) => {
        const resolved = await next()
        log('info', '[' + where + '] agent/request 监听触发')
        const { reasoningEffort: _inherited, ...rest } = resolved
        return {
          ...rest,
          provider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }
      })
    } catch (error) {
      log('warn', '[' + where + '] 补模型选择失败：' + String(error?.message ?? error))
    }
  }

  /** 拿（没有就先 resume 出）常驻 agent；同一会话只 resume 一次。 */
  const acquire = async (sessionId) => {
    if (held !== null && held.sessionId === sessionId) return held
    if (holdingPromise !== null) {
      const joining = await holdingPromise
      if (joining !== null && joining.sessionId === sessionId) return joining
    }
    holdingPromise = (async () => {
      const agentOptions = resolveAgentOptions(cfg, sessionId, log)
      let handle
      let setupCalled = false
      handle = await root.agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions ? { agentOptions } : {}),
        ...(agentOptions
          ? {
              setup: (agentCtx) => {
                setupCalled = true
                log('info', 'bridge setup 被调用')
                installSelection(agentCtx, 'setup', agentOptions)
              },
            }
          : {}),
      })
      const agent = handle?.agent
      if (!agent || typeof agent.followup !== 'function') {
        try {
          await handle?.dispose?.()
        } catch {
          /* ignore */
        }
        throw new Error('resume 后拿不到 agent')
      }
      if (agentOptions && !setupCalled) {
        log('info', 'setup 未被调用，改挂 agent.ctx')
        installSelection(agent.ctx, 'ctx', agentOptions)
      }
      held = { sessionId, handle, agent }
      log('info', '常驻持有会话 ' + sessionId)
      return held
    })()
    try {
      return await holdingPromise
    } finally {
      holdingPromise = null
    }
  }

  const release = async () => {
    const old = held
    held = null
    try {
      await old?.handle?.dispose?.()
    } catch {
      /* ignore */
    }
  }

  const dispatch = async (sessionId, text) => {
    const agentService = root.agents
    if (!agentService || typeof agentService.resume !== 'function') {
      throw new Error('宿主未提供 agents 服务')
    }

    // 同一会话已有等待中的投递：排队
    while (pending.has(sessionId)) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    const entry = {
      texts: [],
      lastId: undefined,
      done: false,
      resolve: null,
      reject: null,
      timer: null,
      finish: null,
    }
    pending.set(sessionId, entry)

    const finish = (error) => {
      if (entry.done) return
      entry.done = true
      if (entry.timer) clearTimeout(entry.timer)
      pending.delete(sessionId)
      if (entry.actualId) pending.delete(entry.actualId)
      if (error) entry.reject(error)
      else entry.resolve(entry.texts.join(''))
    }
    entry.finish = finish

    const wait = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    wait.catch(() => {})

    let target
    try {
      target = await acquire(sessionId)
    } catch (error) {
      finish(error)
      throw error
    }
    const agent = target.agent
    entry.actualId = agent.session?.id ?? sessionId
    if (entry.actualId !== sessionId) pending.set(entry.actualId, entry)

    try {
      agent.followup(await makeUserMessage(text))
    } catch (error) {
      held = null
      finish(error)
      throw error
    }

    entry.timer = setTimeout(() => finish(new Error('timeout')), cfg.timeoutMs)

    try {
      const reply = await wait
      const trimmed = reply === '' ? '……' : reply
      return trimmed.length > cfg.maxReplyChars ? trimmed.slice(0, cfg.maxReplyChars) + '……（后面太长，省略了）' : trimmed
    } finally {
      finish()
    }
  }

  return { dispatch, prime: acquire, release }
}

/** 监听 session 事件：assistant/message 收集文本，turn/end 收尾。 */
function attachSessionFeed(root, pending) {
  const off = root.on('session/event', (session, event) => {
    const sid = session?.id
    if (!sid) return
    const entry = pending.get(sid)
    if (!entry) return
    const type = event?.type
    if (type === 'assistant/message') {
      const message = event.data?.message
      if (!message) return
      const id = message.id
      if (id !== undefined && entry.lastId === id) return
      entry.lastId = id
      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('')
      if (text !== '') entry.texts.push(text)
      return
    }
    if (type === 'turn/end') {
      const reason = event.data?.reason
      if (reason && reason.kind === 'error') {
        const message = reason?.error?.message ?? 'turn 失败'
        if (typeof entry.finish === 'function') entry.finish(new Error(message))
      } else if (typeof entry.resolve === 'function') {
        entry.resolve(entry.texts.join(''))
      }
    }
  })
  return typeof off === 'function' ? off : () => {}
}

/* ------------------------------------------------------------------ 主流程 ---- */

export function apply(root, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig ?? {}) }
  if (!cfg.stateFile) {
    cfg.stateFile = 'E:\\dsh-tools\\dsh-maid-bridge\\.state.json'
  }
  const log = makeLog(cfg)
  Object.assign(cfg, loadState(cfg, log))

  const pending = new Map()
  const bridge = makeDispatcher(root, cfg, log, pending)
  const recentHits = new Map()
  let dispatching = 0
  let requestCount = 0
  const startedAt = Date.now()

  const sessionsOptions = () => ({
    sessionsDir: cfg.sessionsDir,
    includeArchived: cfg.allowArchived === true,
    includeBlank: cfg.allowBlank === true,
    whitelist: cfg.sessionWhitelist,
  })

  const publicState = () => ({
    ok: true,
    startedAt,
    requestCount,
    running: dispatching > 0,
    secretConfigured: typeof cfg.secretKey === 'string' && cfg.secretKey !== '',
    prefix: cfg.prefix,
    timeoutMs: cfg.timeoutMs,
    rateLimitMs: cfg.rateLimitMs,
    allowArchived: cfg.allowArchived === true,
    sessionWhitelist: cfg.sessionWhitelist,
    port: cfg.port,
    endpoint: 'http://127.0.0.1:' + cfg.port + '/v1',
    sessions: listSessions(sessionsOptions()).map((s) => ({
      id: s.id,
      title: s.title,
      archived: s.archived,
      createdAt: s.createdAt,
    })),
  })

  root.inject(['webServer'], (webCtx) => {
    const webServer = webCtx?.webServer
    if (!webServer || typeof webServer.register !== 'function') {
      log('warn', '宿主未提供 webServer，接口不可用')
      return
    }

    const send = (res, code, payload) => {
      try {
        res.statusCode = code
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
      } catch {
        /* 连接已断 */
      }
    }

    const checkAuth = (req) => {
      const header = String(req.headers?.authorization ?? '')
      const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
      if (cfg.secretKey === '') return { ok: false, error: '未配置密钥，接口关闭（先在面板里设置 Secret Key）' }
      if (token !== cfg.secretKey) return { ok: false, error: '密钥不匹配' }
      return { ok: true }
    }

    const resolveModel = (model) => {
      if (typeof model !== 'string' || model === '') return { error: '缺少 model 字段（应为会话 id）' }
      const session = findSession(model, { sessionsDir: cfg.sessionsDir })
      if (!session) return { error: '会话不存在：' + model }
      if (session.blank) return { error: '会话是空的，先在里面说句话再连' }
      if (!cfg.allowArchived && session.archived) return { error: '会话已归档，不在可用范围' }
      if (Array.isArray(cfg.sessionWhitelist) && cfg.sessionWhitelist.length > 0 && !cfg.sessionWhitelist.includes(session.id)) {
        return { error: '会话不在白名单里：' + session.id }
      }
      return { session }
    }

    const dispatcher = bridge.dispatch

    const handler = async (req, res) => {
      const url = String(req.url ?? '')
      const path = url.split('?')[0]
      try {
        if (path === '/v1/models' || path === '/maid-bridge/v1/models') {
          if (req.method !== 'GET') return send(res, 405, { error: { message: 'method not allowed' } })
          const auth = checkAuth(req)
          if (!auth.ok) return send(res, 401, { error: { message: auth.error } })
          return send(res, 200, { object: 'list', data: listSessions(sessionsOptions()).map(modelItem) })
        }

        if (path === '/v1/chat/completions' || path === '/maid-bridge/v1/chat/completions' || path === '/v1' || path === '/v1/') {
          if (req.method !== 'POST') return send(res, 405, { error: { message: 'method not allowed' } })
          const auth = checkAuth(req)
          if (!auth.ok) return send(res, 401, { error: { message: auth.error } })
          let body
          try {
            body = await jsonBody(req)
          } catch {
            return send(res, 400, { error: { message: 'body 不是合法 JSON' } })
          }
          const picked = resolveModel(body.model)
          if (picked.error) return send(res, 400, { error: { message: picked.error } })

          const messages = Array.isArray(body.messages) ? body.messages : []
          let lastUserIdx = -1
          for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i] && messages[i].role === 'user') {
              lastUserIdx = i
              break
            }
          }
          const rawText = lastUserIdx >= 0 ? extractText(messages[lastUserIdx].content) : ''
          if (rawText === '') return send(res, 400, { error: { message: '没有可用的 user 消息内容' } })

          const tools = Array.isArray(body.tools) ? body.tools : []
          // 模组执行完工具会立刻把结果回传（user 消息后跟着 role=tool 的消息），
          // 这种连续轮次不该被 3 秒限流挡住。
          const hasToolResults = messages.slice(lastUserIdx + 1).some((m) => m && m.role === 'tool')

          const now = Date.now()
          if (!hasToolResults) {
            const last = recentHits.get(picked.session.id) ?? 0
            if (now - last < cfg.rateLimitMs) {
              return send(res, 429, { error: { message: '同一会话请求太频繁，' + Math.ceil((cfg.rateLimitMs - (now - last)) / 1000) + ' 秒后再试' } })
            }
            recentHits.set(picked.session.id, now)
          }

          if (dispatching >= 1) {
            return send(res, 429, { error: { message: '我这边还在回上一条，稍等' } })
          }
          dispatching += 1
          requestCount += 1
          const started = Date.now()
          try {
            const text = buildDispatchText(cfg, messages, lastUserIdx, tools)
            log('info', '投递 ' + picked.session.id + ': ' + rawText.slice(0, 60) + (tools.length > 0 ? ' [tools:' + tools.length + ']' : '') + (hasToolResults ? ' [tool结果回传]' : ''))
            const reply = await dispatcher(picked.session.id, text)
            const parsed = parseToolCalls(reply)
            if (parsed.calls.length > 0) {
              log('info', '工具调用 ' + picked.session.id + ': ' + parsed.calls.map((c) => c.function.name).join(',') + ' (' + (Date.now() - started) + 'ms)')
            } else {
              log('info', '回复 ' + picked.session.id + ': ' + reply.slice(0, 60) + ' (' + (Date.now() - started) + 'ms)')
            }
            return send(res, 200, completionBody(picked.session.id, parsed.text, parsed.calls))
          } finally {
            dispatching -= 1
          }
        }

        if (path === '/api/maid-bridge/state.json') {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' })
          return send(res, 200, publicState())
        }

        if (path === '/api/maid-bridge/save') {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
          let body
          try {
            body = await jsonBody(req)
          } catch {
            return send(res, 400, { ok: false, error: 'body 不是合法 JSON' })
          }
          if (typeof body.secretKey === 'string' && body.secretKey.trim() !== '') cfg.secretKey = body.secretKey.trim()
          if (Array.isArray(body.sessionWhitelist)) {
            cfg.sessionWhitelist = body.sessionWhitelist.filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x))
          }
          if (typeof body.allowArchived === 'boolean') cfg.allowArchived = body.allowArchived
          const ok = saveState(cfg, {
            secretKey: cfg.secretKey,
            sessionWhitelist: cfg.sessionWhitelist,
            allowArchived: cfg.allowArchived,
          }, log)
          log('info', '面板保存：secret=' + (cfg.secretKey ? '设置' : '空') + ' whitelist=' + cfg.sessionWhitelist.length)
          return send(res, 200, { ok, state: publicState() })
        }

        return send(res, 404, { error: { message: 'not found' } })
      } catch (error) {
        log('error', '请求处理失败：' + String(error?.message ?? error))
        return send(res, 500, { error: { message: String(error?.message ?? error) } })
      }
    }

    for (const path of ALLOWED_PATHS) {
      try {
        webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        log('warn', '注册路由失败 ' + path + '：' + String(error?.message ?? error))
      }
    }

    // 固定端口（默认 8788）：游戏里填 http://127.0.0.1:8788/v1，不随 DSH 重启换端口
    try {
      const server = createServer((req, res) => {
        void handler(req, res)
      })
      server.on('error', (error) => {
        log('warn', '独立端口 ' + cfg.port + ' 监听失败：' + String(error?.message ?? error))
      })
      server.listen(cfg.port, '127.0.0.1', () => {
        log('info', '独立接口监听 http://127.0.0.1:' + cfg.port + '/v1')
      })
      root.effect(
        () => () => {
          try {
            server.close()
          } catch {
            /* ignore */
          }
        },
        'dsh-maid-bridge.standalone-server',
      )
    } catch (error) {
      log('warn', '独立端口启动失败：' + String(error?.message ?? error))
    }

    log('info', '接口已挂载（密钥' + (cfg.secretKey ? '已配置' : '未配置') + '，端口 ' + cfg.port + '）')
  })

  const off = attachSessionFeed(root, pending)
  root.effect(() => () => {
    try {
      off()
    } catch {
      /* ignore */
    }
  }, 'dsh-maid-bridge.feed')

  // 启动预持有：把白名单第一个会话先 resume 出来常驻，抢占写句柄。
  // 若桌面端自动恢复的 GUI 已经打开了该会话，这里会撞锁——只记警告，别拖垮插件；
  // 这种情况重启一次 DSH（重启时该会话不处于打开状态）即可。
  const primeTarget = Array.isArray(cfg.sessionWhitelist) ? cfg.sessionWhitelist[0] : undefined
  if (typeof primeTarget === 'string' && primeTarget !== '') {
    void bridge.prime(primeTarget).catch((error) => {
      log('warn', '启动预持有失败（十有八九是 GUI 先打开了该会话）：' + String(error?.message ?? error))
    })
  }

  root.effect(() => () => {
    void bridge.release()
  }, 'dsh-maid-bridge.held-agent')

  log('info', 'dsh-maid-bridge mounted')
}
