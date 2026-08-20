import { describe, expect, it } from 'vitest'
import type { SubmissionState } from '~/features/reviewed-execution/domain/submission-attempt'
import { assertAttemptTransition } from '~/features/reviewed-execution/coordinator/state-machine'

const model: Readonly<Record<SubmissionState, readonly SubmissionState[]>> = {
  'accepted': ['reserved', 'safely-rejected-before-dispatch', 'expired'],
  'reserved': ['revalidating', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'revalidating': ['revalidating', 'signing', 'finalized', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'signing': ['revalidating', 'signing', 'finalized', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'finalized': ['revalidating', 'dispatching', 'safely-rejected-before-dispatch', 'expired', 'recovery-required'],
  'dispatching': ['dispatching', 'identified', 'confirming', 'safely-rejected-before-dispatch', 'reverted', 'recovery-required'],
  'identified': ['dispatching', 'identified', 'confirming', 'succeeded', 'reverted', 'cancelled-proven', 'cleanup-required', 'recovery-required'],
  'confirming': ['dispatching', 'identified', 'confirming', 'succeeded', 'reverted', 'cancelled-proven', 'cleanup-required', 'recovery-required'],
  'succeeded': [],
  'safely-rejected-before-dispatch': [],
  'reverted': [],
  'cancelled-proven': [],
  'expired': [],
  'cleanup-required': ['cleanup-required', 'succeeded', 'recovery-required'],
  'recovery-required': ['identified', 'confirming', 'succeeded', 'reverted', 'cancelled-proven', 'cleanup-required', 'recovery-required'],
}
const states = Object.keys(model) as SubmissionState[]

describe('attempt state-machine model', () => {
  it('matches the complete transition matrix and keeps terminal states absorbing', () => {
    for (const from of states) {
      for (const to of states) {
        if (model[from].includes(to)) expect(() => assertAttemptTransition(from, to), `${from} -> ${to}`).not.toThrow()
        else expect(() => assertAttemptTransition(from, to), `${from} -> ${to}`).toThrow(/not allowed/)
      }
    }
  })

  it('preserves the irreversible-boundary invariant over generated paths', () => {
    let seed = 0x5eed1234
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x1_0000_0000
    }
    for (let run = 0; run < 2_000; run++) {
      let state: SubmissionState = 'accepted'
      let hasExternalIdentity = false
      for (let step = 0; step < 40; step++) {
        const choices = model[state].filter(candidate => !hasExternalIdentity || candidate !== 'safely-rejected-before-dispatch')
        if (!choices.length) break
        state = choices[Math.floor(random() * choices.length)]!
        if (['identified', 'confirming'].includes(state)) hasExternalIdentity = true
        if (hasExternalIdentity) {
          expect(state).not.toBe('expired')
          expect(state).not.toBe('safely-rejected-before-dispatch')
          expect(state).not.toBe('reserved')
          expect(state).not.toBe('revalidating')
          expect(state).not.toBe('signing')
          expect(state).not.toBe('finalized')
        }
      }
    }
  })
})
