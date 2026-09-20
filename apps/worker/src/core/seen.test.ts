import { describe, it, expect } from 'vitest'
import { createSeenSet, SEEN_CAPACITY } from './seen.js'

describe('createSeenSet', () => {
  it('넣은 id 를 기억한다', () => {
    const seen = createSeenSet()
    expect(seen.has('a')).toBe(false)
    seen.add('a')
    expect(seen.has('a')).toBe(true)
  })

  it('초기값으로 심을 수 있다 — 재기동 시 DB 에서 복원하는 경로', () => {
    const seen = createSeenSet(['a', 'b'])
    expect(seen.has('a')).toBe(true)
    expect(seen.has('b')).toBe(true)
    expect(seen.size).toBe(2)
  })

  it('같은 id 를 두 번 넣어도 크기가 늘지 않는다', () => {
    const seen = createSeenSet()
    seen.add('a')
    seen.add('a')
    expect(seen.size).toBe(1)
  })

  it('순서를 가정하지 않는다 — 작은 값이 큰 값 뒤에 와도 정상 처리 대상이다', () => {
    // 하이워터 마크였다면 여기서 '100' 이 영영 건너뛰어졌다.
    const seen = createSeenSet(['20260919000300'])
    expect(seen.has('20260919000100')).toBe(false)
  })
})

describe('createSeenSet — 축출', () => {
  it('상한을 넘으면 가장 오래 전에 넣은 것부터 버린다', () => {
    const seen = createSeenSet([], 3)
    for (const id of ['a', 'b', 'c', 'd']) seen.add(id)

    expect(seen.size).toBe(3)
    expect(seen.has('a')).toBe(false) // 가장 오래된 것이 밀려났다
    expect(seen.has('b')).toBe(true)
    expect(seen.has('d')).toBe(true)
  })

  it('상한을 넘겨 심어도 상한을 지킨다', () => {
    const seen = createSeenSet(['a', 'b', 'c', 'd', 'e'], 2)
    expect(seen.size).toBe(2)
    expect(seen.has('d')).toBe(true)
    expect(seen.has('e')).toBe(true)
  })

  it(
    '재조회로 다시 add 해도 나이가 젊어지지 않는다 — ' +
      '젊어지면 매 사이클 다시 오는 옛날 id 가 영원히 살아남고 진짜 새 id 가 대신 축출된다',
    () => {
      const seen = createSeenSet([], 3)
      for (const id of ['a', 'b', 'c']) seen.add(id)
      seen.add('a') // 목록 API 가 a 를 또 돌려준 상황
      seen.add('d') // 새 id 하나

      // a 가 맨 뒤로 갔다면 b 가 밀려났을 것이다. a 가 먼저 나가야 맞다.
      expect(seen.has('a')).toBe(false)
      expect(seen.has('b')).toBe(true)
      expect(seen.has('d')).toBe(true)
    },
  )

  it('기본 상한은 목록 API 한 페이지(100건)의 여러 배다', () => {
    expect(SEEN_CAPACITY).toBe(500)
    expect(SEEN_CAPACITY).toBeGreaterThanOrEqual(100 * 5)
  })

  it('기본 상한에서도 실제로 축출이 일어난다', () => {
    const seen = createSeenSet()
    for (let i = 0; i < SEEN_CAPACITY + 10; i += 1) seen.add(`id-${i}`)
    expect(seen.size).toBe(SEEN_CAPACITY)
    expect(seen.has('id-0')).toBe(false)
    expect(seen.has(`id-${SEEN_CAPACITY + 9}`)).toBe(true)
  })
})
