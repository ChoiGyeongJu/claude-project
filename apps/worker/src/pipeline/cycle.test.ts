import { describe, it, expect, vi } from 'vitest'
import { kstDateString } from '../core/budget.js'
import { createCircuit } from '../core/circuit.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import type { Summarizer } from '../ports/summarizer.js'
import type { Heartbeat } from './health.js'
import { runCycle, type CycleLogger } from './cycle.js'

const NOW = new Date('2026-09-19T06:30:00Z')
const TODAY = kstDateString(NOW)

function silentLog(): CycleLogger {
  return { info: vi.fn(), error: vi.fn() }
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
      { source, store: failingStore(), notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      { lastDigestDate: TODAY, heartbeatFailures: 0 },
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
      { source, store: healthyStore(), notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      { lastDigestDate: TODAY, heartbeatFailures: 0 },
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
      { source, store: failingStore(), notifier, summarizer, heartbeat, circuit: createCircuit(), log },
      { lastDigestDate: TODAY, heartbeatFailures: 2 },
      NOW,
    )

    expect(ping).toHaveBeenCalledTimes(1)
    expect(result.heartbeatFailures).toBe(3) // 2에서 이어서 누적, 리셋되지 않는다
  })
})
