import { describe, it, expect } from 'vitest'
import { createTokenBucket, MESSAGES_PER_MINUTE } from './rate-limiter.js'

const T0 = new Date('2026-09-19T06:30:00Z')
const at = (ms: number) => new Date(T0.getTime() + ms)

describe('MESSAGES_PER_MINUTE', () => {
  it('텔레그램 한도(분당 20)보다 낮은 15로 스스로 제한한다', () => {
    expect(MESSAGES_PER_MINUTE).toBe(15)
  })
})

describe('createTokenBucket', () => {
  it('용량만큼은 즉시 통과시킨다', () => {
    const b = createTokenBucket({ capacity: 3, refillPerMinute: 15 })
    expect(b.tryTake(T0)).toBe(true)
    expect(b.tryTake(T0)).toBe(true)
    expect(b.tryTake(T0)).toBe(true)
  })

  it('용량을 넘으면 거절한다', () => {
    const b = createTokenBucket({ capacity: 2, refillPerMinute: 15 })
    b.tryTake(T0); b.tryTake(T0)
    expect(b.tryTake(T0)).toBe(false)
  })

  it('시간이 지나면 토큰이 회복된다', () => {
    const b = createTokenBucket({ capacity: 2, refillPerMinute: 15 })
    b.tryTake(T0); b.tryTake(T0)
    expect(b.tryTake(at(4_000))).toBe(true)   // 15/분 = 4초당 1개
  })

  it('회복은 용량을 넘지 않는다', () => {
    const b = createTokenBucket({ capacity: 2, refillPerMinute: 15 })
    b.tryTake(T0)
    b.tryTake(at(600_000))
    b.tryTake(at(600_000))
    expect(b.tryTake(at(600_000))).toBe(false)
  })
})
