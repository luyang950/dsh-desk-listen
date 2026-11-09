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
