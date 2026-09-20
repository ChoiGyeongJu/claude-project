import { describe, it, expect } from 'vitest'
import { isPass, type Verdict } from './event.js'

describe('isPass', () => {
  it('pass verdict를 좁힌다', () => {
    const v: Verdict = { action: 'pass', tier: 'critical', rule: '공급계약' }
    expect(isPass(v)).toBe(true)
    if (isPass(v)) expect(v.tier).toBe('critical')
  })

  it('drop verdict를 거른다', () => {
    const v: Verdict = { action: 'drop', reason: 'no-stock-code' }
    expect(isPass(v)).toBe(false)
  })
})
