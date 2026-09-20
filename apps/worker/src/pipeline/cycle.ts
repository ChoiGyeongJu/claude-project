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
import type { IngestState } from './ingest.js'
import { runDispatch } from './dispatch.js'
import { catchUpDigests } from './digest.js'
import type { DigestAttempt } from './digest.js'

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
  /** 구독자용 채널. 공시 알림만 나간다. */
  notifier: Notifier
  /**
   * 운영자용 채널. 다이제스트와 연속 실패 알림이 나간다.
   * TELEGRAM_OPERATOR_CHAT_ID 가 없으면 main.ts 가 notifier 와 같은 것을 넣는다.
   *
   * 나누지 않으면 "⚠️ 워커 연속 실패 N회" 와 버려진 공시 목록·내부 카운터가
   * 공개 채널로 그대로 방송된다 — 공개 전환 당일에 터진다.
   */
  operatorNotifier: Notifier
  summarizer: Summarizer
  heartbeat: Heartbeat
  circuit: Circuit
  log: CycleLogger
}

export type CycleState = {
  lastDigestDate: string
  /** lastDigestDate 에 막혀 있는 날짜의 연속 실패 횟수. digest.ts 의 catchUpDigests 참고. */
  digestAttempt: DigestAttempt | null
  heartbeatFailures: number
} & IngestState

export type CycleResult = CycleState & { sleepMs: number }

export async function runCycle(
  deps: CycleDeps, state: CycleState, now: Date,
): Promise<CycleResult> {
  const kstDate = kstDateString(now)
  let lastDigestDate = state.lastDigestDate
  let digestAttempt = state.digestAttempt
  let heartbeatFailures = state.heartbeatFailures
  // 실패 시에는 진입 상태 그대로 돌려준다 — 특히 coldStart 가 true 로 남아야
  // 기동 직후 DART 가 불통이었던 경우에도 첫 성공 사이클이 억제 사이클이 된다.
  let ingestState: IngestState = { seen: state.seen, coldStart: state.coldStart }
  let sleepMs: number

  try {
    const used = await deps.store.incrementApiUsage(deps.source.id, kstDate)
    const ingest = await runIngest(
      { source: deps.source, store: deps.store }, ingestState, now,
    )
    ingestState = ingest.state
    const dispatch = await runDispatch(
      { store: deps.store, notifier: deps.notifier, summarizer: deps.summarizer }, now,
    )

    deps.circuit.recordSuccess()

    // 억제는 반드시 로그에 남긴다. 운영자는 실시간 대응을 하지 않으므로, 재기동 후
    // "왜 그때 알림이 한 건도 안 왔는가"에 답할 기록이 여기밖에 없다.
    if (state.coldStart) {
      deps.log.info(
        {
          fetched: ingest.stats.fetched,
          suppressed: ingest.stats.suppressed,
          recorded: ingest.stats.recorded,
          seen: ingest.state.seen.size,
        },
        'cold start — backlog recorded, nothing enqueued',
      )
    }

    if (ingest.stats.recorded > 0 || dispatch.sent > 0) {
      deps.log.info({ ingest: ingest.stats, dispatch, used }, 'cycle')
    }

    // 자정이 지나면 밀린 날짜를 하루씩 모두 보낸다. `= kstDate` 로 건너뛰면
    // 장애가 자정을 두 번 넘겼을 때 중간 날의 다이제스트가 영영 사라진다 —
    // 다이제스트는 운영자의 유일한 사후 감사 기록이므로 누락되면 안 된다.
    const caughtUp = await catchUpDigests(
      { store: deps.store, notifier: deps.operatorNotifier, sourceId: deps.source.id, log: deps.log },
      lastDigestDate,
      kstDate,
      digestAttempt,
    )
    lastDigestDate = caughtUp.lastDigestDate
    digestAttempt = caughtUp.digestAttempt

    sleepMs = budgetGuard(used, pollIntervalMs(now))
  } catch (err) {
    deps.circuit.recordFailure()
    const failures = deps.circuit.consecutiveFailures()
    deps.log.error({ err, failures }, 'cycle failed')

    // `=== ALERT_THRESHOLD` 로 두면 안 된다: 전면 장애(DART·텔레그램 동시 불통) 시
    // 5회째의 단 한 번뿐인 발송이 조용히 실패하고 failures 는 6,7,8... 로 올라가
    // 다시 5가 되지 않으므로 장애 전 구간에 알림이 0건 간다.
    if (failures >= ALERT_THRESHOLD && failures % ALERT_THRESHOLD === 0) {
      await deps.operatorNotifier.send(
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

  return {
    sleepMs,
    lastDigestDate,
    digestAttempt,
    heartbeatFailures,
    seen: ingestState.seen,
    coldStart: ingestState.coldStart,
  }
}

export type Sleeper = {
  sleep(ms: number): Promise<void>
  wakeNow(): void
}

/**
 * 중단 가능한 sleep. 종료 신호가 오면 즉시 깨운다.
 * 평범한 setTimeout 이면 주말 sleep(최대 5분)이나 서킷 백오프(최대 80초) 중에
 * SIGTERM 이 와도 그게 끝나야 루프 조건을 다시 보는데, Docker 기본 유예는 10초라
 * 그전에 SIGKILL 이 떨어진다 — 핸들러가 있으나 마나가 된다.
 */
export function createSleeper(): Sleeper {
  let wake: (() => void) | null = null
  return {
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(() => { wake = null; resolve() }, ms)
        wake = () => { clearTimeout(t); wake = null; resolve() }
      }),
    wakeNow: () => wake?.(),
  }
}

export type LoopControl = { shouldStop(): boolean }

/**
 * main.ts 는 모듈 로드 시점에 바로 실행되므로 이 while 루프 자체도 여기로
 * 옮겨 테스트 가능하게 한다. 동작은 main.ts 에 인라인으로 있던 것과 동일하다:
 * 사이클을 돌리고, 반환된 sleepMs 만큼 중단 가능한 sleep 을 하고, shouldStop()
 * 이 참이 되면(SIGTERM/SIGINT) 대기 중이던 sleep 이 즉시 풀리며 다음 사이클
 * 없이 빠져나간다.
 */
export async function runLoop(
  deps: CycleDeps, initialState: CycleState, sleeper: Sleeper, control: LoopControl,
): Promise<CycleState> {
  let state = initialState
  while (!control.shouldStop()) {
    const { sleepMs, ...next } = await runCycle(deps, state, new Date())
    state = next
    await sleeper.sleep(sleepMs)
  }
  return state
}
