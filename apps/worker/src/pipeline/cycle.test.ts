import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { kstDateString } from '../core/budget.js'
import { createCircuit, ALERT_THRESHOLD } from '../core/circuit.js'
import { createSeenSet } from '../core/seen.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import type { Summarizer } from '../ports/summarizer.js'
import type { Heartbeat } from './health.js'
import { runCycle, runLoop, createSleeper, type CycleLogger, type CycleState, type Sleeper } from './cycle.js'

const NOW = new Date('2026-09-19T06:30:00Z')
const TODAY = kstDateString(NOW)

function silentLog(): CycleLogger {
  return { info: vi.fn(), error: vi.fn() }
}

/** 이미 한 사이클을 돈 정상 가동 상태. 콜드 스타트 억제는 ingest.test.ts 가 다룬다. */
function warmState(heartbeatFailures = 0): CycleState {
  return {
    lastDigestDate: TODAY,
    digestAttempt: null,
    heartbeatFailures,
    seen: createSeenSet(['20260919000100']),
    coldStart: false,
  }
}

function failingStore(): EventStore {
  return {
    incrementApiUsage: async () => {
      throw new Error('db unreachable')
    },
  } as unknown as EventStore
}

function healthyStore(): EventStore {
  return {
    incrementApiUsage: async () => 1,
    claimPending: async () => [],
  } as unknown as EventStore
}

const source: EventSource = { id: 'dart', fetchLatest: async () => [] }
const summarizer: Summarizer = { summarize: async () => null }

describe('runCycle — heartbeat 은 finally 에 있어야 한다 (회귀 테스트)', () => {
  it('사이클이 실패해도 heartbeat.ping 을 호출한다', async () => {
    // 이 테스트는 heartbeat 호출이 try 블록 성공 경로에만 있다면(fix round 1
    // 이전 상태로 되돌아가면) 실패한다 — store.incrementApiUsage 가 즉시 던지므로
    // try 안에서는 ping 에 도달할 방법이 없다. finally 에 있을 때만 통과한다.
    const ping = vi.fn(async () => true)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    const result = await runCycle(
      { source, store: failingStore(), notifier, operatorNotifier: notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      warmState(),
      NOW,
    )

    expect(ping).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalled() // 실패 분기를 실제로 탔는지 확인
    expect(result.heartbeatFailures).toBe(0) // ping 은 성공했으므로 리셋된 채 유지
  })

  it('사이클이 성공해도 heartbeat.ping 을 호출한다', async () => {
    const ping = vi.fn(async () => true)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    const result = await runCycle(
      { source, store: healthyStore(), notifier, operatorNotifier: notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      warmState(),
      NOW,
    )

    expect(ping).toHaveBeenCalledTimes(1)
    expect(result.heartbeatFailures).toBe(0)
  })

  it('사이클 실패 중 heartbeat 도 실패하면 heartbeatFailures 를 누적한다', async () => {
    const ping = vi.fn(async () => false)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    const result = await runCycle(
      { source, store: failingStore(), notifier, operatorNotifier: notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      warmState(2),
      NOW,
    )

    expect(ping).toHaveBeenCalledTimes(1)
    expect(result.heartbeatFailures).toBe(3) // 2에서 이어서 누적, 리셋되지 않는다
  })
})

describe('createSleeper — SIGTERM 이 대기 중에 와도 즉시 깨어난다', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('wakeNow 를 호출하면 전체 대기시간을 기다리지 않고 즉시 resolve 된다', async () => {
    const sleeper = createSleeper()
    const promise = sleeper.sleep(60_000)
    let resolved = false
    void promise.then(() => { resolved = true })

    sleeper.wakeNow()
    await promise // resolve 는 wakeNow 안에서 동기적으로 트리거되므로 타이머를 진행시킬 필요가 없다

    expect(resolved).toBe(true)
  })

  it('wakeNow 는 남은 타이머를 정리해 흘리지 않는다', () => {
    const sleeper = createSleeper()
    void sleeper.sleep(60_000)
    expect(vi.getTimerCount()).toBe(1)

    sleeper.wakeNow()
    expect(vi.getTimerCount()).toBe(0) // clearTimeout 이 실제로 호출되었는지 확인
  })

  it('wakeNow 없이 시간이 다 지나면 정상적으로 resolve 된다', async () => {
    const sleeper = createSleeper()
    const promise = sleeper.sleep(1_000)
    vi.advanceTimersByTime(1_000)
    await expect(promise).resolves.toBeUndefined()
  })

  it('대기 중이 아닐 때 wakeNow 를 호출해도 안전하다 — 신호가 사이클 실행 중에 온 경우', () => {
    const sleeper = createSleeper()
    expect(() => sleeper.wakeNow()).not.toThrow()
  })
})

describe('runLoop — 종료 신호가 대기 중에 오면 다음 사이클 없이 빠져나간다', () => {
  it('sleep 도중 shouldStop 이 참이 되면 사이클을 한 번만 돌리고 끝난다', async () => {
    // shouldStop 재확인이 빠지면 이 테스트는 통과/실패로 끝나지 않고 무한히
    // 돈다 — digest 무한루프 회귀 테스트와 같은 이유로 짧은 타임아웃을 건다.
    const incrementApiUsage = vi.fn(async () => 1)
    const store = {
      incrementApiUsage,
      claimPending: async () => [],
    } as unknown as EventStore
    const ping = vi.fn(async () => true)
    const heartbeat: Heartbeat = { ping }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    let shuttingDown = false
    // 실제 타이머 기반 sleeper 대신, "sleep 도중 신호가 온다"는 상황을 결정적으로
    // 재현하는 가짜 sleeper 를 준다 — 실제로는 wakeNow() 가 이 역할을 한다.
    const fakeSleeper: Sleeper = {
      sleep: async () => { shuttingDown = true },
      wakeNow: () => {},
    }

    await runLoop(
      { source, store, notifier, operatorNotifier: notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      warmState(),
      fakeSleeper,
      { shouldStop: () => shuttingDown },
    )

    // sleep 이 끝난 뒤 루프 상단에서 shouldStop() 을 다시 확인해 두 번째
    // 사이클을 시작하지 않아야 한다 — incrementApiUsage 는 사이클당 정확히 한 번 불린다.
    expect(incrementApiUsage).toHaveBeenCalledTimes(1)
  }, 2_000)

  it('shouldStop 이 처음부터 참이면 사이클을 한 번도 돌리지 않는다', async () => {
    const incrementApiUsage = vi.fn(async () => 1)
    const store = { incrementApiUsage, claimPending: async () => [] } as unknown as EventStore
    const heartbeat: Heartbeat = { ping: vi.fn(async () => true) }
    const notifier: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const log = silentLog()

    await runLoop(
      { source, store, notifier, operatorNotifier: notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      warmState(),
      createSleeper(),
      { shouldStop: () => true },
    )

    expect(incrementApiUsage).not.toHaveBeenCalled()
  })
})

/**
 * I7 회귀 — 채널이 하나면 "⚠️ 워커 연속 실패 N회" 와 일일 다이제스트(버려진 공시
 * 목록·내부 카운터)가 구독자에게 그대로 방송된다. 공개 전환 당일에 터진다.
 */
describe('runCycle — 운영자 알림은 구독자 채널로 가지 않는다', () => {
  function notifierPair() {
    const subscriber: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    const operator: Notifier = { send: vi.fn(async () => ({ ok: true }) as const) }
    return { subscriber, operator }
  }

  it('연속 실패 알림은 operatorNotifier 로만 간다', async () => {
    const { subscriber, operator } = notifierPair()
    const circuit = createCircuit()
    const heartbeat: Heartbeat = { ping: vi.fn(async () => true) }
    const deps = {
      source, store: failingStore(), notifier: subscriber, operatorNotifier: operator,
      summarizer, heartbeat, circuit, log: silentLog(),
    }

    // ALERT_THRESHOLD(5) 회째에 알림이 나간다.
    let state = warmState()
    for (let i = 0; i < ALERT_THRESHOLD; i += 1) {
      const { sleepMs: _sleepMs, ...next } = await runCycle(deps, state, NOW)
      state = next
    }

    expect(operator.send).toHaveBeenCalledTimes(1)
    expect(vi.mocked(operator.send).mock.calls[0]?.[0]).toContain('워커 연속 실패')
    expect(subscriber.send).not.toHaveBeenCalled()
  })

  it('다이제스트는 operatorNotifier 로만 간다', async () => {
    const { subscriber, operator } = notifierPair()
    const store = {
      incrementApiUsage: async () => 1,
      claimPending: async () => [],
      digestFor: async () => ({
        sent: { critical: 0, high: 0, normal: 0 },
        dead: 0, missedCandidates: [], errorCounts: {}, missedTotal: 0,
      }),
      getApiUsage: async () => 0,
    } as unknown as EventStore
    const heartbeat: Heartbeat = { ping: vi.fn(async () => true) }

    // 어제 날짜를 들고 들어가면 이번 사이클에 어제치 다이제스트가 나간다.
    await runCycle(
      {
        source, store, notifier: subscriber, operatorNotifier: operator,
        summarizer, heartbeat, circuit: createCircuit(), log: silentLog(),
      },
      { ...warmState(), lastDigestDate: '2026-09-18' },
      NOW,
    )

    expect(operator.send).toHaveBeenCalledTimes(1)
    expect(vi.mocked(operator.send).mock.calls[0]?.[0]).toContain('리포트')
    expect(subscriber.send).not.toHaveBeenCalled()
  })
})
