import { describe, it, expect, vi } from 'vitest'
import { getTableName, is, Param, SQL, StringChunk } from 'drizzle-orm'
import type { NormalizedEvent } from '@app/shared'
import { createPostgresStore, type Db } from './postgres.js'
import { outbox } from './schema.js'

const event: NormalizedEvent = {
  sourceId: 'dart',
  externalId: '20260919000123',
  occurredAt: new Date('2026-09-18T15:00:00Z'),
  firstSeenAt: new Date('2026-09-19T06:30:00Z'),
  title: '무상증자결정',
  url: 'https://example.test',
  subject: { name: '샘플', ticker: '005930', market: 'Y' },
  raw: {},
}

/** 트랜잭션 호출을 기록하는 fake. */
function fakeDb(insertedEventId: number | null) {
  const calls: string[] = []
  const tx = {
    insert: (table: unknown) => {
      const name = getTableName(table as never)
      calls.push(name)
      return {
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => (insertedEventId === null ? [] : [{ id: insertedEventId }]),
          }),
          returning: async () => [{ id: 1 }],
        }),
      }
    },
  }
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) }
  return { db: db as unknown as Db, calls }
}

describe('recordEvent', () => {
  it('pass면 events와 outbox를 같은 트랜잭션에서 쓴다', async () => {
    const { db, calls } = fakeDb(42)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'pass', tier: 'critical', rule: 'keyword:무상증자결정' },
      { enqueue: true, expiresAt: new Date('2026-09-19T06:35:00Z') },
    )

    expect(inserted).toBe(true)
    expect(calls).toEqual(['events', 'outbox'])
  })

  it('중복이면 outbox를 쓰지 않고 false를 반환한다', async () => {
    const { db, calls } = fakeDb(null)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'pass', tier: 'critical', rule: 'keyword:무상증자결정' },
      { enqueue: true, expiresAt: new Date('2026-09-19T06:35:00Z') },
    )

    expect(inserted).toBe(false)
    expect(calls).toEqual(['events'])
  })

  it('drop이면 events만 쓴다 — 사유 추적을 위해 기록은 남긴다', async () => {
    const { db, calls } = fakeDb(43)
    const store = createPostgresStore(db)

    const inserted = await store.recordEvent(
      event,
      { action: 'drop', reason: 'no-keyword-match' },
      { enqueue: false, expiresAt: null },
    )

    expect(inserted).toBe(true)
    expect(calls).toEqual(['events'])
  })
})

/**
 * select().from().where().orderBy().limit() 체인을 흉내내는 fake.
 *
 * orderBy에 전달된 인자를 그대로 기록해 반환한다 — 이 fake는 실제 정렬을
 * 수행하지 않으므로(그럴 수도 없다: 정렬은 Postgres가 한다), rows의 순서를
 * 검증하는 테스트는 정렬 로직이 있든 없든 통과해 아무것도 증명하지 못한다.
 * 대신 orderBy로 전달된 SQL 조각 자체를 검증해야 한다.
 */
function fakeSelectDb(rows: unknown[]) {
  const orderByCalls: unknown[][] = []
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: (...args: unknown[]) => {
            orderByCalls.push(args)
            return { limit: async () => rows }
          },
        }),
      }),
    }),
  }
  return { db: db as unknown as Db, orderByCalls }
}

/** SQL 조각의 StringChunk들을 이어붙여 리터럴 텍스트를 복원한다. */
function sqlText(fragment: SQL): string {
  return fragment.queryChunks
    .filter((c): c is StringChunk => c instanceof StringChunk)
    .map((c) => c.value.join(''))
    .join('')
}

/** update().set().where() 체인을 흉내내는 fake. set()에 전달된 값을 그대로 기록한다. */
function fakeUpdateDb() {
  const calls: { table: string; values: unknown }[] = []
  const db = {
    update: (table: unknown) => ({
      set: (values: unknown) => {
        calls.push({ table: getTableName(table as never), values })
        return { where: async () => {} }
      },
    }),
  }
  return { db: db as unknown as Db, calls }
}

describe('markFailed', () => {
  it(
    '전달받은 attempts 값을 그대로 쓴다 — 스스로 +1 하지 않는다. ' +
      'store가 스스로 증가시키면 local-rate-limit 스로틀링까지 시도 횟수를 소비해, ' +
      '자가 조절만으로 정상 알림이 dead 처리될 수 있다 (Task 13 회귀).',
    async () => {
      const { db, calls } = fakeUpdateDb()
      const store = createPostgresStore(db)

      await store.markFailed(7, 'boom', new Date('2026-09-19T06:35:00Z'), 3)

      expect(calls).toHaveLength(1)
      expect(calls[0]?.table).toBe('outbox')
      // 리터럴 3이어야 한다 — `sql\`attempts + 1\`` 같은 SQL 조각이면 안 된다.
      expect(calls[0]?.values).toEqual({
        attempts: 3,
        lastError: 'boom',
        nextAttemptAt: new Date('2026-09-19T06:35:00Z'),
      })
    },
  )
})

describe('claimPending', () => {
  it('유효한 tier 값을 가진 행을 PendingOutbox로 변환하고, jsonb 왕복으로 문자열이 된 firstSeenAt을 Date로 되살린다', async () => {
    const { db } = fakeSelectDb([
      {
        id: 1,
        eventId: 10,
        tier: 'critical',
        // 실제 Postgres에서는 jsonb 왕복 후 Date가 ISO 문자열로 온다.
        payload: { ...event, occurredAt: event.occurredAt?.toISOString() ?? null, firstSeenAt: event.firstSeenAt.toISOString() },
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    const store = createPostgresStore(db)

    const rows = await store.claimPending(new Date('2026-09-19T06:31:00Z'), 10)

    expect(rows).toEqual([
      {
        id: 1,
        eventId: 10,
        tier: 'critical',
        event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    expect(rows[0]?.event.firstSeenAt).toBeInstanceOf(Date)
    expect(rows[0]?.event.occurredAt).toBeInstanceOf(Date)
  })

  it('tier 값이 유효하지 않은 행은 건너뛰고, 나머지 행은 정상 반환한다 — DB에 CHECK 제약이 없어 손상된 값이 들어올 수 있다', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = fakeSelectDb([
      {
        id: 1,
        eventId: 10,
        tier: 'urgent', // Tier가 아닌 값 — 손상되었거나 예상치 못한 데이터
        payload: event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
      {
        id: 2,
        eventId: 11,
        tier: 'high',
        payload: event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    const store = createPostgresStore(db)

    const rows = await store.claimPending(new Date('2026-09-19T06:31:00Z'), 10)

    expect(rows).toEqual([
      {
        id: 2,
        eventId: 11,
        tier: 'high',
        event,
        attempts: 0,
        expiresAt: new Date('2026-09-19T06:35:00Z'),
      },
    ])
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it(
    'critical tier를 nextAttemptAt보다 먼저 정렬한다 — ' +
      'outbox 적체 시 TTL이 가장 짧은(5분) critical 알림이 배치 경계에서 밀려 만료되는 것을 막는다',
    async () => {
      const { db, orderByCalls } = fakeSelectDb([])
      const store = createPostgresStore(db)

      await store.claimPending(new Date('2026-09-19T06:31:00Z'), 10)

      // fakeSelectDb는 정렬을 실제로 수행하지 않는다 — rows 순서로는 이 로직을
      // 증명할 수 없다. orderBy에 실제로 전달된 SQL 조각을 검증한다.
      expect(orderByCalls).toHaveLength(1)
      const args = orderByCalls[0] ?? []
      expect(args).toHaveLength(2)
      const [tierOrder, timeOrder] = args as [SQL, SQL]

      // 1번째 기준: outbox.tier를 참조하는 CASE WHEN critical → 0, 그 외 → 1.
      // asc(nextAttemptAt) 하나만 남는 회귀가 생기면 orderBy가 인자 1개로
      // 호출되어 위 toHaveLength(2)에서 이미 실패하고, 컬럼이 바뀌면 아래에서 실패한다.
      expect(tierOrder).toBeInstanceOf(SQL)
      expect(tierOrder.queryChunks).toContain(outbox.tier)
      const tierText = sqlText(tierOrder)
      expect(tierText).toContain('CASE WHEN')
      expect(tierText).toContain('critical')
      expect(tierText).toContain('THEN 0 ELSE 1 END')

      // 2번째 기준: nextAttemptAt 오름차순 (critical 안에서도, non-critical 안에서도
      // 먼저 접수된 것부터 처리하기 위함).
      expect(timeOrder).toBeInstanceOf(SQL)
      expect(timeOrder.queryChunks).toContain(outbox.nextAttemptAt)
      expect(sqlText(timeOrder).toLowerCase()).toContain('asc')
    },
  )
})

/** SQL 조각 트리(중첩 SQL, 예: and()가 eq()/gte()/lt() 여럿을 감싼 것)를 재귀적으로
 * 순회하며 모든 Param 값을 모은다. `eq(col, 'drop')`의 'drop'은 StringChunk가 아니라
 * Param으로 표현되므로(파라미터 바인딩), 위의 sqlText()로는 보이지 않는다 — 이 헬퍼가 필요한 이유. */
function collectParamValues(node: unknown, out: unknown[] = []): unknown[] {
  if (is(node, Param)) {
    out.push(node.value)
    return out
  }
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) collectParamValues(chunk, out)
  }
  return out
}

/**
 * SQL 조각 트리를 재귀적으로 순회하며 모든 StringChunk 텍스트를 모은다.
 *
 * drizzle-orm 0.45.2 소스(sql/expressions/conditions.js)를 직접 읽어 확인한 구조:
 * `and(c1, c2, ...)`(조건 2개 이상)는 `new SQL([StringChunk("("), sql.join(conds, StringChunk(" and ")), StringChunk(")")])`를
 * 반환하고, `or(...)`는 구분자만 `StringChunk(" or ")`로 다르다 — 조건들 자체(각각 eq/gte/lt가 만든 SQL)는
 * 동일하므로, 리프 값(Param)만 비교하면 and와 or를 구분하지 못한다. 이 함수로 얻은 텍스트에서
 * " and " / " or " 구분자 자체를 확인해야 조합자(combinator)를 고정할 수 있다.
 */
function collectStringChunkText(node: unknown, out: string[] = []): string[] {
  if (node instanceof StringChunk) {
    out.push(node.value.join(''))
    return out
  }
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) collectStringChunkText(chunk, out)
  }
  return out
}

type DigestChain = {
  from: () => DigestChain
  innerJoin: () => DigestChain
  where: (cond: unknown) => DigestChain
  groupBy: () => DigestChain
  orderBy: () => DigestChain
  limit: () => DigestChain
  then: (resolve: (v: unknown) => void) => void
}

/**
 * digestFor()가 순서대로 날리는 5개 select 쿼리(sent, dead, missed, errors, missedTotal)를
 * 흉내내는 fake. 체인 길이가 쿼리마다 달라(groupBy/orderBy/limit 유무) 모든 메서드를 no-op으로
 * 체이닝하고, where()에 전달된 조건만 호출 순서대로 기록한다. 5개 쿼리는 Promise.all 없이
 * 순차적으로 await되므로 — 실제 구현이 그렇게 짜여 있다 — 공유 카운터만으로 몇 번째
 * select()인지 안전하게 구분할 수 있다.
 */
function fakeDigestDb(rowsByCall: unknown[][]) {
  const whereCalls: unknown[] = []
  let call = -1
  const chain: DigestChain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (cond) => {
      whereCalls[call] = cond
      return chain
    },
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: (resolve) => resolve(rowsByCall[call] ?? []),
  }
  const db = {
    select: () => {
      call += 1
      return chain
    },
  }
  return { db: db as unknown as Db, whereCalls }
}

describe('digestFor', () => {
  it(
    '미매칭 후보 조회는 verdict=drop AND rule=no-keyword-match 두 조건을 AND로 묶는다 — ' +
      '조건 하나가 빠지거나 AND가 OR로 바뀌면 전체 drop이 쏟아져 다이제스트가 읽히지 않거나(노이즈), ' +
      '아예 걸러져 신호가 사라진다(과다 제한). 순서: 0=sent, 1=dead, 2=missed, 3=errors, 4=missedTotal.',
    async () => {
      const { db, whereCalls } = fakeDigestDb([[], [], [], [], []])
      const store = createPostgresStore(db)

      await store.digestFor('2026-09-19')

      const missedWhere = whereCalls[2]

      // 리프 값: 두 조건의 값이 실제로 쿼리에 쓰였는가.
      const values = collectParamValues(missedWhere)
      expect(values).toContain('drop')
      expect(values).toContain('no-keyword-match')

      // 조합자: 값만 확인하면 and(...)를 or(...)로 바꿔도(여전히 두 값 다 등장) 통과해 버린다 —
      // or로 바뀌면 조건 하나만 맞아도 걸리므로 이 조회가 반환하는 행이 폭발한다.
      // " and " / " or " 구분자 리터럴 자체가 쿼리에 어떻게 쓰였는지 확인해야 잡을 수 있다.
      const text = collectStringChunkText(missedWhere).join('')
      expect(text).toContain(' and ')
      expect(text).not.toContain(' or ')
    },
  )

  it('outbox.lastError를 집계해 errorCounts로 반환한다 — null인 lastError는 제외한다', async () => {
    const { db } = fakeDigestDb([
      [], // sent
      [], // dead
      [], // missed
      [
        { err: 'dart-timeout', n: 3 },
        { err: 'telegram-429', n: 1 },
        { err: null, n: 7 }, // 실제로는 isNotNull()이 SQL 단에서 걸러내는 행 — 매핑 가드가 통과시키지 않는지 확인
      ],
      [], // missedTotal
    ])
    const store = createPostgresStore(db)

    const result = await store.digestFor('2026-09-19')

    expect(result.errorCounts).toEqual({ 'dart-timeout': 3, 'telegram-429': 1 })
  })

  it('미매칭 총계를 표시 목록과 별도로 잘리지 않게 센다 — 50건 상한에 걸려도 실제 건수를 알 수 있어야 한다', async () => {
    const { db } = fakeDigestDb([
      [], // sent
      [], // dead
      Array.from({ length: 50 }, () => ({ title: 't', corpName: 'c', ticker: null })), // missed (상한 도달)
      [], // errors
      [{ n: 300 }], // missedTotal — 상한과 무관한 진짜 총계
    ])
    const store = createPostgresStore(db)

    const result = await store.digestFor('2026-09-19')

    expect(result.missedCandidates).toHaveLength(50)
    expect(result.missedTotal).toBe(300)
  })
})

/**
 * select().from().where()[.orderBy().limit()] 를 흉내내되, 체인 자체가 thenable 이라
 * 어느 단계에서 await 해도 rows 가 나온다 — maxExternalId 는 where() 에서,
 * lastEventKstDate 는 limit() 에서 await 하기 때문이다.
 */
type SelectChain = {
  from: () => SelectChain
  where: (cond: unknown) => SelectChain
  orderBy: (...args: unknown[]) => SelectChain
  limit: () => SelectChain
  then: (resolve: (v: unknown) => void) => void
}

function fakeThenableDb(rows: unknown[]) {
  const whereCalls: unknown[] = []
  const orderByCalls: unknown[][] = []
  const chain: SelectChain = {
    from: () => chain,
    where: (cond) => { whereCalls.push(cond); return chain },
    orderBy: (...args) => { orderByCalls.push(args); return chain },
    limit: () => chain,
    then: (resolve) => resolve(rows),
  }
  const db = { select: () => chain }
  return { db: db as unknown as Db, whereCalls, orderByCalls }
}

describe('maxExternalId — 하이워터 마크의 기동 시 시드', () => {
  it('해당 source 의 max(external_id) 를 반환한다', async () => {
    const { db, whereCalls } = fakeThenableDb([{ max: '20260919000456' }])
    const store = createPostgresStore(db)

    expect(await store.maxExternalId('dart')).toBe('20260919000456')

    // source_id 로 좁히지 않으면 나중에 소스가 추가됐을 때(스펙 §3 의 2·3단계)
    // 다른 소스의 id 가 DART 의 마크를 덮어써 공시가 통째로 건너뛰어진다.
    expect(collectParamValues(whereCalls[0])).toContain('dart')
  })

  it('행이 없으면 null 을 반환한다 — 빈 DB 에서는 아무것도 건너뛰지 않는다', async () => {
    const { db } = fakeThenableDb([])
    expect(await createPostgresStore(db).maxExternalId('dart')).toBeNull()
  })

  it('max 가 SQL NULL 로 와도 null 로 정규화한다', async () => {
    // 빈 테이블에 max() 를 걸면 행은 1개 나오되 값이 NULL 이다. 이걸 그대로
    // 마크로 쓰면 externalId <= null 비교가 되어 필터가 무의미해진다.
    const { db } = fakeThenableDb([{ max: null }])
    expect(await createPostgresStore(db).maxExternalId('dart')).toBeNull()
  })
})
