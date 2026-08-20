export class ProvenPreDispatchCancellationError extends Error {
  constructor(message = 'The wallet request was cancelled before submission') {
    super(message)
    this.name = 'ProvenPreDispatchCancellationError'
  }
}

export class ProvenOffchainCancellationError extends Error {
  constructor(message = 'The wallet proved that submission was cancelled off-chain') {
    super(message)
    this.name = 'ProvenOffchainCancellationError'
  }
}

export class AttemptRevertedError extends Error {
  constructor(message = 'The submitted transaction reverted') {
    super(message)
    this.name = 'AttemptRevertedError'
  }
}

export class CleanupRequiredError extends Error {
  constructor(message = 'A prerequisite succeeded and its reviewed cleanup remains outstanding') {
    super(message)
    this.name = 'CleanupRequiredError'
  }
}

export class AttemptExpiredError extends Error {
  constructor(message = 'The reviewed transaction expired') {
    super(message)
    this.name = 'AttemptExpiredError'
  }
}

export class DispatchStatusUnknownError extends Error {
  constructor(message = 'Submission may have occurred; reconciliation is required') {
    super(message)
    this.name = 'DispatchStatusUnknownError'
  }
}

export class SignatureStatusUnknownError extends Error {
  constructor(message = 'The wallet may have returned a signature; reconciliation is required before creating another attempt') {
    super(message)
    this.name = 'SignatureStatusUnknownError'
  }
}
