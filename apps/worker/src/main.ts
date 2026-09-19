import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import pino from 'pino'
import { kstDateString } from './core/budget.js'
import { createCircuit } from './core/circuit.js'
import { loadConfig } from './config.js'
import { createDartSource } from './adapters/sources/dart.js'
import { createPostgresStore, type Db } from './adapters/store/postgres.js'
import { createTelegramNotifier } from './adapters/notifier/telegram.js'
import { noopSummarizer } from './adapters/summarizer/noop.js'
import { createHeartbeat } from './pipeline/health.js'
import { runLoop, createSleeper } from './pipeline/cycle.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)

  const sql = postgres(cfg.databaseUrl)
  const db = drizzle(sql) as unknown as Db
  const store = createPostgresStore(db)
  const source = createDartSource({ apiKey: cfg.dartApiKey })
  const notifier = createTelegramNotifier(cfg.telegram)
  // LLM 요약은 지금 붙여봐야 값이 없다. 공시 본문이 아직 없어 모델에 들어가는
  // 입력이 공시 제목뿐인데, 그 제목은 같은 메시지 두 줄 위에 이미 그대로 찍혀
  // 나간다 — 돈과 최대 30초의 직렬 지연을 폴링 루프 위에서 쓰면서 제목을
  // 바꿔 쓰기만 하는 셈이다. 2.5초 주기를 지연시키는 쪽이 훨씬 비싸다.
  //
  // llm.ts 와 그 테스트는 그대로 둔다 — 버린 것이 아니다. Task 18 이 문서 API 로
  // 공시 본문을 가져오면 그때 createLlmSummarizer(cfg.llm) 로 되돌린다.
  // LLM_API_KEY 는 그때까지도 필수 설정으로 남는다.
  const summarizer = noopSummarizer
  const heartbeat = createHeartbeat({ url: cfg.heartbeatUrl })
  const circuit = createCircuit()

  let shuttingDown = false
  const sleeper = createSleeper()

  // Docker stop·호스트 재부팅은 SIGTERM 으로 온다. 핸들러가 없으면 발송 직후
  // markSent 직전에 죽어 재시작 시 중복 알림이 나간다 — 매 재배포마다 발생한다.
  // sleep 이 중단 불가능하면 주말 sleep(5분)이나 서킷 백오프(80초) 중에 신호가
  // 와도 그게 끝나야 루프 조건을 다시 보는데, Docker 기본 유예(10초)가 먼저
  // 끝나 SIGKILL 이 떨어진다 — wakeNow() 로 대기 중이면 즉시 깨운다.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      if (shuttingDown) process.exit(1) // 두 번째 신호는 즉시 종료
      shuttingDown = true
      log.info({ sig }, 'shutdown requested — finishing current cycle')
      sleeper.wakeNow()
    })
  }
  // 하이워터 마크를 DB에서 심는다. 이게 없으면 첫 사이클이 최신 100건을 전부
  // recordEvent 로 보내고, 그 뒤로도 매 사이클 같은 100건이 no-op 트랜잭션으로
  // 반복된다 — 2.5초 주기가 DB 왕복 속도에 묶인다.
  const highWaterMark = await store.maxExternalId(source.id)
  log.info({ highWaterMark }, 'worker started')

  await runLoop(
    { source, store, notifier, summarizer, heartbeat, circuit, log },
    {
      lastDigestDate: kstDateString(new Date()),
      heartbeatFailures: 0,
      highWaterMark,
      // 첫 사이클은 기록만 하고 한 건도 발송하지 않는다. 워커는 자신이 얼마나
      // 오래 죽어 있었는지 알 수 없으므로, 마크 위에 쌓인 물량이 신규 1건인지
      // 사흘치 밀린 것인지 구분할 방법이 없다 (스펙 §6.4).
      coldStart: true,
    },
    sleeper,
    { shouldStop: () => shuttingDown },
  )

  log.info('shutdown complete')
  process.exit(0)
}

// crash-only: 예외를 삼키고 도는 것보다 죽고 재시작하는 편이 안전하다
process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'uncaught exception — exiting')
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'unhandled rejection — exiting')
  process.exit(1)
})

main().catch((err) => {
  log.fatal({ err }, 'startup failed')
  process.exit(1)
})
