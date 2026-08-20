export interface ExecutionEmergencySwitch {
  isNewReviewDisabled(): boolean
  reason(): string | undefined
}

export class MutableExecutionEmergencySwitch implements ExecutionEmergencySwitch {
  private disabledReason?: string

  disableNewReviews(reason: string) {
    if (!reason.trim()) throw new Error('Emergency switch reason is required')
    this.disabledReason = reason
  }

  enableNewReviews() {
    this.disabledReason = undefined
  }

  isNewReviewDisabled() {
    return this.disabledReason !== undefined
  }

  reason() {
    return this.disabledReason
  }
}
