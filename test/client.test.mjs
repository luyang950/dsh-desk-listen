// The browser bundle's loader contract: one ModuleLoader registration, only `react`
// required, the declared services are the only ones touched, the `/listen`
// lifecycle folds into one node, and the keyboard never reaches beyond its scope.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  memo: (component) => component,
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (reducer, initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (subscribe, get) => get(),
}

function loadBundle({ fetch } = {}) {
  const registrations = []
  const listeners = []
  const window = {
    listeners,
    location: { href: 'http://127.0.0.1:3080/' },
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
  }
  const required = []
  const sandbox = {
    window,
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    fetch: fetch || (() => Promise.reject(new Error('network disabled in tests'))),
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  sandbox.globalThis = sandbox
  runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1)
  const plugin = registrations[0].factory((id) => {
    required.push(id)
    return REACT_STUB
  })
  return { registration: registrations[0], plugin, required, window, sandbox }
}

function mount(options) {
  const loaded = loadBundle(options)
  const effects = []
  const definitions = []
  const slots = []
  const ctx = {
    effect: (run, label) => effects.push({ run, label }),
    get: () => undefined,
    uiConversation: { events: { register: (definition) => (definitions.push(definition), () => {}) } },
    slots: {
      inject: (key, run) => run(),
      register: (options, component) => (slots.push({ options, component }), () => {}),
    },
  }
  loaded.plugin.apply(ctx)
  const disposers = effects.map((effect) => effect.run())
  return Object.assign(loaded, { effects, definitions, slots, disposers })
}

function fold(definition, run, done) {
  const startEvent = { type: 'command/run', seq: 11, time: 5, data: run }
  const startMatch = definition.match(startEvent)
  if (startMatch === null) return { startMatch, node: null }
  const start = { event: startEvent, role: 'start', location: { turn: 2, step: 0 } }
  let context = { key: `${definition.kind}:${startMatch.id}`, id: startMatch.id, start, state: undefined }
  context.state = definition.start(context, start)
  if (done) {
    const updateMatch = definition.match({ type: 'command/done', seq: 12, data: done })
    if (updateMatch && updateMatch.id === startMatch.id) {
      context = Object.assign({}, context, { state: definition.update(context, { event: { type: 'command/done', seq: 12, data: done } }) })
    }
  }
  return { startMatch, node: definition.buildViewNode(context) }
}

const plain = (value) => JSON.parse(JSON.stringify(value))

test('one ModuleLoader registration under the package id; only react is required', () => {
  const { registration, plugin, required } = loadBundle()
  assert.equal(registration.id, 'dsh-desk-listen')
  assert.deepEqual([...new Set(required)], ['react'])
  assert.equal(plugin.name, 'dsh-desk-listen')
})

test('every ctx.<service> the bundle touches is declared in inject', () => {
  const { plugin } = loadBundle()
  assert.deepEqual([...plugin.inject].sort(), ['slots', 'uiConversation'])
  const builtins = new Set(['effect', 'inject', 'get', 'on', 'off', 'logger'])
  for (const [, service] of SOURCE.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    if (builtins.has(service)) continue
    assert.ok(plugin.inject.includes(service), `ctx.${service} used but not injected`)
  }
})

test('apply registers the node, an empty command row, the menu row and settings', () => {
  const { definitions, slots, window } = mount()
  assert.equal(definitions.length, 1)
  assert.deepEqual(
    slots.map((s) => [s.options.name, s.options.key ?? s.options.id]),
    [
      ['conversation.chat.node', 'dsh-desk-listen'],
      ['conversation.chat.commandview', 'listen'],
      ['sidebar.panellist.actions', 'dsh-desk-listen'],
      ['settings.section', 'dsh-desk-listen'],
    ],
  )
  const hidden = slots[1].component
  assert.equal(hidden(), null)
  assert.deepEqual(window.listeners.map((l) => [l.type, l.capture]), [['keydown', true]])
})

test('/listen run + done fold into one ready node with the room summary', () => {
  const { definitions } = mount()
  const summary = { room: 3, name: '摸鱼电台', joined: true, at: 1700 }
  const { startMatch, node } = fold(definitions[0], { name: 'listen', commandId: 'c1' }, { commandId: 'c1', kind: 'success', text: JSON.stringify(summary) })
  assert.equal(startMatch.role, 'start')
  assert.equal(startMatch.exclusive, undefined, 'the built-in command node must still see the run')
  assert.equal(node.kind, 'dsh-desk-listen')
  assert.equal(node.anchorSeq, 11)
  assert.deepEqual(plain(node.data.summary), summary)
  assert.equal(node.data.status, 'ready')
})

test('other commands are left alone; failures and junk become an error node', () => {
  const { definitions } = mount()
  assert.equal(fold(definitions[0], { name: 'read', commandId: 'c2' }).node, null)
  const failed = fold(definitions[0], { name: 'listen', commandId: 'c3' }, { commandId: 'c3', kind: 'error', text: '没有这个房间' })
  assert.equal(failed.node.data.status, 'error')
  assert.equal(failed.node.data.error, '没有这个房间')
  const junk = fold(definitions[0], { name: 'listen', commandId: 'c4' }, { commandId: 'c4', kind: 'success', text: '{oops' })
  assert.equal(junk.node.data.status, 'error')
  const pending = fold(definitions[0], { name: 'listen', commandId: 'c5' })
  assert.equal(pending.node.data.status, 'pending')
})

test('what the card line means', () => {
  const { plugin } = loadBundle()
  const p = (text) => plain(plugin.parseInput(text))
  assert.deepEqual(p('  '), { kind: 'none' })
  assert.deepEqual(p('今天这首好听'), { kind: 'say', text: '今天这首好听' })
  assert.deepEqual(p('/点 孤勇者'), { kind: 'search', text: '孤勇者' })
  assert.deepEqual(p('／搜 陈奕迅 后来'), { kind: 'search', text: '陈奕迅 后来' })
  assert.deepEqual(p('/切'), { kind: 'skip' })
  assert.deepEqual(p('/停'), { kind: 'pause' })
  assert.deepEqual(p('/放'), { kind: 'resume' })
  assert.deepEqual(p('/队列'), { kind: 'queue' })
  assert.deepEqual(p('/离开'), { kind: 'leave' })
  assert.deepEqual(p('/不认识 的命令'), { kind: 'say', text: '/不认识 的命令' }, 'unknown slashes are just said')
})

test('chat lines merge by id, in order, and pictures read as tags', () => {
  const { plugin } = loadBundle()
  const kept = [{ id: 1 }, { id: 2 }]
  const merged = plugin.mergeLines(kept, [{ id: 2 }, { id: 4 }, { id: 3 }, null])
  assert.deepEqual(plain(merged.lines.map((l) => l.id)), [1, 2, 3, 4])
  assert.equal(merged.added.length, 2)
  assert.equal(plugin.mergeLines(kept, [{ id: 1 }]).lines, kept, 'nothing new: the same array')
  assert.equal(plugin.plainText('看 [图片:0123456789abcdef01234567]'), '看 [图片]')
  assert.equal(plugin.plainText('[表情:abc]'), '[表情]')
})

test('lyrics and the clock', () => {
  const { plugin } = loadBundle()
  const lines = plugin.parseLrc('[00:01.00]第一句\n[ti:歌名]\n[00:05.50][01:05.50]副歌\n[00:03]第二句')
  assert.deepEqual(plain(lines.map((l) => l.text)), ['第一句', '第二句', '副歌', '副歌'])
  assert.equal(plugin.lyricAt(lines, 0.2), -1)
  assert.equal(plugin.lyricAt(lines, 4), 1)
  assert.equal(plugin.clock(125.9), '2:05')
})

test('the card whose /listen ran last is the live one', () => {
  const { plugin } = loadBundle()
  assert.equal(plugin.liveCard(new Map([['a', 10], ['b', 30], ['c', 20]])), 'b')
  assert.equal(plugin.liveCard(new Map()), null)
})

test('the boss key only answers its own chord, and only while a card is on screen', () => {
  const { plugin } = mount()
  const press = (code, mods = {}) => {
    const event = { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods, prevented: false, preventDefault() { this.prevented = true }, stopPropagation() {} }
    plugin.onBossKey(event)
    return event.prevented
  }
  assert.equal(press('KeyM', { ctrlKey: true, altKey: true }), false, 'no card: the key is left alone')
  plugin.shared.cards.set('k', 1)
  assert.equal(press('KeyM'), false)
  assert.equal(press('KeyM', { ctrlKey: true, altKey: true }), true)
  assert.equal(plugin.shared.boss, true)
  plugin.shared.cards.clear()
  assert.equal(press('KeyM', { ctrlKey: true, altKey: true }), true, 'already hidden: the key still brings it back')
  assert.equal(plugin.shared.boss, false)
})

/* ── keeping in step with the room ───────────────────────────────────────── */

test('sync steps: wait after a seek, jump only when far off, otherwise nudge', () => {
  const { plugin } = loadBundle()
  const s = (diff, sinceSeekMs = 60_000, recentSeeks = 0) => plain(plugin.syncStep({ diff, sinceSeekMs, recentSeeks }))
  assert.deepEqual(s(-1.2, 900), { action: 'wait', rate: 1 }, 'just after a seek the audio always looks behind')
  assert.deepEqual(s(-0.8), { action: 'rate', rate: 1.06 }, 'under a second behind is caught up, not jumped')
  assert.deepEqual(s(0.3), { action: 'rate', rate: 0.97 })
  assert.deepEqual(s(0.05), { action: 'rate', rate: 1 })
  assert.deepEqual(s(-1.5), { action: 'seek', rate: 1 })
  assert.deepEqual(s(-5, 60_000, 3), { action: 'rate', rate: 1.06 }, 'out of seeks for now')
  assert.equal(plugin.nextLead(0.3, 0.9), 0.75)
  assert.equal(plugin.nextLead(0.3, -0.8), 0)
  assert.equal(plugin.nextLead(1.8, 1), 2)
  assert.equal(plugin.nextLead(0.3, 40), 0.3, 'nonsense is ignored')
})

/**
 * A stand-in <audio>: after every seek it stays silent for `latency` seconds
 * (decoder + sound output), then plays on from where it was put.
 */
async function simulate({ latency, joinAt = 30, seconds = 60, href = 'http://127.0.0.1:3080/', seekableStream = true }) {
  let clock = 1_800_000_000_000
  class FakeDate extends Date {
    static now() {
      return clock
    }
  }
  const audios = []
  class FakeAudio {
    constructor() {
      this.src = ''
      this.volume = 1
      this.muted = false
      this.paused = true
      this.playbackRate = 1
      this.readyState = 0
      this.seeking = false
      this.time = 0
      this.resumeAt = 0
      this.seeks = []
      audios.push(this)
    }
    get currentTime() {
      return this.time
    }
    set currentTime(value) {
      // Chromium cannot seek a stream whose length it was not told: it lands on 0.
      this.time = this.src.startsWith('blob:') || seekableStream ? value : 0
      this.seeks.push(clock)
      this.seeking = true
      this.readyState = 1
      this.resumeAt = clock + latency * 1000
    }
    get duration() {
      return this.src && this.readyState >= 1 ? 240 : NaN
    }
    get seekable() {
      if (!this.src || this.readyState < 1) return { length: 0, end: () => 0 }
      const end = this.src.startsWith('blob:') || seekableStream ? 240 : 0
      return { length: 1, end: () => end }
    }
    addEventListener() {}
    play() {
      // Starting from paused also takes a moment before it sounds.
      if (this.paused) this.resumeAt = Math.max(this.resumeAt, clock + latency * 1000)
      this.paused = false
      return Promise.resolve()
    }
    pause() {
      this.paused = true
    }
    load() {}
    removeAttribute() {
      this.src = ''
    }
    tick(ms) {
      if (this.src && this.readyState < 1) this.readyState = 1
      if (this.seeking && clock >= this.resumeAt) {
        this.seeking = false
        this.readyState = 4
      }
      if (this.src && !this.seeking && this.readyState < 3) this.readyState = 4
      if (!this.paused && !this.seeking && this.readyState >= 3 && clock >= this.resumeAt) this.time += (ms / 1000) * this.playbackRate
    }
  }
  const registrations = []
  const fetched = []
  const sandbox = {
    window: { location: { href }, addEventListener() {}, __ModuleLoader__: { load: (r) => registrations.push(r) } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    fetch: async (url) => {
      fetched.push(url)
      return { ok: true, status: 200, blob: async () => new Blob(['song']) }
    },
    AbortController,
    Audio: FakeAudio,
    Date: FakeDate,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
  }
  sandbox.globalThis = sandbox
  runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  const plugin = registrations[0].factory(() => REACT_STUB)
  const p = plugin.createPlayer()
  const audio = audios[0]
  p.room = 1
  p.view = { current: { id: 7, url: '/api/mod-media/listen/7', startAt: clock - joinAt * 1000, pausedAt: null, durationMs: 240_000 } }
  const diffs = []
  for (let ms = 0; ms < seconds * 1000; ms += 100) {
    clock += 100
    audio.tick(100)
    if (ms % 1000 === 0) p.align()
    diffs.push(audio.time - p.position())
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { seeks: audio.seeks.length, last: diffs.at(-1), fetched, src: audio.src }
}

for (const latency of [0.4, 0.8, 1.5]) {
  test(`a seek that takes ${latency}s to sound does not loop, and the audio catches up`, async () => {
    const run = await simulate({ latency })
    assert.ok(run.seeks <= 2, `seeked ${run.seeks} times`)
    assert.ok(Math.abs(run.last) < 0.15, `still ${run.last.toFixed(2)}s off after a minute`)
  })
  test(`from the very start of a song (sounding after ${latency}s), it plays on without going back`, async () => {
    const run = await simulate({ latency, joinAt: -2 })
    assert.ok(run.seeks <= 2, `seeked ${run.seeks} times`)
    assert.ok(Math.abs(run.last) < 0.15, `still ${run.last.toFixed(2)}s off after a minute`)
  })
}

test('on DSH desktop (dsh-app://, no content-length) the song is fetched whole and plays in place', async () => {
  const run = await simulate({ latency: 0.4, href: 'dsh-app://app/', seekableStream: false })
  assert.deepEqual(run.fetched, ['dsh-app://app/dsh-desk-listen/media/7'])
  assert.ok(run.src.startsWith('blob:'), run.src)
  assert.ok(run.seeks <= 2, `seeked ${run.seeks} times`)
  assert.ok(Math.abs(run.last) < 0.15, `still ${run.last.toFixed(2)}s off after a minute`)
})

test('a stream that will not seek switches to fetching the song whole', async () => {
  const run = await simulate({ latency: 0.4, seekableStream: false })
  assert.deepEqual(run.fetched, ['http://127.0.0.1:3080/dsh-desk-listen/media/7'])
  assert.ok(run.src.startsWith('blob:'), run.src)
  assert.ok(Math.abs(run.last) < 0.15, `still ${run.last.toFixed(2)}s off after a minute`)
})

test('a new version loaded into the same page takes over from the old player', async () => {
  class QuietAudio {
    constructor() {
      Object.assign(this, { src: '', paused: true, volume: 1, muted: false, playbackRate: 1, readyState: 0, seeking: false, currentTime: 0 })
    }
    addEventListener() {}
    play() {
      this.paused = false
      return Promise.resolve()
    }
    pause() {
      this.paused = true
    }
    load() {}
    removeAttribute() {
      this.src = ''
    }
  }
  const asked = []
  const view = { id: 1, name: '房间', current: null, queue: [], members: [] }
  const sandbox = {
    window: { location: { href: 'http://127.0.0.1:3080/' }, addEventListener() {}, __ModuleLoader__: { load: (r) => sandbox.loaded.push(r) } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    fetch: async (url) => {
      asked.push(url)
      return { status: 200, json: async () => ({ ok: true, data: url.endsWith('/time') ? { now: Date.now() } : view }) }
    },
    Audio: QuietAudio,
    URL,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    loaded: [],
  }
  sandbox.globalThis = sandbox
  const load = () => {
    runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
    return sandbox.loaded.at(-1).factory(() => REACT_STUB)
  }
  const mountIt = (plugin) => {
    const effects = []
    plugin.apply({
      effect: (run) => effects.push(run),
      get: () => undefined,
      uiConversation: { events: { register: () => () => {} } },
      slots: { inject: (k, run) => run(), register: () => () => {} },
    })
    for (const run of effects) run()
  }

  // What 0.1.0 / 0.1.1 left behind: a player with no build and no dispose(), playing.
  const leftover = { room: 1, view, quiet: true, audio: new QuietAudio() }
  leftover.audio.src = 'http://127.0.0.1:3080/dsh-desk-listen/media/7'
  leftover.audio.paused = false
  sandbox.__dshDeskListen__ = { boss: false, config: {}, status: null, cards: new Map(), listeners: new Set(), version: 0, player: leftover }

  const first = load()
  mountIt(first)
  const taken = first.shared.player
  assert.notEqual(taken, leftover)
  assert.equal(leftover.room, null, 'the old one has no room, so its timers do nothing')
  assert.equal(leftover.audio.paused, true)
  assert.equal(leftover.audio.src, '')
  assert.equal(taken.quiet, true, 'mute carries over')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(asked.includes('/dsh-desk-listen/api/game/room/1'), 'the new player follows the same room')
  assert.equal(taken.room, 1)
  assert.equal(first.player(), taken, 'the same load keeps its player')

  // The next version replaces this one the same way, through dispose().
  const second = load()
  mountIt(second)
  assert.notEqual(second.shared.player, taken)
  assert.equal(taken.room, null)
  await new Promise((resolve) => setTimeout(resolve, 20))
  second.shared.player.dispose()
})
