// Test helpers: fake request/response objects and a stand-in 工位股市 server.

import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

export async function tempDir(prefix = 'dsl-') {
  return mkdtemp(join(tmpdir(), prefix))
}

/** A minimal IncomingMessage stand-in. */
export function fakeRequest(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = Object.assign({ host: 'dsh.local' }, body === undefined ? {} : { 'content-type': 'application/json' }, headers)
  return req
}

/** A minimal ServerResponse stand-in that records status, headers and body (streams too). */
export function fakeResponse() {
  const chunks = []
  let done
  const finished = new Promise((resolve) => {
    done = resolve
  })
  return {
    status: 0,
    headers: {},
    writableEnded: false,
    headersSent: false,
    finished,
    on() {},
    once() {},
    emit() {},
    removeListener() {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      this.status = status
      this.headersSent = true
      for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk))
      this.writableEnded = true
      done()
    },
    destroy() {
      this.writableEnded = true
      done()
    },
    get bytes() {
      return Buffer.concat(chunks)
    },
    get body() {
      return Buffer.concat(chunks).toString('utf8')
    },
    get json() {
      return JSON.parse(this.body)
    },
  }
}

/**
 * The game, as far as the plugin sees it: sign-in, the session, versions,
 * the 一起听 mod's routes and the songs' audio. It checks what the real one
 * checks — cookie, same-site Origin on writes, the two version headers.
 */
export async function fakeGame() {
  const state = {
    app: 'v2-test',
    mod: '1.0.0',
    cookie: 'desk_v2=' + 'a'.repeat(64),
    calls: [],
    member: null,
    chat: [],
    song: Buffer.from('ID3' + 'x'.repeat(997)),
  }
  const rooms = [
    { id: 3, name: '摸鱼电台', owner: '阿丽', listeners: 2, playing: '小幸运' },
    { id: 5, name: '下班路上', owner: '阿宝', listeners: 0, playing: null },
    { id: 6, name: '下班以后', owner: '阿宝', listeners: 1, playing: null },
  ]
  const view = (id) => ({ id, name: rooms.find((r) => r.id === id).name, current: null, queue: [], members: [], canControl: true, now: Date.now() })
  const send = (res, status, payload, headers = {}) => {
    res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers))
    res.end(JSON.stringify(payload))
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined
    state.calls.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body })
    const signedIn = req.headers.cookie === state.cookie
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin
      if (!origin || origin.replace(/^https?:\/\//, '') !== req.headers.host) return send(res, 403, { error: 'origin' })
    }
    if (url.pathname === '/api/version') return send(res, 200, { version: state.app })
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (body?.username !== 'luyang' || body?.password !== 'secret-1') return send(res, 401, { error: '账号或密码不对' })
      return send(res, 200, { ok: true, user: { username: 'luyang', nickname: '阳' } }, { 'set-cookie': `${state.cookie}; HttpOnly; SameSite=Lax; Path=/` })
    }
    if (url.pathname === '/api/auth/logout') return send(res, 200, { ok: true })
    if (url.pathname === '/api/auth/session')
      return send(res, 200, signedIn ? { authenticated: true, user: { username: 'luyang', mods: [{ id: 'listen', version: state.mod }] } } : { authenticated: false, user: null })
    if (!signedIn) return send(res, 401, { error: '请先登录' })
    const media = /^\/api\/mod-media\/listen\/(\w[\w-]*)$/.exec(url.pathname)
    if (media) {
      if (media[1] !== '7') return send(res, 404, { error: 'not found' })
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
      if (range) {
        const from = Number(range[1])
        const to = range[2] ? Number(range[2]) : state.song.length - 1
        res.writeHead(206, { 'content-type': 'audio/mpeg', 'content-length': String(to - from + 1), 'content-range': `bytes ${from}-${to}/${state.song.length}`, 'accept-ranges': 'bytes' })
        return res.end(state.song.subarray(from, to + 1))
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(state.song.length), 'accept-ranges': 'bytes', 'set-cookie': 'nope=1' })
      return res.end(state.song)
    }
    const mod = /^\/api\/mods\/listen(\/.*)$/.exec(url.pathname)
    if (!mod) return send(res, 404, { error: 'not found' })
    if (req.headers['x-app-version'] !== state.app || req.headers['x-mod-version'] !== state.mod) return send(res, 409, { error: 'outdated' })
    const at = mod[1]
    if (at === '/time') return send(res, 200, { now: Date.now() })
    if (at === '/me') return send(res, 200, { room: state.member })
    if (at === '/rooms') return send(res, 200, { available: true, mine: state.member, rooms })
    const join = /^\/room\/(\d+)\/join$/.exec(at)
    if (join && req.method === 'POST') {
      const id = Number(join[1])
      if (!rooms.some((r) => r.id === id)) return send(res, 404, { error: '没有这个房间，可能已经关了' })
      state.member = id
      return send(res, 200, view(id))
    }
    const room = /^\/room\/(\d+)$/.exec(at)
    if (room) return send(res, 200, view(Number(room[1])))
    const chat = /^\/room\/(\d+)\/chat$/.exec(at)
    if (chat && req.method === 'POST') {
      const line = { id: state.chat.length + 1, user: 'luyang', nickname: '阳', kind: 'say', text: body.text, at: Date.now() }
      state.chat.push(line)
      return send(res, 200, line)
    }
    const drop = /^\/room\/(\d+)\/queue\/(\d+)$/.exec(at)
    if (drop && req.method === 'DELETE') return send(res, 200, { ok: true })
    return send(res, 404, { error: 'not found' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { state, origin, close: () => new Promise((resolve) => server.close(resolve)) }
}
