import { budgetGuard, kstDateString } from '../core/budget.js'
import { ALERT_THRESHOLD } from '../core/circuit.js'
import type { Circuit } from '../core/circuit.js'
import { pollIntervalMs } from '../core/schedule.js'
import type { EventSource } from '../ports/source.js'
import type { EventStore } from '../ports/store.js'
import type { Notifier } from '../ports/notifier.js'
import type { Summarizer } from '../ports/summarizer.js'
import type { Heartbeat } from './health.js'
import { runIngest } from './ingest.js'
import { runDispatch } from './dispatch.js'
import { catchUpDigests } from './digest.js'

/**
 * main.ts 는 `main().catch(...)` 를 모듈 로드 시점에 바로 실행하므로 테스트에서
 * import 할 수 없다 — 그래서 한 사이클의 로직을 여기로 옮겨 직접 테스트할 수 있게
 * 한다. 동작은 main.ts 에 인라인으로 있던 것과 동일하다.
 */
export type CycleLogger = {
  info(obj: Record<string, unknown> | string, msg?: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export type CycleDeps = {
  source: EventSource
  store: EventStore
  notifier: Notifier
  summarizer: Summarizer
  heartbeat: Heartbeat
  circuit: Circuit
  log: CycleLogger
}

export type CycleState = {
  lastDigestDate: string
  heartbeatFailures: number
}

export type CycleResult = CycleState & { sleepMs: number }

export async function runCycle(
  deps: CycleDeps, state: CycleState, now: Date,
): Promise<CycleResult> {
  const kstDate = kstDateString(now)
  let lastDigestDate = state.lastDigestDate
  let heartbeatFailures = state.heartbeatFailures
  let sleepMs: number

  try {
    const used = await deps.store.incrementApiUsage(deps.source.id, kstDate)
    const ingest = await runIngest({ source: deps.source, store: deps.store }, now)
    const dispatch = await runDispatch(
      { store: deps.store, notifier: deps.notifier, summarizer: deps.summarizer }, now,
    )

    deps.circuit.recordSuccess()
    if (ingest.recorded > 0 || dispatch.sent > 0) {
      deps.log.info({ ingest, dispatch, used }, 'cycle')
    }

    // 자정이 지나면 밀린 날짜를 하루씩 모두 보낸다. `= kstDate` 로 건너뛰면
    // 장애가 자정을 두 번 넘겼을 때 중간 날의 다이제스트가 영영 사라진다 —
    // 다이제스트는 운영자의 유일한 사후 감사 기록이므로 누락되면 안 된다.
    lastDigestDate = await catchUpDigests(
      { store: deps.store, notifier: deps.notifier, sourceId: deps.source.id },
      lastDigestDate,
      kstDate,
    )

    sleepMs = budgetGuard(used, pollIntervalMs(now))
  } catch (err) {
    deps.circuit.recordFailure()
    const failures = deps.circuit.consecutiveFailures()
    deps.log.error({ err, failures }, 'cycle failed')

    // `=== ALERT_THRESHOLD` 로 두면 안 된다: 전면 장애(DART·텔레그램 동시 불통) 시
    // 5회째의 단 한 번뿐인 발송이 조용히 실패하고 failures 는 6,7,8... 로 올라가
    // 다시 5가 되지 않으므로 장애 전 구간에 알림이 0건 간다.
    if (failures >= ALERT_THRESHOLD && failures % ALERT_THRESHOLD === 0) {
      await deps.notifier.send(
        `⚠️ 워커 연속 실패 ${failures}회` +
        (heartbeatFailures > 0 ? `\n⚠️ heartbeat 미확인 ${heartbeatFailures}회 — 감시망 점검 필요` : ''),
      ).catch(() => {})
    }

    sleepMs = pollIntervalMs(new Date()) * deps.circuit.intervalMultiplier()
  } finally {
    // heartbeat 은 반드시 finally 에 둔다. "프로세스가 살아 루프를 돌고 있는가"에
    // 답하는 신호이고, 그 답은 DART 성공 여부와 무관하기 때문이다.
    // try 안에 두면 DART 장애 중 워커가 멀쩡히 백오프하는 동안에도 핑이 끊겨
    // 외부 감시가 "VM 사망"으로 오판하고, 사람이 고칠 수 없고 저절로 낫는 일로
    // 운영자를 호출하게 된다. DART 실패는 서킷 브레이커 알림이 담당한다.
    // ping() 은 절대 throw 하지 않으므로 finally 에서 안전하다.
    heartbeatFailures = (await deps.heartbeat.ping()) ? 0 : heartbeatFailures + 1
  }

  return { sleepMs, lastDigestDate, heartbeatFailures }
}
