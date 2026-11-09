// lib/session.mjs — keep a listening Session in the sidebar (same as dsh-chat-reader).
//
// DSH lists a Session as "blank" until its log holds a `turn/start`, and the
// sidebar shows a blank Session only while it is the selected one; New Session
// also reuses the first blank Session of a workspace. `/listen` logs only the
// log-only `command/run` + `command/done` pair, so a card opened in a fresh
// New Session vanished from the sidebar as soon as you switched away.
//
// The fix lets the agent loop run one *empty* turn, through its own driver so
// the loop keeps its turn counter: wake the idle loop with nothing queued, and
// reject that turn's first `agent/pre-step`. The loop then closes the turn
// (reason `blocked`) before any step — no request, no model call, no message,
// zero tokens — and the Session is no longer blank. The Session also
// gets a plain title (随手记 unless configured otherwise).
//
// Why reject rather than "enter with no messages": other pre-step listeners wrap
// the chain and append their own context (time, runtime context) after `next()`
// returns, so an empty `enter` still reaches the model. Every built-in listener
// passes a `reject` through untouched.
//
// Every field read here is checked first; on a host shaped differently the
// Session is simply left as it was.

const sealing = new WeakSet()

/** Whether this agent's Session has never run a turn and the agent is idle with nothing queued. */
export function isBlankIdle(agent) {
  try {
    const phase = agent?.phase
    if (!phase || phase.kind !== 'idle' || phase.lastTurn !== 0) return false
    if (typeof agent.wakeDriver !== 'function') return false
    if (agent.inbox?.hasPending) return false
    const boundary = agent.loopCtx?.sessionProjections?.stateOf?.(agent.session, 'turnBoundary')
    if (boundary && (boundary.lastTurn !== 0 || boundary.openTurnStartSeq !== null)) return false
    return true
  } catch {
    return false
  }
}

/**
 * Run one empty turn for a blank, idle agent.
 * @returns whether a turn was started
 */
export function sealBlankSession(agent) {
  if (!isBlankIdle(agent)) return false
  sealing.add(agent)
  try {
    agent.wakeDriver()
  } catch {
    sealing.delete(agent)
    return false
  }
  return true
}

/**
 * `agent/pre-step` listener. Only the first step of a turn this module started,
 * with nothing claimed, is rejected; everything else — including a real prompt
 * that raced in — passes through.
 */
export function onPreStep(payload, next) {
  const agent = payload?.agent
  if (agent && sealing.has(agent)) {
    sealing.delete(agent)
    if (payload.step === 1 && Array.isArray(payload.messages) && payload.messages.length === 0) {
      return Promise.resolve({ kind: 'reject' })
    }
  }
  return next()
}

/** Name the Session unless it already has a title. Failures are ignored. */
export function nameSession(titles, session, title) {
  try {
    const text = String(title ?? '').trim()
    if (!titles || !session || !text || typeof titles.rename !== 'function') return false
    if (typeof titles.get === 'function' && titles.get(session)?.title) return false
    titles.rename(session, text)
    return true
  } catch {
    return false
  }
}
