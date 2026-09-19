import { describe, it, expect } from 'vitest'
import { events, outbox, apiUsage } from './schema.js'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('events 테이블', () => {
  it('(source_id, external_id) 유니크 제약을 가진다 — 중복 발송 차단의 근거', () => {
    const cfg = getTableConfig(events)
    const cols = cfg.uniqueConstraints.flatMap((u) => u.columns.map((c) => c.name))
    expect(cols).toEqual(expect.arrayContaining(['source_id', 'external_id']))
  })

  it('drop된 이벤트도 사유를 남길 수 있도록 rule이 not null이다', () => {
    const cfg = getTableConfig(events)
    const rule = cfg.columns.find((c) => c.name === 'rule')
    expect(rule?.notNull).toBe(true)
  })
})

describe('outbox 테이블', () => {
  it('expires_at을 가진다 — 늦은 알림 포기의 근거', () => {
    const cfg = getTableConfig(outbox)
    expect(cfg.columns.map((c) => c.name)).toContain('expires_at')
  })
})

describe('api_usage 테이블', () => {
  it('(usage_date, source_id) 복합 PK를 가진다', () => {
    const cfg = getTableConfig(apiUsage)
    const pk = cfg.primaryKeys[0]
    expect(pk?.columns.map((c) => c.name)).toEqual(['usage_date', 'source_id'])
  })
})
