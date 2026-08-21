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

export class DispatchFailedError extends Error {
  constructor(message = 'Transaction execution failed') {
    super(message)
    this.name = 'DispatchFailedError'
  }
}

export class ReviewedExecutionExpiredError extends Error {
  constructor(message = 'The reviewed transaction expired') {
    super(message)
    this.name = 'ReviewedExecutionExpiredError'
  }
}

export class DispatchStatusUnknownError extends Error {
  constructor(message = 'Transaction status is unknown. Check your wallet or block explorer for the latest status.') {
    super(message)
    this.name = 'DispatchStatusUnknownError'
  }
}

export class SignatureStatusUnknownError extends Error {
  constructor(message = 'Signature status is unknown. Reopen review before making another submission.') {
    super(message)
    this.name = 'SignatureStatusUnknownError'
  }
}
