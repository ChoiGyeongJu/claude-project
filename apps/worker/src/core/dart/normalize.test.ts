import { describe, it, expect } from 'vitest'
import fixture from '../../__fixtures__/dart-list.json' with { type: 'json' }
import { parseDartResponse } from './schema.js'
import { normalizeDartItem } from './normalize.js'

const SEEN = new Date('2026-09-19T06:30:00.000Z')

describe('parseDartResponse', () => {
  it('정상 응답을 파싱한다', () => {
    const parsed = parseDartResponse(fixture)
    expect(parsed.status).toBe('000')
    expect(parsed.list).toHaveLength(3)
  })

  it('데이터 없음(013) 응답도 list 없이 파싱한다', () => {
    const parsed = parseDartResponse({ status: '013', message: '조회된 데이타가 없습니다.' })
    expect(parsed.list).toBeUndefined()
  })

  it('형태가 다르면 던진다', () => {
    expect(() => parseDartResponse({ foo: 'bar' })).toThrow()
  })
})

describe('normalizeDartItem', () => {
  it('상장사 항목을 NormalizedEvent로 변환한다', () => {
    const item = parseDartResponse(fixture).list![0]!
    const e = normalizeDartItem(item, SEEN)

    expect(e.sourceId).toBe('dart')
    expect(e.externalId).toBe('20260919000123')
    expect(e.title).toBe('단일판매·공급계약체결')
    expect(e.url).toBe('https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260919000123')
    expect(e.subject).toEqual({ name: '샘플전자', ticker: '005930', market: 'Y' })
    expect(e.firstSeenAt).toBe(SEEN)
  })

  it('빈 stock_code는 ticker를 비운다', () => {
    const item = parseDartResponse(fixture).list![1]!
    const e = normalizeDartItem(item, SEEN)
    expect(e.subject?.ticker).toBeUndefined()
  })

  it('코넥스(N)는 market을 비운다 — Market 타입은 Y|K뿐', () => {
    const item = parseDartResponse(fixture).list![2]!
    const e = normalizeDartItem(item, SEEN)
    expect(e.subject?.market).toBeUndefined()
  })

  it('rcept_dt를 날짜로 변환한다 (KST 자정 기준)', () => {
    const item = parseDartResponse(fixture).list![0]!
    const e = normalizeDartItem(item, SEEN)
    expect(e.occurredAt?.toISOString()).toBe('2026-09-18T15:00:00.000Z')
  })
})
