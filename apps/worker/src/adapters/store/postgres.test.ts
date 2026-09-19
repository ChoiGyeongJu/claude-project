import { describe, it, expect, vi } from 'vitest'
import { getTableName, SQL, StringChunk } from 'drizzle-orm'
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
