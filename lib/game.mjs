// lib/game.mjs — talking to the 工位股市 server as the signed-in player.
//
// The game has no tokens for its mods' routes: a page proves itself with the
// session cookie it got at sign-in, sends Origin on writes, and says which
// build of the game (X-App-Version) and of the mod (X-Mod-Version) it is. The
// plugin does the same from the DSH host process, so nothing changes on the
// server: sign in once from 设置 → 一起听, keep the cookie (not the password),
// and pass the card's requests on to /api/mods/listen/* and the songs'
// audio from /api/mod-media/listen/*.

import { Readable } from 'node:stream'

import { clearAccount, normalizeServer, readAccount, writeAccount } from './store.mjs'

export const MOD = 'listen'
const CALL_TIMEOUT_MS = 15_000
const MAX_ANSWER_BYTES = 2 * 1024 * 1024

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const NOT_SIGNED_IN = '还没登录游戏账号：到 设置 → 一起听 登录'
const EXPIRED = '游戏登录已过期：到 设置 → 一起听 重新登录'

/** The game's build and the mod's version, per server, refreshed when the game says "outdated". */
const versions = new Map()

export function forgetVersions() {
  versions.clear()
}

async function answerOf(response) {
  const text = await response.text()
  if (text.length > MAX_ANSWER_BYTES) throw new GameError('游戏服务器的回答太大了', 502)
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

function unreachable(error, server) {
  const reason = error?.name === 'TimeoutError' ? '超时' : error?.cause?.code || error?.message || String(error)
  return new GameError(`连不上游戏服务器 ${server}（${reason}）`, 502)
}

async function versionsOf(account, { fresh = false } = {}) {
  const known = versions.get(account.server)
  if (known && !fresh) return known
  let app = null
  let mod = null
  try {
    const answer = await answerOf(await fetch(`${account.server}/api/version`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }))
    app = typeof answer?.version === 'string' ? answer.version : null
    const session = await fetch(`${account.server}/api/auth/session`, {
      headers: { cookie: account.cookie },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    const who = await answerOf(session)
    if (who && who.authenticated === false) {
      await clearAccount()
      throw new GameError(EXPIRED, 401)
    }
    const listen = Array.isArray(who?.user?.mods) ? who.user.mods.find((m) => m?.id === MOD) : null
    if (who?.user && !listen) throw new GameError('这台游戏服务器没有开「一起听」', 404)
    mod = typeof listen?.version === 'string' ? listen.version : null
  } catch (error) {
    if (error instanceof GameError) throw error
    throw unreachable(error, account.server)
  }
  const found = { app, mod }
  versions.set(account.server, found)
  return found
}

async function signedIn() {
  const account = await readAccount()
  if (!account) throw new GameError(NOT_SIGNED_IN, 401)
  return account
}

/**
 * One call to the 一起听 mod as the signed-in player.
 * @param {string} method GET / POST / PUT / DELETE
 * @param {string} path   under /api/mods/listen, with its query string
 * @param {object} [body]
 * @returns {Promise<{ status: number, payload: any }>} the game's own status and JSON
 */
export async function callMod(method, path, body) {
  const account = await signedIn()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { app, mod } = await versionsOf(account, { fresh: attempt > 0 })
    const headers = { cookie: account.cookie, origin: account.server }
    if (app) headers['x-app-version'] = app
    if (mod) headers['x-mod-version'] = mod
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await fetch(`${account.server}/api/mods/${MOD}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })
    } catch (error) {
      throw unreachable(error, account.server)
    }
    const payload = await answerOf(response)
    // The game or the mod was updated since the versions were read: once more with the new ones.
    if (response.status === 409 && payload?.error === 'outdated' && attempt === 0) continue
    if (response.status === 401) {
      await clearAccount()
      throw new GameError(EXPIRED, 401)
    }
    return { status: response.status, payload }
  }
  throw new GameError('游戏刚更新过，再试一次', 409)
}

/** Sign in with the game's account and password; keeps only the session cookie. */
export async function signIn({ server, username, password }) {
  const origin = normalizeServer(server)
  if (!origin) throw new GameError('游戏服务器地址要写成 http://地址:端口')
  if (typeof username !== 'string' || !username.trim() || username.length > 64) throw new GameError('填一下游戏账号')
  if (typeof password !== 'string' || !password || password.length > 256) throw new GameError('填一下密码')
  let response
  try {
    response = await fetch(`${origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ username: username.trim(), password }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
  } catch (error) {
    throw unreachable(error, origin)
  }
  const payload = await answerOf(response)
  if (!response.ok) throw new GameError(payload?.error || `登录失败（HTTP ${response.status}）`, response.status === 429 ? 429 : 401)
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((line) => line.split(';')[0].trim())
    .find((pair) => /^[^=]+=.+$/.test(pair))
  if (!cookie) throw new GameError('游戏服务器没有给出登录凭据', 502)
  const user = payload?.user ?? {}
  await writeAccount({ server: origin, cookie, username: String(user.username ?? username.trim()), nickname: String(user.nickname ?? '') })
  versions.delete(origin)
  return { server: origin, username: String(user.username ?? username.trim()), nickname: String(user.nickname ?? '') }
}

/** Sign out on the game too (best effort), then forget the cookie. */
export async function signOut() {
  const account = await readAccount()
  if (account) {
    await fetch(`${account.server}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: account.cookie, origin: account.server, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch(() => {})
  }
  await clearAccount()
}

export const SONG_ID = /^([1-9][0-9]{0,15}|qq-[0-9A-Za-z]{8,32})$/

const PASSED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

/**
 * Stream a song (or its cover) the room is playing, with the browser's Range
 * passed through so the <audio> can seek.
 */
export async function streamMedia(req, res, id, cover) {
  if (!SONG_ID.test(id)) throw new GameError('没有这首歌', 404)
  const account = await signedIn()
  const abort = new AbortController()
  res.on?.('close', () => abort.abort())
  const headers = { cookie: account.cookie }
  const range = req.headers?.range
  if (typeof range === 'string' && /^bytes=\d*-\d*$/.test(range)) headers.range = range
  let response
  try {
    response = await fetch(`${account.server}/api/mod-media/${MOD}/${id}${cover ? '/cover' : ''}`, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      signal: abort.signal,
    })
  } catch (error) {
    if (abort.signal.aborted) return
    throw unreachable(error, account.server)
  }
  if (response.status === 401) {
    await clearAccount()
    throw new GameError(EXPIRED, 401)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new GameError(response.status === 404 ? '这首歌还没准备好，或者已经从缓存里清掉了' : `取歌失败（HTTP ${response.status}）`, response.status === 404 ? 404 : 502)
  }
  const out = { 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' }
  for (const name of PASSED_HEADERS) {
    const value = response.headers.get(name)
    if (value) out[name] = value
  }
  res.writeHead(response.status, out)
  if (req.method === 'HEAD' || !response.body) {
    res.end()
    return
  }
  const stream = Readable.fromWeb(response.body)
  stream.on('error', () => res.destroy?.())
  stream.pipe(res)
}
