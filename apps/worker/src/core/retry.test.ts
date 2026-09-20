import { describe, it, expect } from 'vitest'
import { MAX_ATTEMPTS, backoffMs, nextAttemptAt } from './retry.js'

const NOW = new Date('2026-09-19T06:30:00Z')

describe('backoffMs — 지수 백오프', () => {
  it.each([
    [0, 5_000],
    [1, 15_000],
    [2, 60_000],
    [3, 300_000],
    [4, 1_800_000],
  ])('시도 %i회 후 대기 %ims', (attempts, expected) => {
    expect(backoffMs(attempts)).toBe(expected)
  })

  it('범위를 넘으면 마지막 값을 유지한다', () => {
    expect(backoffMs(99)).toBe(1_800_000)
  })
})

describe('MAX_ATTEMPTS', () => {
  it('5회 실패하면 포기한다', () => expect(MAX_ATTEMPTS).toBe(5))
})

describe('nextAttemptAt', () => {
  it('now + backoff', () => {
    expect(nextAttemptAt(0, NOW).toISOString()).toBe('2026-09-19T06:30:05.000Z')
  })
})
