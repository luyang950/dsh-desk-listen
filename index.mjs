// dsh-desk-listen — host half (cordis plugin).
//
// 工位股市「一起听」inside DeepSeek Harness. Three seams:
//
//   * the `/listen` human command. It resolves (and joins) a room as the
//     signed-in player and settles with a tiny JSON summary. `command/run` +
//     `command/done` are log-only session events: they never become model
//     messages, so listening costs zero tokens. The browser half folds that
//     pair into one custom chat node — the listening card.
//
//   * a JSON API under /dsh-desk-listen/api/*: the plugin's own config, signing
//     in to the game (only the session cookie is kept), and `game/*`, passed on
//     to the game's /api/mods/listen/* as that player (lib/game.mjs).
//
//   * /dsh-desk-listen/media/<song>: the song the room is playing, streamed
//     from the game with Range passed through.
//
// Writes need the `x-dsh-desk-listen` header: a page on another site cannot
// add it without a CORS preflight, which nothing here answers, so it cannot
// make the player say things in a room.
//
// `webServer` is NOT in `inject`: it is published late and is absent in headless
// profiles, so it is attached with ctx.inject() and the plugin settles without it.

import { GameError, SONG_ID, callMod, signIn, signOut, streamMedia } from './lib/game.mjs'
import { nameSession, onPreStep, sealBlankSession } from './lib/session.mjs'
import {
  forgetSession,
  isSessionId,
  lastServer,
  readAccount,
  readConfig,
  readSessions,
  recordSession,
  writeConfig,
} from './lib/store.mjs'

export const name = 'dsh-desk-listen'
export const inject = ['commands']

export const PREFIX = '/dsh-desk-listen'
export const API_PREFIX = `${PREFIX}/api`
export const MEDIA_PREFIX = `${PREFIX}/media`
export const WRITE_HEADER = 'x-dsh-desk-listen'
const COMMAND = 'listen'
// A Session opened with /listen is named like an ordinary one, not after the music.
const DEFAULT_TITLE = '随手记'
const MAX_BODY_BYTES = 64 * 1024

/* ── helpers ─────────────────────────────────────────────────────────────── */

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const type = String(req.headers?.['content-type'] ?? '')
  if (!type.includes('application/json')) throw new GameError('请求体必须是 application/json', 415)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new GameError('请求体过大', 413)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new GameError('请求体不是合法的 JSON 对象')
  }
}

/** A write must come from this DSH page: our header, and no foreign Origin. */
function checkWrite(req) {
  if (req.headers?.[WRITE_HEADER] !== '1') throw new GameError('缺少请求头', 403)
  const origin = req.headers?.origin
  if (origin && origin !== 'null') {
    let host = ''
    try {
      host = new URL(origin).host
    } catch {
      host = ''
    }
    if (host !== req.headers?.host) throw new GameError('不接受其他网站的请求', 403)
  }
}

const errorText = (payload, status) => (payload && typeof payload.error === 'string' ? payload.error : `游戏服务器返回 HTTP ${status}`)

/** A mod call that must succeed; its error becomes ours. */
async function mustCall(method, path, body) {
  const { status, payload } = await callMod(method, path, body)
  if (status < 200 || status >= 300) throw new GameError(errorText(payload, status), status >= 500 ? 502 : status)
  return payload
}

/* ── /listen ─────────────────────────────────────────────────────────────── */

/**
 * Turn the `/listen` argument into a room, joining it.
 *   empty  → the room the player is in now (not joined again), or none
 *   digits → that room
 *   text   → the one room whose name contains it
 * @returns {{ room: number|null, name: string, joined: boolean }}
 */
export async function resolveListenArgument(argument) {
  const query = String(argument ?? '').trim()
  if (query.length > 60) throw new GameError('参数过长')
  if (!query) {
    const me = await mustCall('GET', '/me')
    if (!me?.room) return { room: null, name: '', joined: false }
    const view = await mustCall('GET', `/room/${me.room}`)
    return { room: view.id, name: String(view.name ?? ''), joined: false }
  }
  let id = /^#?\d{1,9}$/.test(query) ? Number(query.replace('#', '')) : null
  if (id === null) {
    const listing = await mustCall('GET', '/rooms')
    const rooms = Array.isArray(listing?.rooms) ? listing.rooms : []
    const lower = query.toLowerCase()
    const hits = rooms.filter((room) => String(room.name ?? '').toLowerCase().includes(lower))
    const exact = hits.find((room) => room.name === query)
    if (exact || hits.length === 1) id = (exact ?? hits[0]).id
    else if (hits.length === 0) {
      const names = rooms.slice(0, 8).map((room) => `  ${room.id}  ${room.name}（${room.listeners} 人）`).join('\n')
      throw new GameError(rooms.length ? `没有名字包含「${query}」的房间。现在开着的：\n${names}` : '现在没有开着的房间：/listen 不带参数打开后可以自己开一个', 404)
    } else {
      const names = hits.slice(0, 8).map((room) => `  ${room.id}  ${room.name}`).join('\n')
      throw new GameError(`有 ${hits.length} 个房间名字包含「${query}」，写房间号吧：\n${names}`, 409)
    }
  }
  const view = await mustCall('POST', `/room/${id}/join`, {})
  return { room: view.id, name: String(view.name ?? ''), joined: true }
}

/** The id of the Session a command runs in, when the invocation carries one. */
export function sessionIdOf(invocation) {
  const agent = invocation?.agent
  const id = agent?.session?.id ?? agent?.id
  return isSessionId(id) ? id : null
}

/**
 * @param {{ afterListen?: (invocation: object, summary: object) => void }} [hooks]
 *   `afterListen` runs once the command has settled (after `command/done` is logged).
 */
export function listenCommand(hooks = {}) {
  return {
    name: COMMAND,
    description: '一起听：在会话里听工位股市房间的歌、点歌、聊天，不进模型上下文',
    input: { hint: '<房间号或房间名，留空则回到正在听的房间>' },
    recordInput: true,
    async handler(invocation) {
      const argument = String(invocation?.rawInput ?? '').replace(/^\/listen\b/, '').trim()
      try {
        const account = await readAccount()
        let found = { room: null, name: '', joined: false }
        if (account) found = await resolveListenArgument(argument)
        else if (argument) throw new GameError('还没登录游戏账号：先 /listen 打开卡片登录，或者到 设置 → 一起听')
        const summary = { room: found.room, name: found.name, joined: found.joined, at: Date.now() }
        const sessionId = sessionIdOf(invocation)
        if (sessionId) await recordSession({ sessionId, room: found.room, name: found.name }).catch(() => {})
        if (typeof hooks.afterListen === 'function') setImmediate(() => hooks.afterListen(invocation, summary))
        return { kind: 'success', text: JSON.stringify(summary) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/* ── routes ──────────────────────────────────────────────────────────────── */

async function status() {
  const account = await readAccount()
  return {
    config: await readConfig(),
    account: account ? { server: account.server, username: account.username, nickname: account.nickname } : null,
    server: account?.server ?? (await lastServer()),
  }
}

const routes = {
  async status() {
    return status()
  },

  async config(req) {
    if (req.method === 'POST') return { config: await writeConfig(await readBody(req)) }
    return { config: await readConfig() }
  },

  async login(req) {
    const body = await readBody(req)
    await signIn({ server: body.server, username: body.username, password: body.password })
    return status()
  },

  async logout() {
    await signOut()
    return status()
  },

  async sessions(req) {
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (!isSessionId(body.forget)) throw new GameError('参数 forget 非法')
      await forgetSession(body.forget)
    }
    return { sessions: await readSessions() }
  },
}

const POST_ROUTES = new Set(['config', 'login', 'logout', 'sessions'])
const GET_ROUTES = new Set(['status', 'config', 'sessions'])
const GAME_PATH = /^\/[A-Za-z0-9_/-]{0,200}$/
const GAME_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])

/**
 * Everything under /dsh-desk-listen/: dispatch, method checks, uniform error envelope.
 * Exported so the test suite can drive it without a web server.
 */
export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'

    if (url.pathname.startsWith(`${MEDIA_PREFIX}/`)) {
      if (method !== 'GET' && method !== 'HEAD') throw new GameError('不支持的请求方法', 405)
      const match = /^([^/]+)(\/cover)?$/.exec(url.pathname.slice(MEDIA_PREFIX.length + 1))
      if (!match || !SONG_ID.test(match[1])) throw new GameError('没有这首歌', 404)
      await streamMedia(req, res, match[1], Boolean(match[2]))
      return
    }

    if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw new GameError('未知接口', 404)
    const route = url.pathname.slice(API_PREFIX.length + 1)

    if (route.startsWith('game/')) {
      const path = route.slice('game'.length)
      if (!GAME_PATH.test(path) || path.includes('//')) throw new GameError('未知接口', 404)
      if (!GAME_METHODS.has(method)) throw new GameError('不支持的请求方法', 405)
      let body
      if (method !== 'GET') {
        checkWrite(req)
        body = method === 'POST' || method === 'PUT' ? await readBody(req) : undefined
      }
      const search = url.search.length > 600 ? '' : url.search
      const { status: code, payload } = await callMod(method, path + search, body)
      if (code >= 200 && code < 300) sendJson(res, 200, { ok: true, data: payload })
      else sendJson(res, code >= 500 ? 502 : code, { ok: false, error: errorText(payload, code) })
      return
    }

    if (!Object.hasOwn(routes, route)) throw new GameError('未知接口', 404)
    const allowed = (method === 'GET' && GET_ROUTES.has(route)) || (method === 'POST' && POST_ROUTES.has(route))
    if (!allowed) {
      res.setHeader?.('allow', [GET_ROUTES.has(route) && 'GET', POST_ROUTES.has(route) && 'POST'].filter(Boolean).join(', '))
      throw new GameError('不支持的请求方法', 405)
    }
    if (method === 'POST') checkWrite(req)
    const payload = await routes[route](req, url.searchParams)
    sendJson(res, 200, { ok: true, ...payload })
  } catch (error) {
    if (res.headersSent || res.writableEnded) {
      res.destroy?.()
      return
    }
    const code = Number.isInteger(error?.status) ? error.status : 500
    const message = code === 500 ? `内部错误：${error?.message ?? error}` : error.message
    sendJson(res, code, { ok: false, error: message })
  }
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  let titles = null
  ctx.inject(['sessionTitle'], (titleCtx) => {
    titles = titleCtx.sessionTitle
    titleCtx.effect(() => () => {
      titles = null
    }, 'dsh-desk-listen: session titles')
  })

  // Rejects only the empty turn started below; see lib/session.mjs.
  ctx.on('agent/pre-step', onPreStep, true)

  const afterListen = async (invocation, summary) => {
    const agent = invocation?.agent
    try {
      const config = await readConfig()
      if (!config.keepSession) return
      if (!sealBlankSession(agent)) return
      nameSession(titles, agent.session, config.sessionTitle || DEFAULT_TITLE)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-desk-listen: keeping the session failed: ${error?.message ?? error}`)
    }
  }

  ctx.commands.register(listenCommand({ afterListen }))

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handleRequest }),
      'dsh-desk-listen: routes',
    )
  })
}
