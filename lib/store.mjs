// lib/store.mjs — the plugin's only writable state, under $DSH_HOME/dsh-desk-listen/.
//
//   config.json    game server address + boss key + session preferences
//   account.json   the game's session cookie (never the password), mode 0600
//   sessions.json  DSH Sessions that hold a 一起听 card, newest first
//
// Writes are atomic (temp file + rename) and serialised per file.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_DIR = 'dsh-desk-listen'
export const SESSIONS_LIMIT = 20

/** Resolved at call time so tests (and a moved DSH_HOME) see the current value. */
export function dataDirectory() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_DIR)
}

/* ── config schema ───────────────────────────────────────────────────────── */

const KEY_CODE = /^(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]|Backquote|Period|Comma|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/

export const DEFAULT_CONFIG = Object.freeze({
  bossKey: 'Ctrl+Alt+KeyM',
  bossMute: false, // the boss key also silences the music
  keepSession: true, // run one empty turn so a card opened in New Session stays in the sidebar
  sessionTitle: '', // title for that Session; empty = 随手记
})

/**
 * Normalise a boss-key chord like `ctrl+alt+KeyM` → `Ctrl+Alt+KeyM`.
 * At least one modifier is required unless the key is a function key, so the
 * chord can never swallow ordinary typing in the composer.
 * @returns {string|null}
 */
export function normalizeChord(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 5) return null
  const code = parts.pop()
  if (!KEY_CODE.test(code)) return null
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta']
  const seen = new Set()
  for (const part of parts) {
    const canonical = order.find((name) => name.toLowerCase() === part.toLowerCase())
    if (!canonical || seen.has(canonical)) return null
    seen.add(canonical)
  }
  if (seen.size === 0 && !/^F\d+$/.test(code)) return null
  if (seen.size === 1 && seen.has('Shift') && !/^F\d+$/.test(code)) return null
  return [...order.filter((name) => seen.has(name)), code].join('+')
}

/**
 * The game server's origin: `http(s)://host[:port]`, nothing after it.
 * @returns {string|null}
 */
export function normalizeServer(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 300) return null
  let url
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password || url.search || url.hash) return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  return url.origin
}

/**
 * Validate a partial config patch.
 * @returns {{ value: object, errors: string[] }} only the valid fields are kept
 */
export function validateConfigPatch(patch) {
  const value = {}
  const errors = []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { value, errors: ['配置必须是对象'] }
  for (const [key, raw] of Object.entries(patch)) {
    switch (key) {
      case 'bossKey': {
        const chord = normalizeChord(raw)
        if (!chord) errors.push('老板键必须是「修饰键 + 按键」，例如 Ctrl+Alt+KeyM')
        else value.bossKey = chord
        break
      }
      case 'bossMute':
      case 'keepSession': {
        if (typeof raw !== 'boolean') errors.push(`${key} 必须是 true 或 false`)
        else value[key] = raw
        break
      }
      case 'sessionTitle': {
        const text = typeof raw === 'string' ? raw.trim() : null
        if (text === null || text.length > 40 || /[\u0000-\u001f]/.test(text)) errors.push('会话标题最多 40 个字，且不能含控制字符')
        else value.sessionTitle = text
        break
      }
      default:
        errors.push(`未知配置项：${key}`)
    }
  }
  return { value, errors }
}

/* ── json files ──────────────────────────────────────────────────────────── */

const queues = new Map()

async function readJson(name, fallback) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDirectory(), name), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Read-modify-write one file under a per-file queue; `mutate` returns the result. */
function update(name, fallback, mutate, { secret = false } = {}) {
  const previous = queues.get(name) ?? Promise.resolve()
  const next = previous.then(async () => {
    const current = await readJson(name, fallback())
    const result = await mutate(current)
    const directory = dataDirectory()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, name)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: secret ? 0o600 : 0o644 })
    if (secret) await chmod(temporary, 0o600).catch(() => {})
    await rename(temporary, target)
    return result
  })
  queues.set(name, next.catch(() => {}))
  return next
}

/* ── config ──────────────────────────────────────────────────────────────── */

export async function readConfig() {
  const stored = await readJson('config.json', {})
  const { value } = validateConfigPatch(Object.fromEntries(Object.entries(stored).filter(([key]) => key in DEFAULT_CONFIG)))
  return { ...DEFAULT_CONFIG, ...value }
}

export async function writeConfig(patch) {
  const { value, errors } = validateConfigPatch(patch)
  if (errors.length > 0) {
    const error = new Error(errors.join('；'))
    error.status = 400
    throw error
  }
  await update('config.json', () => ({}), (current) => {
    Object.assign(current, value)
  })
  return readConfig()
}

/* ── account ─────────────────────────────────────────────────────────────── */
//
// What signing in to the game leaves behind: the server, who, and the session
// cookie the game issued. The password is never written anywhere.

const COOKIE = /^[A-Za-z0-9_.-]{1,64}=[A-Za-z0-9._~-]{1,512}$/

/** @returns {{ server: string, cookie: string, username: string, nickname: string, at: number } | null} */
export async function readAccount() {
  const stored = await readJson('account.json', {})
  const server = normalizeServer(stored.server)
  if (!server || typeof stored.cookie !== 'string' || !COOKIE.test(stored.cookie)) return null
  return {
    server,
    cookie: stored.cookie,
    username: String(stored.username ?? '').slice(0, 64),
    nickname: String(stored.nickname ?? '').slice(0, 64),
    at: Number(stored.at) || 0,
  }
}

/** The last server signed in to, kept after signing out so the form remembers it. */
export async function lastServer() {
  const stored = await readJson('account.json', {})
  return normalizeServer(stored.server) ?? ''
}

export function writeAccount({ server, cookie, username, nickname }) {
  if (!normalizeServer(server) || !COOKIE.test(String(cookie ?? ''))) throw new Error('无效的登录信息')
  return update(
    'account.json',
    () => ({}),
    (current) => {
      for (const key of Object.keys(current)) delete current[key]
      Object.assign(current, { server: normalizeServer(server), cookie, username, nickname, at: Date.now() })
    },
    { secret: true },
  )
}

/** Forget the cookie; keep the server address for the next sign-in. */
export function clearAccount() {
  return update(
    'account.json',
    () => ({}),
    (current) => {
      const server = normalizeServer(current.server)
      for (const key of Object.keys(current)) delete current[key]
      if (server) current.server = server
    },
    { secret: true },
  )
}

/* ── sessions holding a card ─────────────────────────────────────────────── */

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/

export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value)
}

/** Most recent first. */
export async function readSessions() {
  const state = await readJson('sessions.json', {})
  return Array.isArray(state.sessions) ? state.sessions.filter((entry) => isSessionId(entry?.sessionId)) : []
}

/** @param {{ sessionId: string, room: number|null, name: string }} entry */
export function recordSession({ sessionId, room, name }) {
  if (!isSessionId(sessionId)) return Promise.resolve(null)
  return update('sessions.json', () => ({ sessions: [] }), (state) => {
    const list = Array.isArray(state.sessions) ? state.sessions : []
    const entry = { sessionId, room: Number.isSafeInteger(room) ? room : null, name: String(name ?? '').slice(0, 100), at: Date.now() }
    state.sessions = [entry, ...list.filter((item) => item?.sessionId !== sessionId)].slice(0, SESSIONS_LIMIT)
    return entry
  })
}

export function forgetSession(sessionId) {
  return update('sessions.json', () => ({ sessions: [] }), (state) => {
    const list = Array.isArray(state.sessions) ? state.sessions : []
    state.sessions = list.filter((item) => item?.sessionId !== sessionId)
    return state.sessions
  })
}
