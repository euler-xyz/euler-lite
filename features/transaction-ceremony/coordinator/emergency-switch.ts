export interface CeremonyEmergencySwitch {
  isNewCeremonyDisabled(): boolean
  reason(): string | undefined
}

export class MutableCeremonyEmergencySwitch implements CeremonyEmergencySwitch {
  private disabledReason?: string

  disableNewCeremonies(reason: string) {
    if (!reason.trim()) throw new Error('Emergency switch reason is required')
    this.disabledReason = reason
  }

  enableNewCeremonies() {
    this.disabledReason = undefined
  }

  isNewCeremonyDisabled() {
    return this.disabledReason !== undefined
  }

  reason() {
    return this.disabledReason
  }
}
