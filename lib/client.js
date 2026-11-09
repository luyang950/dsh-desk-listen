/* global window, document, fetch, localStorage, Audio, Blob, URL, setTimeout, clearTimeout, setInterval, clearInterval, console */
// dsh-desk-listen — browser half.
//
// Hand-written ModuleLoader bundle: no build step. The only hard dependency is
// `react`; DSH's own menu primitives are borrowed when present (with a plain
// fallback), and `uiWorkspace` / `sessions` / `workspaces` are read optionally for
// the sidebar's 继续听 rows.
//
// How the card lives in the transcript:
//   `/listen [room]` logs the ordinary durable `command/run` + `command/done` pair
//   (log-only events — never model messages, so zero tokens). A custom Definition
//   folds that pair into one chat node of kind `dsh-desk-listen`; the node renders
//   the card where the user typed `/listen`. The generic command row is suppressed
//   by registering an empty `listen` commandview.
//
// The player is one object for the whole page, not part of any card: the music
// keeps playing while you switch Sessions, and every card is just a view of it.
// Only the newest card on screen is live; older ones fold to a single line.
//
// Keeping in step with the room: the game says at which moment of its clock the
// song started (startAt). The page estimates its offset from the game's clock
// (the fastest of three /time round trips), and every second puts the <audio>
// where it should be: a jump when it is off by more than half a second, else a
// playbackRate of 0.97 / 1.03 until it catches up. There is no push channel from
// the game here, so the room is re-read every few seconds and the chat polled.

window.__ModuleLoader__.load({
  id: 'dsh-desk-listen',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const h = React.createElement

    const ROOT = '/dsh-desk-listen'
    const API = `${ROOT}/api`
    const MEDIA = `${ROOT}/media`
    const KIND = 'dsh-desk-listen'
    const COMMAND = 'listen'
    const WRITE_HEADER = 'x-dsh-desk-listen'

    const TICK_MS = 1000
    const ROOM_MS = 4000
    const CHAT_MS = 2500
    const BEAT_MS = 20_000
    const CLOCK_MS = 120_000
    // Keeping in step (see syncStep): jump only when far off, then leave the
    // <audio> alone until it is really playing again; small gaps are closed by
    // playing a little faster or slower.
    const JUMP_S = 1
    const PAUSED_JUMP_S = 0.5
    const NUDGE_S = 0.08
    const SETTLE_MS = 3000
    const SEEK_WINDOW_MS = 30_000
    const SEEKS_PER_WINDOW = 3
    const LEAD_MAX_S = 2
    const CHAT_KEPT = 200
    const FRESH_MS = 60_000
    const VOLUME_KEY = 'dsh-desk-listen:volume'
    const BOSS_KEY = 'dsh-desk-listen:boss'

    const DEFAULT_CONFIG = Object.freeze({
      bossKey: 'Ctrl+Alt+KeyM',
      bossMute: false,
      keepSession: true,
      sessionTitle: '',
    })

    /* ── shared state (survives hot replacement via a fixed global slot) ──── */

    const SLOT = '__dshDeskListen__'
    const shared = (globalThis[SLOT] = globalThis[SLOT] || {
      boss: readFlag(BOSS_KEY),
      config: Object.assign({}, DEFAULT_CONFIG),
      status: null, // { account, server } once read
      cards: new Map(), // mounted card key → the time its /listen ran
      listeners: new Set(),
      version: 0,
    })

    function readFlag(key) {
      try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
      } catch {
        return false
      }
    }

    function writeFlag(key, value) {
      try {
        if (typeof localStorage === 'undefined') return
        if (value) localStorage.setItem(key, '1')
        else localStorage.removeItem(key)
      } catch {
        // private mode / quota: keep the in-memory value only
      }
    }

    function emit() {
      shared.version += 1
      for (const listener of Array.from(shared.listeners)) listener()
    }

    function subscribe(listener) {
      shared.listeners.add(listener)
      return () => shared.listeners.delete(listener)
    }

    /** Re-render on any change of the shared state or the player. */
    function useVersion() {
      const read = () => shared.version
      return React.useSyncExternalStore(subscribe, read, read)
    }

    function setBoss(value) {
      shared.boss = Boolean(value)
      writeFlag(BOSS_KEY, shared.boss)
      if (shared.player) shared.player.bossQuiet(shared.boss && shared.config.bossMute)
      emit()
    }

    /* ── api ─────────────────────────────────────────────────────────────── */

    async function call(path, options) {
      const response = await fetch(API + path, options)
      const payload = await response.json().catch(() => null)
      if (!payload) throw new Error(`请求失败（HTTP ${response.status}）`)
      if (payload.ok !== true) {
        const error = new Error(payload.error || `请求失败（HTTP ${response.status}）`)
        error.status = response.status
        if (response.status === 401) void refreshStatus().catch(() => {})
        throw error
      }
      return payload
    }

    function post(path, body) {
      return call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [WRITE_HEADER]: '1' },
        body: JSON.stringify(body || {}),
      })
    }

    /** One call to the game's 一起听 mod, through the host. */
    async function game(method, path, body) {
      const options =
        method === 'GET'
          ? undefined
          : {
              method,
              headers: Object.assign({ [WRITE_HEADER]: '1' }, method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
              body: method === 'DELETE' ? undefined : JSON.stringify(body || {}),
            }
      const payload = await call(`/game${path}`, options)
      return payload.data
    }

    async function refreshStatus() {
      const payload = await call('/status')
      shared.status = { account: payload.account, server: payload.server }
      shared.config = payload.config
      emit()
      return shared.status
    }

    async function saveConfig(patch) {
      const payload = await post('/config', patch)
      shared.config = payload.config
      if (shared.player) shared.player.bossQuiet(shared.boss && shared.config.bossMute)
      emit()
      return payload.config
    }

    /* ── pure helpers (exported for tests) ───────────────────────────────── */

    function clock(seconds) {
      const t = Math.max(0, Math.floor(Number(seconds) || 0))
      return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
    }

    function artistsOf(song) {
      return song && Array.isArray(song.artists) && song.artists.length ? song.artists.join(' / ') : '未知歌手'
    }

    /** LRC → [{ t: seconds, text }], sorted; lines without a time tag are dropped. */
    function parseLrc(text) {
      const out = []
      for (const line of String(text || '').split('\n')) {
        const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
        if (!stamps.length) continue
        const words = line.replace(/\[[^\]]*\]/g, '').trim()
        if (!words) continue
        for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0), text: words })
      }
      return out.sort((a, b) => a.t - b.t)
    }

    /** The lyric line showing at `position` seconds, or -1. */
    function lyricAt(lines, position) {
      let index = -1
      for (let i = 0; i < lines.length && lines[i].t <= position + 0.3; i += 1) index = i
      return index
    }

    /** Chat text as plain words: pictures and stickers become a tag. */
    function plainText(text) {
      return String(text || '')
        .replace(/\[图片:[0-9a-f]{24}\]/g, '[图片]')
        .replace(/^\[表情:[^\]]*\]$/, '[表情]')
    }

    /** Merge newly fetched chat lines into the kept ones: by id, in order, the newest few. */
    function mergeLines(kept, fresh) {
      const known = new Set(kept.map((line) => line.id))
      const added = fresh.filter((line) => line && Number.isFinite(line.id) && !known.has(line.id))
      if (!added.length) return { lines: kept, added }
      return { lines: kept.concat(added).sort((a, b) => a.id - b.id).slice(-CHAT_KEPT), added }
    }

    /**
     * What the composer line means: a chat line, or one of the card's commands.
     *   /点 歌名 · /搜 歌名  search to pick      /切  skip
     *   /停  pause   /放  resume   /队列  the queue   /离开  leave the room
     */
    function parseInput(text) {
      const raw = String(text || '').trim()
      if (!raw) return { kind: 'none' }
      const m = /^[/／](\S+)\s*([\s\S]*)$/.exec(raw)
      if (!m) return { kind: 'say', text: raw }
      const word = m[1]
      const rest = m[2].trim()
      if (['点', '点歌', '搜', 's', 'search'].includes(word)) return rest ? { kind: 'search', text: rest } : { kind: 'search', text: '' }
      if (['切', '切歌', 'skip', 'next'].includes(word)) return { kind: 'skip' }
      if (['停', '暂停', 'pause'].includes(word)) return { kind: 'pause' }
      if (['放', '继续', 'resume', 'play'].includes(word)) return { kind: 'resume' }
      if (['队列', 'queue', 'q'].includes(word)) return { kind: 'queue' }
      if (['离开', 'leave'].includes(word)) return { kind: 'leave' }
      if (['静音', 'mute'].includes(word)) return { kind: 'mute' }
      return { kind: 'say', text: raw }
    }

    /**
     * One step of keeping the <audio> with the room. `diff` is audio − room
     * (seconds; above zero the audio is ahead).
     *
     * A seek is not instant: the decoder and the sound output need a moment
     * (more with Bluetooth) before the audio moves again, so right after one
     * the audio always looks behind. Judging it then made the player seek
     * again every second, forever replaying the same second. So: after a seek,
     * wait until it has settled; seek only when far off, and only a few times
     * in a while; otherwise nudge the speed.
     * @returns {{ action: 'wait' | 'seek' | 'rate', rate: number }}
     */
    function syncStep({ diff, sinceSeekMs, recentSeeks }) {
      if (sinceSeekMs < SETTLE_MS) return { action: 'wait', rate: 1 }
      const gap = Math.abs(diff)
      if (gap > JUMP_S && recentSeeks < SEEKS_PER_WINDOW) return { action: 'seek', rate: 1 }
      if (gap <= NUDGE_S) return { action: 'rate', rate: 1 }
      const step = gap > 0.5 ? 0.06 : 0.03
      return { action: 'rate', rate: diff > 0 ? 1 - step : 1 + step }
    }

    /**
     * How far ahead to aim the next seek: half of what the last seek ended up
     * behind by, once settled, added to the lead it was aimed with.
     */
    function nextLead(lead, behind) {
      if (!Number.isFinite(behind) || Math.abs(behind) > 3) return lead
      // Half a step: the first seek of a song also waits for the network, later ones less.
      return Math.round(Math.min(LEAD_MAX_S, Math.max(0, lead + behind / 2)) * 100) / 100
    }

    /** Which mounted card is live: the one whose /listen ran last. */
    function liveCard(cards) {
      let best = null
      let bestAt = -Infinity
      for (const [key, at] of cards) {
        if (at > bestAt || (at === bestAt && String(key) > String(best))) {
          best = key
          bestAt = at
        }
      }
      return best
    }

    /* ── keyboard chords (boss key) ──────────────────────────────────────── */

    function chordOf(event) {
      const parts = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')
      parts.push(event.code || '')
      return parts.join('+')
    }

    function isModifierCode(code) {
      return /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code || '')
    }

    function chordLabel(chord) {
      return String(chord || '')
        .split('+')
        .map((part) => part.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Backquote$/, '`'))
        .join(' + ')
    }

    /**
     * The one window-level listener this plugin owns. It only reacts to the
     * configured modifier chord, and only while a card exists (or the cards are
     * already hidden), so ordinary typing is never touched.
     */
    function onBossKey(event) {
      if (event.isComposing || event.keyCode === 229 || event.repeat || shared.capturing) return
      const chord = shared.config && shared.config.bossKey
      if (!chord || chordOf(event) !== chord) return
      if (shared.cards.size <= 0 && !shared.boss) return
      event.preventDefault()
      event.stopPropagation()
      setBoss(!shared.boss)
    }

    /* ── the player ──────────────────────────────────────────────────────── */

    /** A tenth of a second of silence, played inside a click so later songs may start on their own. */
    function silenceUrl() {
      const samples = 800
      const bytes = new Uint8Array(44 + samples)
      const view = new DataView(bytes.buffer)
      const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
      text(0, 'RIFF')
      view.setUint32(4, 36 + samples, true)
      text(8, 'WAVEfmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 8000, true)
      view.setUint32(28, 8000, true)
      view.setUint16(32, 1, true)
      view.setUint16(34, 8, true)
      text(36, 'data')
      view.setUint32(40, samples, true)
      bytes.fill(128, 44)
      return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    }

    function readVolume() {
      try {
        const raw = localStorage.getItem(VOLUME_KEY)
        const value = Number(raw)
        return raw !== null && value >= 0 && value <= 1 ? value : 0.6
      } catch {
        return 0.6
      }
    }

    function createPlayer() {
      const audio = typeof Audio === 'function' ? new Audio() : null
      if (audio) {
        audio.preload = 'auto'
        audio.volume = readVolume()
      }
      let silence = null
      const p = {
        room: null, // the room id the page is in
        view: null, // the game's view of that room
        chat: [],
        chatRoom: null,
        lyric: { id: null, lines: [] },
        offset: 0, // game clock − this clock, ms
        blocked: false, // the browser would not let the page make a sound
        quiet: false, // the 🔇 button
        hushed: false, // the boss key, when it also silences
        error: '',
        busy: false,
      }
      let timers = []
      let startTimer = null
      // Seeks: when the last was, those in the last half minute, and how far
      // ahead to aim (learned from how far behind the last one landed).
      let lastSeekAt = -Infinity
      let seekTimes = []
      let lead = 0.3
      let measureLead = false
      let chatBusy = false
      let roomBusy = false

      const serverNow = () => Date.now() + p.offset
      const position = () => {
        const cur = p.view && p.view.current
        if (!cur || cur.startAt === null || cur.startAt === undefined) return 0
        if (cur.pausedAt !== null && cur.pausedAt !== undefined) return cur.pausedAt / 1000
        return Math.max(0, (serverNow() - cur.startAt) / 1000)
      }
      const srcOf = (cur) => (cur && cur.url ? new URL(`${MEDIA}/${encodeURIComponent(cur.id)}`, window.location.href).href : '')

      function applyVolume() {
        if (!audio) return
        const want = p.quiet || p.hushed
        if (audio.muted !== want) audio.muted = want
      }

      function play() {
        if (!audio) return
        audio.play().then(
          () => {
            if (p.blocked) {
              p.blocked = false
              emit()
            }
          },
          (error) => {
            if (error && error.name === 'NotAllowedError' && !p.blocked) {
              p.blocked = true
              emit()
            }
          },
        )
      }

      function stopAudio() {
        clearTimeout(startTimer)
        if (!audio) return
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }

      /** Put the <audio> where the room is. */
      function align() {
        clearTimeout(startTimer)
        if (!audio) return
        applyVolume()
        const cur = p.view && p.view.current
        if (!p.room || !cur || !cur.url || cur.startAt === null || cur.startAt === undefined) {
          if (!audio.paused) audio.pause()
          return
        }
        const src = srcOf(cur)
        if (audio.src !== src) {
          audio.src = src
          audio.playbackRate = 1
          lastSeekAt = -Infinity
          seekTimes = []
        }
        const duration = (cur.durationMs || 0) / 1000
        if (cur.pausedAt !== null && cur.pausedAt !== undefined) {
          audio.pause()
          if (audio.readyState >= 1 && Math.abs(audio.currentTime - cur.pausedAt / 1000) > PAUSED_JUMP_S) audio.currentTime = cur.pausedAt / 1000
          return
        }
        const pos = (serverNow() - cur.startAt) / 1000
        if (pos < 0) {
          audio.pause()
          if (audio.readyState >= 1 && audio.currentTime > 0.05) audio.currentTime = 0
          startTimer = setTimeout(align, -pos * 1000)
          return
        }
        if (duration && pos >= duration) {
          audio.pause()
          return
        }
        if (audio.readyState >= 1) {
          const seekTo = (target) => {
            const now = Date.now()
            seekTimes = seekTimes.filter((t) => now - t < SEEK_WINDOW_MS).concat(now)
            lastSeekAt = now
            measureLead = true
            audio.playbackRate = 1
            audio.currentTime = duration ? Math.min(target, Math.max(0, duration - 0.5)) : target
          }
          const diff = audio.currentTime - pos
          const playing = !audio.paused && !audio.seeking && audio.readyState >= 3
          if (!playing) {
            // Not making a sound yet (loading, blocked, just started): put it in place once.
            const now = Date.now()
            const recentSeeks = seekTimes.filter((t) => now - t < SEEK_WINDOW_MS).length
            const first = lastSeekAt === -Infinity
            if (Math.abs(diff) > PAUSED_JUMP_S && !audio.seeking && (first || (now - lastSeekAt >= SETTLE_MS && recentSeeks < SEEKS_PER_WINDOW))) seekTo(pos + lead)
          } else {
            const now = Date.now()
            const sinceSeekMs = audio.seeking ? 0 : now - lastSeekAt
            if (measureLead && sinceSeekMs >= SETTLE_MS) {
              // The first look after a seek has settled: learn how far behind it landed.
              measureLead = false
              lead = nextLead(lead, -diff)
            }
            const recentSeeks = seekTimes.filter((t) => now - t < SEEK_WINDOW_MS).length
            const step = syncStep({ diff, sinceSeekMs, recentSeeks })
            if (step.action === 'seek') seekTo(pos + lead)
            else if (audio.playbackRate !== step.rate) audio.playbackRate = step.rate
          }
        }
        if (audio.paused) play()
      }
      if (audio) audio.addEventListener('loadedmetadata', align)

      async function syncClock() {
        let best = null
        for (let i = 0; i < 3; i += 1) {
          const sent = Date.now()
          try {
            const answer = await game('GET', '/time')
            const got = Date.now()
            if (!best || got - sent < best.rtt) best = { rtt: got - sent, offset: answer.now + (got - sent) / 2 - got }
          } catch {
            break
          }
        }
        if (best) p.offset = best.offset
        align()
      }

      async function loadLyric() {
        const id = p.view && p.view.current && p.view.current.id
        if (!id || p.lyric.id === id) return
        p.lyric = { id, lines: [] }
        try {
          const answer = await game('GET', `/lyric?id=${encodeURIComponent(id)}`)
          if (p.lyric.id === id) p.lyric = { id, lines: parseLrc(answer && answer.lrc) }
          emit()
        } catch {
          // no lyric: the card shows the title only
        }
      }

      async function loadChat() {
        if (!p.room || chatBusy) return
        const asked = p.room
        if (p.chatRoom !== asked) {
          p.chatRoom = asked
          p.chat = []
        }
        const last = p.chat.length ? p.chat[p.chat.length - 1].id : 0
        chatBusy = true
        try {
          const lines = await game('GET', `/room/${asked}/chat${last ? `?after=${last}` : ''}`)
          if (p.room !== asked || p.chatRoom !== asked || !Array.isArray(lines)) return
          const merged = mergeLines(p.chat, lines)
          if (merged.added.length) {
            p.chat = merged.lines
            emit()
          }
        } catch {
          // next round
        } finally {
          chatBusy = false
        }
      }

      function gone(message) {
        p.room = null
        p.view = null
        p.chat = []
        p.chatRoom = null
        p.error = message || ''
        stopTimers()
        stopAudio()
        emit()
      }

      async function refresh() {
        if (!p.room || roomBusy) return
        const asked = p.room
        roomBusy = true
        try {
          const next = await game('GET', `/room/${asked}`)
          if (p.room !== asked) return
          p.view = next
          align()
          emit()
          void loadLyric()
        } catch (error) {
          if (p.room === asked && /没有这个房间/.test(error.message)) gone('房间关了')
          else if (p.room === asked && error.status === 401) gone(error.message)
        } finally {
          roomBusy = false
        }
      }

      async function beat() {
        if (!p.room) return
        try {
          const answer = await game('POST', '/beat', { room: p.room })
          if (answer && answer.here === false) gone('你已经不在这个房间了')
        } catch {
          // next beat
        }
      }

      function stopTimers() {
        for (const timer of timers) clearInterval(timer)
        timers = []
      }

      function startTimers() {
        stopTimers()
        timers = [
          setInterval(() => {
            if (p.room) {
              align()
              emit()
            }
          }, TICK_MS),
          setInterval(refresh, ROOM_MS),
          setInterval(loadChat, CHAT_MS),
          setInterval(beat, BEAT_MS),
          setInterval(syncClock, CLOCK_MS),
        ]
      }

      /** Start following a room the game already has the player in. */
      async function follow(view) {
        p.room = view.id
        p.view = view
        p.error = ''
        p.chat = []
        p.chatRoom = view.id
        startTimers()
        emit()
        await syncClock()
        void loadLyric()
        void loadChat()
        void beat()
      }

      async function act(work) {
        p.busy = true
        emit()
        try {
          return await work()
        } finally {
          p.busy = false
          emit()
        }
      }

      Object.assign(p, {
        audio,
        align, // for the tests
        position,
        serverNow,
        lyricLine() {
          const cur = p.view && p.view.current
          if (!cur || p.lyric.id !== cur.id) return ''
          const index = lyricAt(p.lyric.lines, position())
          return index >= 0 ? p.lyric.lines[index].text : ''
        },
        /** Inside a click: make one silent sound so the songs after may start on their own. */
        unlock() {
          if (!audio || audio.src) return
          if (!silence) silence = silenceUrl()
          audio.src = silence
          play()
        },
        /** Already joined (by /listen on the host): follow it. */
        async adopt(id) {
          if (p.room === id) return
          const view = await game('GET', `/room/${id}`)
          await follow(view)
        },
        async join(id) {
          p.unlock()
          return act(async () => follow(await game('POST', `/room/${id}/join`, {})))
        },
        async open(name) {
          p.unlock()
          return act(async () => follow(await game('POST', '/rooms', { name })))
        },
        async leave() {
          const was = p.room
          gone('')
          if (was) await game('POST', '/leave', {}).catch(() => {})
        },
        /** The browser blocked autoplay; the player clicked 继续收听. */
        resume() {
          p.blocked = false
          play()
          align()
          emit()
        },
        async say(text) {
          if (!p.room) return
          const line = await game('POST', `/room/${p.room}/chat`, { text })
          const merged = mergeLines(p.chat, [line])
          p.chat = merged.lines
          emit()
        },
        async pick(id, top) {
          if (!p.room) return null
          const out = await game('POST', `/room/${p.room}/queue`, { ids: [id], top: Boolean(top) })
          void refresh()
          void loadChat()
          return out
        },
        async control(what) {
          if (!p.room) return
          await game('POST', `/room/${p.room}/${what}`, {})
          void refresh()
          void loadChat()
        },
        async remove(item) {
          if (!p.room) return
          await game('DELETE', `/room/${p.room}/queue/${item}`)
          void refresh()
        },
        async top(item) {
          if (!p.room) return
          await game('POST', `/room/${p.room}/queue/${item}/top`, {})
          void refresh()
          void loadChat()
        },
        search(text, source) {
          return game('GET', `/search?q=${encodeURIComponent(text)}&type=song${source === 'qq' ? '&source=qq' : ''}`)
        },
        setVolume(value) {
          if (!audio) return
          audio.volume = Math.min(1, Math.max(0, Number(value) || 0))
          p.quiet = false
          applyVolume()
          try {
            localStorage.setItem(VOLUME_KEY, String(audio.volume))
          } catch {
            // keep it for this page only
          }
          emit()
        },
        toggleQuiet() {
          p.quiet = !p.quiet
          applyVolume()
          emit()
        },
        bossQuiet(on) {
          p.hushed = Boolean(on)
          applyVolume()
        },
        refresh,
        /** Stop for good: timers, the <audio>, the room (on the page only — the game still has the player in it). */
        dispose() {
          p.room = null
          p.view = null
          stopTimers()
          stopAudio()
        },
      })
      return p
    }

    // Which load of this bundle made the player. The player lives in a global
    // slot so the music survives switching Sessions; but when DSH swaps in a new
    // version of the plugin without reloading the page (patchReload: live), the
    // old version's player — old timers, old rules — would keep playing and the
    // new code would merely draw it. So a player from another load is retired
    // and a new one takes over the same room.
    const BUILD = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    /** Silence a player made by another load of this bundle; one from before 0.1.2 has no dispose(). */
    function retire(old) {
      try {
        if (typeof old.dispose === 'function') {
          old.dispose()
          return
        }
        // Its timers keep ticking, but every one of them does nothing without a room.
        old.room = null
        old.view = null
        if (old.audio) {
          old.audio.pause()
          old.audio.removeAttribute('src')
          old.audio.load()
        }
      } catch {
        // nothing more can be done for it
      }
    }

    function player() {
      const old = shared.player
      if (old && old.build === BUILD) return old
      const next = createPlayer()
      next.build = BUILD
      next.bossQuiet(shared.boss && shared.config.bossMute)
      shared.player = next
      if (old) {
        const room = old.room
        next.quiet = Boolean(old.quiet)
        retire(old)
        if (room) next.adopt(room).catch(() => {})
      }
      return next
    }

    /* ── styles ──────────────────────────────────────────────────────────── */

    const CSS = `
.dlCard{position:relative;margin:2px 0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,15px);line-height:1.75;border-radius:10px;border:1px solid transparent;outline:none;transition:border-color .18s ease}
.dlCard[data-state="room"]{display:flex;flex-direction:column;overflow:hidden;contain:layout paint;height:max(220px, min(560px, calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px) - 44px)))}
.dlCard[data-state="lobby"]{display:flex;flex-direction:column;overflow:hidden;max-height:max(220px, min(560px, calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px) - 44px)))}
.dlCard[data-state="lobby"] .dlStream{flex:0 1 auto}
.dlCard:hover{border-color:var(--dsw-alias-border-l1)}
.dlLine{position:absolute;left:10px;right:10px;top:0;height:2px;z-index:3;pointer-events:none;border-radius:2px;overflow:hidden}
.dlLine>i{display:block;height:100%;background:var(--dsw-alias-brand-primary);opacity:.45;transition:width 1s linear}
.dlHead{position:absolute;top:0;left:0;right:0;z-index:2;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:10px 10px 0 0;opacity:0;pointer-events:none;transform:translateY(-3px);transition:opacity .16s ease,transform .16s ease}
.dlCard:hover>.dlHead,.dlCard:focus-within>.dlHead{opacity:1;pointer-events:auto;transform:none}
@media (hover:none){.dlHead{opacity:1;pointer-events:auto;transform:none}}
.dlRoomName{flex:1;min-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:600}
.dlBtn{padding:1px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.6;cursor:pointer;white-space:nowrap}
.dlBtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dlBtn:disabled{opacity:.4;cursor:default}
.dlBtn[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dlVol{width:70px;accent-color:var(--dsw-alias-brand-primary)}
.dlNow{padding:12px 6px 4px;flex:none}
.dlSong{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.dlLyric{min-height:1.75em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dlStream{position:relative;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;padding:4px 6px;word-break:break-word;scrollbar-width:thin;scrollbar-color:transparent transparent}
.dlCard:hover .dlStream{scrollbar-color:var(--dsh-scrollbar-thumb,var(--dsw-alias-border-l2)) transparent}
.dlMsg{margin:0 0 .35em;white-space:pre-wrap}
.dlWho{color:var(--dsw-alias-label-secondary)}
.dlMsg[data-me="true"] .dlWho{color:var(--dsw-alias-brand-primary)}
.dlMsg[data-sys="true"]{color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.dlMsg[data-at="true"]{background:var(--dsw-alias-bg-multi-select,rgba(255,200,0,.18));border-radius:4px}
.dlRow{display:flex;align-items:center;gap:8px;padding:3px 4px;border-radius:7px;min-width:0}
.dlRow:hover{background:var(--dsw-alias-bg-layer-2)}
.dlRowMain{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlRowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.dlRow[data-off="true"] .dlRowMain{color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.dlSub{display:flex;align-items:center;gap:8px;padding:2px 4px 6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dlInput{flex:none;display:flex;gap:6px;padding:6px 4px 4px;border-top:1px solid transparent}
.dlCard:hover .dlInput,.dlCard:focus-within .dlInput{border-top-color:var(--dsw-alias-border-l1)}
.dlInput input,.dlField{flex:1;min-width:0;padding:5px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;outline:none}
.dlInput input:focus,.dlField{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.dlInput input:focus,.dlField:focus{border-color:var(--dsw-alias-brand-primary)}
.dlNote{color:var(--dsw-alias-label-secondary);padding:2px 6px;font-size:13px}
.dlError{color:var(--dsw-alias-state-error-primary,#e5484d);white-space:pre-wrap;padding:2px 6px;font-size:13px;line-height:1.7}
.dlFold{display:block;padding:0 6px;color:var(--dsw-alias-label-tertiary);letter-spacing:3px;line-height:1.6;user-select:none;cursor:default;outline:none;border-radius:6px}
.dlFold[data-closed="true"]{cursor:pointer;letter-spacing:normal;font-size:12.5px}
.dlForm{display:flex;flex-direction:column;gap:8px;padding:8px 6px;max-width:420px;font-size:13px}
.dlForm .dlField{border-color:var(--dsw-alias-border-l2)}
.dlSet{display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dlSetRow{display:grid;grid-template-columns:110px 1fr;gap:12px;align-items:center}
.dlSetRow>label{color:var(--dsw-alias-label-secondary)}
.dlSetCtl{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.dlSetCtl .dlField{border-color:var(--dsw-alias-border-l2)}
.dlSetCheck{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}
.dlSetCheck input{accent-color:var(--dsw-alias-brand-primary)}
.dlSetMsg{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dlSetMsg[data-error="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dlKeyBox{min-width:150px;padding:5px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}
.dlKeyBox[data-capturing="true"]{border-color:var(--dsw-alias-brand-primary);border-style:solid}
.dlMenuRow{display:flex;align-items:center;gap:10px;min-width:0;width:100%}
.dlMenuTitle{flex:1;min-width:0;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlMenuFallback{display:flex;width:100%;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.dlMenuFallback:hover,.dlMenuFallback:focus-visible{background:var(--dsw-alias-bg-layer-2);outline:none}
`

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const element = document.createElement('style')
      element.dataset.plugin = KIND
      element.textContent = CSS
      document.head.append(element)
      return () => element.remove()
    }

    /* ── small views ─────────────────────────────────────────────────────── */

    const btn = (label, onClick, extra) =>
      h('button', Object.assign({ type: 'button', className: 'dlBtn', onClick }, extra || {}), label)

    /** Sign in to the game: address, account, password. Only the session cookie is kept. */
    function LoginForm({ compact }) {
      useVersion()
      const status = shared.status || {}
      const [server, setServer] = React.useState(status.server || '')
      const [username, setUsername] = React.useState('')
      const [password, setPassword] = React.useState('')
      const [message, setMessage] = React.useState({ text: '', error: false })
      const [busy, setBusy] = React.useState(false)
      const typed = React.useRef(false)
      React.useEffect(() => {
        if (!typed.current && status.server) setServer(status.server)
      }, [status.server])

      async function submit() {
        setBusy(true)
        setMessage({ text: '正在登录…', error: false })
        try {
          const payload = await post('/login', { server, username, password })
          shared.status = { account: payload.account, server: payload.server }
          shared.config = payload.config
          setPassword('')
          setMessage({ text: `已登录：${payload.account.nickname || payload.account.username}`, error: false })
          emit()
        } catch (error) {
          setMessage({ text: error.message, error: true })
        } finally {
          setBusy(false)
        }
      }
      const onKey = (event) => {
        event.stopPropagation()
        if (event.key === 'Enter' && !event.nativeEvent?.isComposing) void submit()
      }
      return h(
        'div',
        { className: 'dlForm' },
        compact ? h('div', { className: 'dlNote' }, '登录工位股市的游戏账号（只在本机保存登录凭据，不保存密码）') : null,
        h('input', {
          className: 'dlField',
          value: server,
          spellCheck: false,
          placeholder: '游戏服务器，例如 http://10.0.0.8:30418',
          onChange: (event) => {
            typed.current = true
            setServer(event.target.value)
          },
          onKeyDown: onKey,
        }),
        h('input', { className: 'dlField', value: username, spellCheck: false, autoComplete: 'off', placeholder: '账号', onChange: (event) => setUsername(event.target.value), onKeyDown: onKey }),
        h('input', { className: 'dlField', type: 'password', value: password, autoComplete: 'off', placeholder: '密码', onChange: (event) => setPassword(event.target.value), onKeyDown: onKey }),
        h('div', null, btn(busy ? '登录中…' : '登录', () => void submit(), { disabled: busy || !server || !username || !password })),
        message.text ? h('div', { className: 'dlSetMsg', 'data-error': message.error ? 'true' : 'false' }, message.text) : null,
      )
    }

    /** No room yet: the rooms that are open, and opening one. */
    function Lobby({ hint }) {
      const p = player()
      useVersion()
      const [listing, setListing] = React.useState(null)
      const [failure, setFailure] = React.useState('')
      const [name, setName] = React.useState('')
      const load = React.useCallback(() => {
        game('GET', '/rooms').then(
          (answer) => {
            setListing(answer)
            setFailure('')
          },
          (error) => setFailure(error.message),
        )
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 10_000)
        return () => clearInterval(timer)
      }, [load])

      const enter = (id) => p.join(id).catch((error) => setFailure(error.message))
      const rooms = (listing && listing.rooms) || []
      const mine = listing && listing.mine
      return h(
        'div',
        { className: 'dlCard', 'data-state': 'lobby' },
        h(
          'div',
          { className: 'dlStream', style: { paddingTop: '10px' } },
          p.error ? h('div', { className: 'dlNote' }, p.error) : null,
          hint ? h('div', { className: 'dlNote' }, hint) : null,
          failure ? h('div', { className: 'dlError' }, failure) : null,
          !listing && !failure ? h('div', { className: 'dlNote' }, '正在读取房间…') : null,
          listing && listing.available === false ? h('div', { className: 'dlNote' }, '管理员还没有开放音乐源') : null,
          listing && !rooms.length ? h('div', { className: 'dlNote' }, '现在没有开着的房间，在下面开一个吧') : null,
          rooms.map((room) =>
            h(
              'div',
              { key: room.id, className: 'dlRow' },
              h('span', { className: 'dlRowMain' }, `${room.name}`, h('span', { className: 'dlRowMeta' }, `  ${room.owner} · ${room.listeners} 人${room.playing ? ` · 在放《${room.playing}》` : ''}`)),
              btn(room.id === mine ? '继续听' : '进去', () => void enter(room.id), { disabled: p.busy }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dlInput' },
          h('input', {
            value: name,
            maxLength: 20,
            placeholder: '开一个房间：输入房间名，回车',
            onChange: (event) => setName(event.target.value),
            onKeyDown: (event) => {
              event.stopPropagation()
              if (event.key !== 'Enter' || event.nativeEvent?.isComposing || !name.trim()) return
              p.open(name.trim()).then(
                () => setName(''),
                (error) => setFailure(error.message),
              )
            },
          }),
        ),
      )
    }

    function ChatLine({ line, me }) {
      const sys = line.kind !== 'say'
      const text = plainText(line.text)
      const atMe = !sys && line.user !== me && Array.isArray(line.mentions) && line.mentions.some((m) => m && m.user === me)
      if (sys) return h('p', { className: 'dlMsg', 'data-sys': 'true' }, text)
      return h(
        'p',
        { className: 'dlMsg', 'data-me': line.user === me ? 'true' : undefined, 'data-at': atMe ? 'true' : undefined },
        h('span', { className: 'dlWho' }, `${line.nickname || line.user || '?'}${line.bot ? '（AI）' : ''}：`),
        line.ref && line.ref.text ? h('span', { className: 'dlRowMeta' }, `「${plainText(line.ref.text).slice(0, 30)}」 `) : null,
        text,
      )
    }

    function SearchPanel({ search, setSearch, say }) {
      const p = player()
      const quota = p.view && p.view.quota
      const songs = (search.result && search.result.songs) || []
      const sources = (p.view && p.view.sources) || []
      const qqOpen = Array.isArray(sources) ? sources.some((s) => s && s.id === 'qq' && s.available !== false) : false
      const run = (source) => {
        setSearch(Object.assign({}, search, { source, loading: true, error: '' }))
        p.search(search.text, source).then(
          (result) => setSearch((cur) => (cur && cur.text === search.text ? Object.assign({}, cur, { source, loading: false, result }) : cur)),
          (error) => setSearch((cur) => (cur ? Object.assign({}, cur, { loading: false, error: error.message }) : cur)),
        )
      }
      const pick = (song, top) =>
        p.pick(song.id, top).then(
          (out) => {
            const skipped = out && out.skipped && out.skipped.length ? `（放不了：${out.skipped.join('、')}）` : ''
            say(out && out.added ? `点了《${song.name}》${top ? '，下一首放' : ''}${skipped}` : `没点上${skipped}`)
          },
          (error) => say(error.message, true),
        )
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dlSub' },
          h('span', { className: 'dlRowMain' }, `搜「${search.text}」${quota ? ` · 你已点 ${quota.mine}/${quota.per}` : ''}`),
          btn('网易云', () => run('netease'), { 'data-on': search.source !== 'qq' ? 'true' : 'false' }),
          qqOpen || search.source === 'qq' ? btn('QQ 音乐', () => run('qq'), { 'data-on': search.source === 'qq' ? 'true' : 'false' }) : null,
          btn('关闭', () => setSearch(null)),
        ),
        search.loading ? h('div', { className: 'dlNote' }, '正在搜…') : null,
        search.error ? h('div', { className: 'dlError' }, search.error) : null,
        !search.loading && search.result && !songs.length ? h('div', { className: 'dlNote' }, '没搜到') : null,
        songs.map((song) =>
          h(
            'div',
            { key: String(song.id), className: 'dlRow', 'data-off': song.playable === false ? 'true' : undefined },
            h('span', { className: 'dlRowMain', title: `${song.name} — ${artistsOf(song)}` }, `${song.name} — ${artistsOf(song)}`),
            h('span', { className: 'dlRowMeta' }, song.durationMs ? clock(song.durationMs / 1000) : ''),
            song.playable === false ? h('span', { className: 'dlRowMeta' }, '放不了') : btn('点歌', () => void pick(song, false)),
            song.playable === false ? null : btn('下一首', () => void pick(song, true)),
          ),
        ),
      )
    }

    function QueuePanel({ close, say }) {
      const p = player()
      const view = p.view || {}
      const queue = view.queue || []
      const fail = (error) => say(error.message, true)
      return h(
        React.Fragment,
        null,
        h('div', { className: 'dlSub' }, h('span', { className: 'dlRowMain' }, queue.length ? `接下来 ${queue.length} 首` : '队列是空的：/点 歌名 来点一首'), btn('关闭', close)),
        queue.map((song, index) =>
          h(
            'div',
            { key: song.item, className: 'dlRow' },
            h('span', { className: 'dlRowMeta' }, String(index + 1).padStart(2, ' ')),
            h('span', { className: 'dlRowMain', title: `${song.name} — ${artistsOf(song)}` }, `${song.name} — ${artistsOf(song)}`),
            h('span', { className: 'dlRowMeta' }, song.by || ''),
            index > 0 ? btn('置顶', () => void p.top(song.item).catch(fail)) : null,
            song.mine || view.canControl ? btn('删', () => void p.remove(song.item).catch(fail)) : null,
          ),
        ),
      )
    }

    /** In a room: what is playing, the lyric line, the chat, and a line to type in. */
    function RoomView({ onClose }) {
      const p = player()
      useVersion()
      const view = p.view || {}
      const cur = view.current
      const me = (shared.status && shared.status.account && shared.status.account.username) || ''
      const [text, setText] = React.useState('')
      const [panel, setPanel] = React.useState(null) // null | 'queue'
      const [search, setSearch] = React.useState(null)
      const [notice, setNotice] = React.useState({ text: '', error: false })
      const stream = React.useRef(null)
      const pinned = React.useRef(true)
      const noticeTimer = React.useRef(null)

      const say = (message, error) => {
        setNotice({ text: message, error: Boolean(error) })
        clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice({ text: '', error: false }), 6000)
      }
      React.useEffect(() => () => clearTimeout(noticeTimer.current), [])

      // Keep the chat at its newest line unless the reader scrolled up.
      const lastId = p.chat.length ? p.chat[p.chat.length - 1].id : 0
      React.useLayoutEffect(() => {
        const box = stream.current
        if (box && pinned.current && !panel && !search) box.scrollTop = box.scrollHeight
      }, [lastId, panel, search])
      const onScroll = () => {
        const box = stream.current
        if (box) pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
      }

      const fail = (error) => say(error.message, true)
      const open = (view.sources || []).filter((s) => s && s.available !== false).map((s) => s.id)
      const firstSource = open.length && !open.includes('netease') ? open[0] : 'netease'
      function submit() {
        const parsed = parseInput(text)
        switch (parsed.kind) {
          case 'none':
            return
          case 'say':
            p.say(parsed.text).then(() => {
              pinned.current = true
              setText('')
            }, fail)
            return
          case 'search':
            if (!parsed.text) return say('/点 后面写歌名或歌手')
            setText('')
            setPanel(null)
            setSearch({ text: parsed.text, source: firstSource, loading: true, result: null, error: '' })
            p.search(parsed.text, firstSource).then(
              (result) => setSearch((s) => (s && s.text === parsed.text ? Object.assign({}, s, { loading: false, result }) : s)),
              (error) => setSearch((s) => (s ? Object.assign({}, s, { loading: false, error: error.message }) : s)),
            )
            return
          case 'skip':
          case 'pause':
          case 'resume':
            setText('')
            p.control(parsed.kind).catch(fail)
            return
          case 'queue':
            setText('')
            setSearch(null)
            setPanel('queue')
            return
          case 'leave':
            setText('')
            void p.leave()
            return
          case 'mute':
            setText('')
            p.toggleQuiet()
            return
        }
      }

      const pos = p.position()
      const duration = cur && cur.durationMs ? cur.durationMs / 1000 : 0
      const pct = duration ? Math.min(100, (pos / duration) * 100) : 0
      const paused = Boolean(cur && cur.pausedAt !== null && cur.pausedAt !== undefined)
      const loading = Boolean(cur && (cur.loading || cur.startAt === null))
      const members = (view.members || []).length
      const queued = (view.queue || []).length
      const songLine = cur
        ? `♪ ${cur.name} — ${artistsOf(cur)}${cur.by ? ` · ${cur.by} 点的` : ''}  ${loading ? '加载中…' : `${clock(pos)} / ${clock(duration)}`}${paused ? ' · 暂停中' : ''}`
        : queued
          ? '正在准备下一首…'
          : '现在没在放歌：/点 歌名 来点一首'
      const audio = p.audio

      let body
      if (search) body = h(SearchPanel, { search, setSearch, say })
      else if (panel === 'queue') body = h(QueuePanel, { close: () => setPanel(null), say })
      else body = p.chat.map((line) => h(ChatLine, { key: line.id, line, me }))

      return h(
        'div',
        { className: 'dlCard', 'data-state': 'room', onClick: () => p.unlock() },
        h('div', { className: 'dlLine', 'aria-hidden': 'true' }, h('i', { style: { width: `${pct.toFixed(2)}%` } })),
        h(
          'div',
          { className: 'dlHead' },
          h('span', { className: 'dlRoomName', title: view.name }, `${view.name || ''} · ${members} 人`),
          btn(`队列 ${queued}`, () => {
            setSearch(null)
            setPanel(panel === 'queue' ? null : 'queue')
          }, { 'data-on': panel === 'queue' ? 'true' : 'false' }),
          view.canControl && cur ? btn(paused ? '继续' : '暂停', () => void p.control(paused ? 'resume' : 'pause').catch(fail)) : null,
          cur ? btn('切歌', () => void p.control('skip').catch(fail)) : null,
          btn(p.quiet ? '取消静音' : '静音', () => p.toggleQuiet(), { 'data-on': p.quiet ? 'true' : 'false' }),
          audio
            ? h('input', {
                type: 'range',
                className: 'dlVol',
                min: '0',
                max: '1',
                step: '0.05',
                value: String(audio.volume),
                title: `音量 ${Math.round(audio.volume * 100)}%`,
                onChange: (event) => p.setVolume(event.target.value),
              })
            : null,
          btn('离开', () => void p.leave()),
          btn('合上', onClose, { title: '合上卡片（音乐继续）' }),
        ),
        h(
          'div',
          { className: 'dlNow' },
          h('div', { className: 'dlSong', title: songLine }, songLine),
          h('div', { className: 'dlLyric' }, p.lyricLine() || (cur ? '' : ' ')),
          p.blocked ? h('div', null, btn('▶ 点一下开始收听', () => p.resume())) : null,
        ),
        h('div', { className: 'dlStream', ref: stream, onScroll }, body),
        notice.text ? h('div', { className: notice.error ? 'dlError' : 'dlNote' }, notice.text) : null,
        h(
          'div',
          { className: 'dlInput' },
          h('input', {
            value: text,
            maxLength: 400,
            placeholder: '说点什么…  /点 歌名  /切  /队列',
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              // The composer's own shortcuts must not see keys typed here.
              event.stopPropagation()
              if (event.nativeEvent?.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              } else if (event.key === 'Escape') {
                if (search || panel) {
                  setSearch(null)
                  setPanel(null)
                } else event.target.blur()
              }
            },
          }),
        ),
      )
    }

    /* ── the card ────────────────────────────────────────────────────────── */

    function closedKey(nodeKey) {
      return `dsh-desk-listen:closed:${nodeKey}`
    }

    /**
     * One card per `/listen`. Every card is a view of the one player; only the
     * newest card on screen is live, the others fold to a line.
     */
    function ListenCard({ node }) {
      const data = (node && node.data) || {}
      const nodeKey = node && node.key !== undefined ? String(node.key) : ''
      const summary = data.summary || null
      useVersion()
      const p = player()
      const [closed, setClosed] = React.useState(() => readFlag(closedKey(nodeKey)))
      const [failure, setFailure] = React.useState('')
      const at = summary ? Number(summary.at) || 0 : 0

      // Register while mounted, so the boss key and "which card is live" know about it.
      React.useEffect(() => {
        if (data.status !== 'ready') return undefined
        shared.cards.set(nodeKey, at)
        emit()
        return () => {
          shared.cards.delete(nodeKey)
          emit()
        }
      }, [nodeKey, at, data.status])

      React.useEffect(() => {
        if (!shared.status) void refreshStatus().catch(() => {})
      }, [])

      // A /listen that just ran and joined a room: follow it.
      const fresh = at > 0 && Date.now() - at < FRESH_MS
      React.useEffect(() => {
        if (data.status !== 'ready' || !summary || !summary.joined || !summary.room || !fresh) return
        if (p.room === summary.room) return
        p.adopt(summary.room).catch((error) => setFailure(error.message))
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [data.status, summary && summary.room, fresh])

      if (data.status === 'pending') return h('span', { className: 'dlFold' }, '···')
      if (data.status === 'error') return h('div', { className: 'dlError' }, data.error || '/listen 没有成功')
      if (data.status !== 'ready') return null
      if (shared.boss) return h('span', { className: 'dlFold', 'aria-hidden': 'true' }, '···')

      const setClosedFlag = (value) => {
        writeFlag(closedKey(nodeKey), value)
        setClosed(value)
      }
      if (closed) {
        const label = p.room && p.view ? `··· 一起听 · ${p.view.name}（已合上，点一下打开）` : '··· 一起听（已合上，点一下打开）'
        return h('span', { className: 'dlFold', 'data-closed': 'true', role: 'button', tabIndex: 0, onClick: () => setClosedFlag(false), onKeyDown: (e) => e.key === 'Enter' && setClosedFlag(false) }, label)
      }
      if (shared.cards.size > 1 && liveCard(shared.cards) !== nodeKey) {
        return h('span', { className: 'dlFold', 'data-closed': 'true' }, '··· 一起听（在下面更新的卡片里）')
      }
      if (!shared.status) return h('span', { className: 'dlFold' }, '···')
      if (!shared.status.account) return h('div', { className: 'dlCard' }, h(LoginForm, { compact: true }))
      if (failure && !p.room) return h('div', { className: 'dlError' }, failure)
      if (!p.room) {
        const hint = summary && summary.room && !fresh ? `上次在「${summary.name}」` : ''
        return h(Lobby, { hint })
      }
      return h(RoomView, { onClose: () => setClosedFlag(true) })
    }

    /** The generic command row would show `/listen` and its JSON result; the card replaces it. */
    function HiddenCommandRow() {
      return null
    }

    /* ── the chat node definition ────────────────────────────────────────── */

    const listenDefinition = {
      kind: KIND,
      target: 'chat',
      match(event) {
        if (!event || !event.data) return null
        if (event.type === 'command/run' && event.data.name === COMMAND) return { id: String(event.data.commandId), role: 'start' }
        if (event.type === 'command/done') return { id: String(event.data.commandId), role: 'update' }
        return null
      },
      start(context, match) {
        const event = match && match.event ? match.event : {}
        return { status: 'pending', summary: null, error: '', time: event.time === undefined ? null : event.time }
      },
      update(context, match) {
        const data = match.event.data || {}
        const time = context.state ? context.state.time : null
        if (data.kind !== 'success') return { status: 'error', summary: null, error: String(data.text || '命令没有成功'), time }
        try {
          const parsed = JSON.parse(String(data.text))
          if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
          return {
            status: 'ready',
            summary: {
              room: Number.isSafeInteger(parsed.room) ? parsed.room : null,
              name: String(parsed.name || ''),
              joined: parsed.joined === true,
              at: Number(parsed.at) || 0,
            },
            error: '',
            time,
          }
        } catch {
          return { status: 'error', summary: null, error: '无法解析 /listen 的返回值', time }
        }
      },
      buildViewNode(context) {
        if (context.start === undefined || !context.state) return null
        const state = context.state
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: context.start.event.seq,
          location: context.start.location,
          visibility: 'visible',
          data: { status: state.status, summary: state.summary, error: state.error, time: state.time },
        }
      },
    }

    /* ── settings section ────────────────────────────────────────────────── */

    function Settings() {
      useVersion()
      const config = shared.config
      const account = shared.status && shared.status.account
      const [title, setTitle] = React.useState(config.sessionTitle || '')
      const typedTitle = React.useRef(false)
      const [message, setMessage] = React.useState({ text: '', error: false })
      const [capturing, setCapturing] = React.useState(false)
      const say = (text, error) => setMessage({ text: text || '', error: Boolean(error) })

      React.useEffect(() => {
        refreshStatus()
          .then(() => {
            if (!typedTitle.current) setTitle(shared.config.sessionTitle || '')
          })
          .catch((error) => say(error.message, true))
      }, [])

      async function persist(patch, okText) {
        try {
          await saveConfig(patch)
          say(okText || '已保存', false)
        } catch (error) {
          say(error.message, true)
        }
      }

      React.useEffect(() => {
        if (!capturing) return undefined
        shared.capturing = true
        const onKey = (event) => {
          if (event.isComposing || event.keyCode === 229) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            setCapturing(false)
            say('已取消', false)
            return
          }
          if (isModifierCode(event.code)) return
          const chord = chordOf(event)
          setCapturing(false)
          void persist({ bossKey: chord }, `老板键已设为 ${chordLabel(chord)}`)
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          shared.capturing = false
          window.removeEventListener('keydown', onKey, true)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [capturing])

      const row = (label, control) => h('div', { className: 'dlSetRow' }, h('label', null, label), h('div', { className: 'dlSetCtl' }, control))
      const p = player()

      return h(
        'div',
        { className: 'dlSet' },
        row(
          '游戏账号',
          account
            ? h(
                React.Fragment,
                null,
                h('span', null, `${account.nickname || account.username}（${account.username}）· ${account.server}`),
                btn('退出登录', async () => {
                  try {
                    await p.leave()
                    const payload = await post('/logout', {})
                    shared.status = { account: payload.account, server: payload.server }
                    emit()
                    say('已退出登录', false)
                  } catch (error) {
                    say(error.message, true)
                  }
                }),
              )
            : h(LoginForm, { compact: false }),
        ),
        row(
          '音量',
          p.audio
            ? h(
                React.Fragment,
                null,
                h('input', { type: 'range', className: 'dlVol', style: { width: '160px' }, min: '0', max: '1', step: '0.05', value: String(p.audio.volume), onChange: (event) => p.setVolume(event.target.value) }),
                h('span', { className: 'dlSetMsg' }, `${Math.round(p.audio.volume * 100)}%`),
              )
            : h('span', { className: 'dlSetMsg' }, '这个环境不能放声音'),
        ),
        row(
          '老板键',
          h(
            React.Fragment,
            null,
            h(
              'button',
              {
                type: 'button',
                className: 'dlKeyBox',
                'data-capturing': capturing ? 'true' : 'false',
                onClick: () => {
                  say('请按下新的组合键（需含 Ctrl / Alt / Meta 之一），Esc 取消', false)
                  setCapturing(true)
                },
              },
              capturing ? '请按组合键…' : chordLabel(config.bossKey),
            ),
            h('span', { className: 'dlSetMsg' }, '按一次所有卡片折叠为 ···（内容从页面移除），再按恢复'),
          ),
        ),
        row(
          '老板键静音',
          h(
            'label',
            { className: 'dlSetCheck' },
            h('input', { type: 'checkbox', checked: config.bossMute === true, onChange: (event) => void persist({ bossMute: event.target.checked }) }),
            h('span', { className: 'dlSetMsg' }, '按老板键时音乐也静音，再按恢复'),
          ),
        ),
        row(
          '常驻侧边栏',
          h(
            'label',
            { className: 'dlSetCheck' },
            h('input', { type: 'checkbox', checked: config.keepSession !== false, onChange: (event) => void persist({ keepSession: event.target.checked }) }),
            h('span', { className: 'dlSetMsg' }, '在新会话里 /listen 后，让这个会话留在侧边栏（不调用模型，不消耗 token）'),
          ),
        ),
        row(
          '会话标题',
          h(
            React.Fragment,
            null,
            h('input', {
              className: 'dlField',
              value: title,
              maxLength: 40,
              spellCheck: false,
              placeholder: '留空则叫「随手记」，可以改成「整理周报」之类',
              disabled: config.keepSession === false,
              onChange: (event) => {
                typedTitle.current = true
                setTitle(event.target.value)
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') void persist({ sessionTitle: title })
              },
            }),
            btn('保存', () => void persist({ sessionTitle: title }), { disabled: config.keepSession === false }),
          ),
        ),
        message.text ? h('div', { className: 'dlSetMsg', 'data-error': message.error ? 'true' : 'false' }, message.text) : null,
        h(
          'div',
          { className: 'dlSetMsg' },
          '在会话里输入 /listen 打开一起听；/listen 房间号 或 /listen 房间名 直接进房间。卡片里：直接打字是聊天，/点 歌名 搜歌点歌，/切 切歌，/队列 看队列。',
        ),
      )
    }

    /* ── sidebar: back to a listening Session ───────────────────────────── */

    let primitives
    function menuPrimitives() {
      if (primitives === undefined) {
        try {
          primitives = require('@deepseek-ai/dsh-client-ui-primitives') || null
        } catch {
          primitives = null
        }
      }
      return primitives
    }

    function snapshotOf(service) {
      try {
        return service?.list?.getSnapshot?.()
      } catch {
        return undefined
      }
    }

    function listeningRows(entries, sessions, workspaces) {
      const list = Array.isArray(entries) ? entries : []
      if (!sessions || !sessions.byId) return list.map((entry) => Object.assign({}, entry, { current: false }))
      const archived = new Set(workspaces?.archivedSessionIds ?? [])
      return list
        .filter((entry) => sessions.byId[entry.sessionId] !== undefined && !archived.has(entry.sessionId))
        .map((entry) => Object.assign({}, entry, { current: (sessions.byId[entry.sessionId]?.retainedBy?.mainView ?? 0) > 0 }))
    }

    async function openListening(ctx, sessionId) {
      const navigation = ctx.get('uiWorkspace')
      if (!navigation || typeof navigation.openSession !== 'function') return
      const sessions = snapshotOf(ctx.get('sessions') ?? navigation.sessions)
      const workspaces = snapshotOf(ctx.get('workspaces') ?? navigation.workspaces)
      const summary = sessions?.byId?.[sessionId]
      const workspace = workspaces?.items?.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
      if (summary?.blank && workspace && summary.cwd === workspace.path && typeof navigation.restoreBlank === 'function') {
        try {
          await navigation.restoreBlank(workspace.workspaceId, sessionId)
        } catch (error) {
          console.warn('dsh-desk-listen: restoring the session failed:', error)
        }
      }
      navigation.openSession(sessionId)
    }

    function ContinueMenu({ onDismiss, openSession, listRows }) {
      useVersion()
      const [rows, setRows] = React.useState(() => listRows(shared.sessions))
      React.useEffect(() => {
        let live = true
        call('/sessions').then(
          (payload) => {
            shared.sessions = payload.sessions
            if (live) setRows(listRows(payload.sessions))
          },
          () => {},
        )
        return () => {
          live = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
      if (shared.boss || rows.length === 0) return null
      const row = rows[0]
      const ui = menuPrimitives()
      const p = shared.player
      const label = p && p.room && p.view ? `继续听 · ${p.view.name}` : `继续听${row.name ? ` · ${row.name}` : ''}`
      const content = h('span', { className: 'dlMenuRow' }, h('span', { className: 'dlMenuTitle' }, label))
      const select = () => {
        if (typeof onDismiss === 'function') onDismiss()
        if (!row.current) void openSession(row.sessionId)
      }
      if (ui && ui.MenuItemButton) return h(ui.MenuItemButton, { current: row.current, onSelect: select }, content)
      return h('button', { type: 'button', role: 'menuitem', className: 'dlMenuFallback', onClick: select }, content)
    }

    /* ── plugin ──────────────────────────────────────────────────────────── */

    const name = KIND
    const inject = ['slots', 'uiConversation']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-desk-listen: styles')

      // Take over from a player an older version of this plugin left on the page.
      ctx.effect(() => {
        if (shared.player && shared.player.build !== BUILD) player()
        return () => {}
      }, 'dsh-desk-listen: player')

      ctx.effect(() => {
        refreshStatus().catch(() => {})
        return () => {}
      }, 'dsh-desk-listen: status')

      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
        window.addEventListener('keydown', onBossKey, true)
        return () => window.removeEventListener('keydown', onBossKey, true)
      }, 'dsh-desk-listen: boss key')

      ctx.effect(() => ctx.uiConversation.events.register(listenDefinition), 'dsh-desk-listen: chat node')

      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: KIND }, ListenCard))
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: COMMAND }, HiddenCommandRow),
      )
      ctx.slots.inject('sidebar.panellist.actions', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist.actions',
            id: KIND,
            order: -9,
            inject: () => ({
              openSession: (sessionId) => openListening(ctx, sessionId),
              listRows: (entries) => listeningRows(entries, snapshotOf(ctx.get('sessions')), snapshotOf(ctx.get('workspaces'))),
            }),
          },
          ContinueMenu,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register({ name: 'settings.section', id: KIND, order: 23, label: '一起听' }, Settings),
      )
    }

    // Extra keys are for the test suite; the loader reads name / inject / apply.
    module.exports = {
      name,
      inject,
      apply,
      listenDefinition,
      clock,
      parseLrc,
      lyricAt,
      plainText,
      mergeLines,
      parseInput,
      liveCard,
      syncStep,
      nextLead,
      chordOf,
      chordLabel,
      onBossKey,
      shared,
      setBoss,
      listeningRows,
      createPlayer,
      player,
    }
    return module.exports
  },
})
