// Host half: config and account persistence, signing in (only the cookie is kept),
// passing calls on to the game as the player, the audio stream, the write guard,
// and what /listen settles with.

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test, { after, before } from 'node:test'

import { API_PREFIX, MEDIA_PREFIX, PREFIX, WRITE_HEADER, apply, handleRequest, inject, listenCommand } from '../index.mjs'
import { forgetVersions } from '../lib/game.mjs'
import { dataDirectory, normalizeChord, normalizeServer, readAccount, readConfig, validateConfigPatch } from '../lib/store.mjs'
import { fakeGame, fakeRequest, fakeResponse, tempDir } from './helpers.mjs'

let home
let game

before(async () => {
  home = await tempDir('dsl-home-')
  process.env.DSH_HOME = home
  game = await fakeGame()
})

after(() => game.close())

const W = { [WRITE_HEADER]: '1' }

async function api(method, path, body, headers = {}) {
  const res = fakeResponse()
  await handleRequest(fakeRequest(method, `${API_PREFIX}${path}`, body, headers), res)
  await res.finished
  return { status: res.status, body: res.json, headers: res.headers }
}

async function signIn() {
  return api('POST', '/login', { server: game.origin, username: 'luyang', password: 'secret-1' }, W)
}

/* ── store ───────────────────────────────────────────────────────────────── */

test('config validation keeps good values and refuses bad ones', async () => {
  assert.deepEqual(validateConfigPatch({ bossMute: true, sessionTitle: ' 周报 ' }).value, { bossMute: true, sessionTitle: '周报' })
  assert.ok(validateConfigPatch({ bossKey: 'KeyM' }).errors.length > 0, 'a bare letter would eat typing')
  assert.ok(validateConfigPatch({ volume: 1 }).errors.length > 0, 'unknown keys are refused')
  assert.equal(normalizeChord('ctrl+alt+KeyM'), 'Ctrl+Alt+KeyM')
  assert.equal(normalizeChord('Shift+KeyM'), null)
  assert.equal((await readConfig()).bossKey, 'Ctrl+Alt+KeyM')
})

test('the server address is an origin and nothing more', () => {
  assert.equal(normalizeServer('10.0.0.8:30418'), 'http://10.0.0.8:30418')
  assert.equal(normalizeServer('https://game.test/'), 'https://game.test')
  assert.equal(normalizeServer('http://game.test/api'), null)
  assert.equal(normalizeServer('http://u:p@game.test'), null)
  assert.equal(normalizeServer('file:///etc/passwd'), null)
  assert.equal(normalizeServer(''), null)
})

/* ── signing in ──────────────────────────────────────────────────────────── */

test('before signing in, /listen opens the card and the game routes say so', async () => {
  const empty = await listenCommand().handler({ rawInput: '/listen' })
  assert.equal(empty.kind, 'success')
  assert.equal(JSON.parse(empty.text).room, null)
  const named = await listenCommand().handler({ rawInput: '/listen 摸鱼' })
  assert.equal(named.kind, 'error')
  const res = await api('GET', '/game/rooms')
  assert.equal(res.status, 401)
  assert.match(res.body.error, /登录/)
})

test('a wrong password is refused and nothing is stored', async () => {
  const res = await api('POST', '/login', { server: game.origin, username: 'luyang', password: 'nope' }, W)
  assert.equal(res.status, 401)
  assert.equal(res.body.error, '账号或密码不对')
  assert.equal(await readAccount(), null)
})

test('signing in keeps the session cookie, never the password, in a 0600 file', async () => {
  const res = await signIn()
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.account, { server: game.origin, username: 'luyang', nickname: '阳' })
  const file = join(dataDirectory(), 'account.json')
  const raw = await readFile(file, 'utf8')
  assert.ok(raw.includes(game.state.cookie))
  assert.ok(!raw.includes('secret-1'))
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const login = game.state.calls.findLast((c) => c.path === '/api/auth/login')
  assert.equal(login.headers.origin, game.origin, 'the game wants a same-site Origin on writes')
})

/* ── the write guard ─────────────────────────────────────────────────────── */

test('writes without our header, or from another site, are refused', async () => {
  await signIn()
  assert.equal((await api('POST', '/game/room/3/chat', { text: 'hi' })).status, 403)
  assert.equal((await api('POST', '/game/room/3/chat', { text: 'hi' }, { ...W, origin: 'https://evil.example' })).status, 403)
  assert.equal((await api('POST', '/config', { bossMute: true })).status, 403)
  const ok = await api('POST', '/game/room/3/chat', { text: '你好' }, { ...W, origin: 'http://dsh.local' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.data.text, '你好')
})

test('a form post cannot reach the game: bodies must be JSON', async () => {
  await signIn()
  const res = fakeResponse()
  const req = fakeRequest('POST', `${API_PREFIX}/game/room/3/chat`, 'text=hi', { ...W, 'content-type': 'application/x-www-form-urlencoded' })
  await handleRequest(req, res)
  assert.equal(res.status, 415)
})

/* ── passing calls on ────────────────────────────────────────────────────── */

test('calls go to /api/mods/listen with the cookie, Origin and both versions', async () => {
  await signIn()
  const res = await api('GET', '/game/rooms')
  assert.equal(res.status, 200)
  assert.equal(res.body.data.rooms.length, 3)
  const sent = game.state.calls.findLast((c) => c.path === '/api/mods/listen/rooms')
  assert.equal(sent.headers.cookie, game.state.cookie)
  assert.equal(sent.headers['x-app-version'], game.state.app)
  assert.equal(sent.headers['x-mod-version'], game.state.mod)
})

test('after the game is updated, the call is retried once with the new versions', async () => {
  await signIn()
  await api('GET', '/game/me')
  game.state.app = 'v2-newer'
  game.state.mod = '1.1.0'
  const res = await api('GET', '/game/me')
  assert.equal(res.status, 200)
  const last = game.state.calls.findLast((c) => c.path === '/api/mods/listen/me')
  assert.equal(last.headers['x-mod-version'], '1.1.0')
})

test('the game\'s refusals come back as they are', async () => {
  await signIn()
  const res = await api('POST', '/game/room/99/join', {}, W)
  assert.equal(res.status, 404)
  assert.equal(res.body.error, '没有这个房间，可能已经关了')
})

test('odd paths never reach the game', async () => {
  await signIn()
  for (const path of ['/game/../auth/logout', '/game/a//b', '/game/room/3/%2e%2e/x']) {
    const res = await api('GET', path)
    if (res.status === 200) assert.fail(`${path} was passed on`)
  }
  assert.equal((await api('PATCH', '/game/rooms', {}, W)).status, 405)
})

test('an expired session clears the stored cookie', async () => {
  await signIn()
  const real = game.state.cookie
  game.state.cookie = 'desk_v2=' + 'b'.repeat(64)
  forgetVersions()
  const res = await api('GET', '/game/rooms')
  assert.equal(res.status, 401)
  assert.match(res.body.error, /过期/)
  assert.equal(await readAccount(), null)
  game.state.cookie = real
})

/* ── audio ───────────────────────────────────────────────────────────────── */

test('the song streams through with Range, and the game\'s cookies stay behind', async () => {
  await signIn()
  const whole = fakeResponse()
  await handleRequest(fakeRequest('GET', `${MEDIA_PREFIX}/7`), whole)
  await whole.finished
  assert.equal(whole.status, 200)
  assert.equal(whole.bytes.length, 1000)
  assert.equal(whole.headers['content-type'], 'audio/mpeg')
  assert.equal(whole.headers['set-cookie'], undefined)

  const part = fakeResponse()
  await handleRequest(fakeRequest('GET', `${MEDIA_PREFIX}/7`, undefined, { range: 'bytes=10-19' }), part)
  await part.finished
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes 10-19/1000')
  assert.equal(part.bytes.toString(), 'x'.repeat(10))

  const missing = fakeResponse()
  await handleRequest(fakeRequest('GET', `${MEDIA_PREFIX}/8`), missing)
  assert.equal(missing.status, 404)
  const bad = fakeResponse()
  await handleRequest(fakeRequest('GET', `${MEDIA_PREFIX}/..%2Fsecret`), bad)
  assert.equal(bad.status, 404)
})

/* ── /listen ─────────────────────────────────────────────────────────────── */

test('/listen resolves a room by number or by name, and joins it', async () => {
  await signIn()
  const command = listenCommand()
  const byId = JSON.parse((await command.handler({ rawInput: '/listen 5' })).text)
  assert.deepEqual([byId.room, byId.name, byId.joined], [5, '下班路上', true])
  const byName = JSON.parse((await command.handler({ rawInput: '/listen 摸鱼' })).text)
  assert.deepEqual([byName.room, byName.joined], [3, true])
  const many = await command.handler({ rawInput: '/listen 下班' })
  assert.equal(many.kind, 'error')
  assert.match(many.text, /2 个房间/)
  const none = await command.handler({ rawInput: '/listen 不存在' })
  assert.equal(none.kind, 'error')
  assert.match(none.text, /摸鱼电台/)
  const back = JSON.parse((await command.handler({ rawInput: '/listen' })).text)
  assert.deepEqual([back.room, back.joined], [3, false], 'empty: the room the player is in, not joined again')
})

test('/listen records its Session for the sidebar and hands the summary to the hook', async () => {
  await signIn()
  let seen = null
  const command = listenCommand({ afterListen: (_, summary) => (seen = summary) })
  await command.handler({ rawInput: '/listen 3', agent: { session: { id: 'sess-1' } } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.room, 3)
  const res = await api('GET', '/sessions')
  assert.equal(res.body.sessions[0].sessionId, 'sess-1')
  assert.equal(res.body.sessions[0].name, '摸鱼电台')
})

/* ── plugin wiring ───────────────────────────────────────────────────────── */

test('apply registers the command and one prefix route, and nothing else', () => {
  assert.deepEqual(inject, ['commands'])
  const commands = []
  const routes = []
  const ctx = {
    inject(names, run) {
      if (names[0] === 'webServer') run({ webServer: { register: (r) => (routes.push(r), () => {}) }, effect: (fn) => fn() })
    },
    on() {},
    commands: { register: (c) => commands.push(c.name) },
  }
  apply(ctx)
  assert.deepEqual(commands, ['listen'])
  assert.deepEqual(routes.map((r) => [r.kind, r.path]), [['prefix', PREFIX]])
})

test('signing out forgets the cookie but remembers the server', async () => {
  await signIn()
  const res = await api('POST', '/logout', {}, W)
  assert.equal(res.body.account, null)
  assert.equal(res.body.server, game.origin)
  assert.equal(await readAccount(), null)
})
