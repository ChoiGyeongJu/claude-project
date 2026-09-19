import { describe, it, expect, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'
import type { NormalizedEvent } from '@app/shared'
import { createPostgresStore, type Db } from './postgres.js'

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

/** select().from().where().orderBy().limit() 체인을 흉내내는 fake. */
function fakeSelectDb(rows: unknown[]) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
  }
  return db as unknown as Db
}

describe('claimPending', () => {
  it('유효한 tier 값을 가진 행을 PendingOutbox로 변환한다', async () => {
    const db = fakeSelectDb([
      {
        id: 1,
        eventId: 10,
        tier: 'critical',
        payload: event,
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
  })

  it('tier 값이 유효하지 않은 행은 건너뛰고, 나머지 행은 정상 반환한다 — DB에 CHECK 제약이 없어 손상된 값이 들어올 수 있다', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = fakeSelectDb([
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
})
