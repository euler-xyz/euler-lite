export class ReviewedPlanDivergenceError extends Error {
  constructor(readonly intentIds: readonly string[]) {
    super('Batch operations changed during preparation. Remove and re-add the affected operations, then review again.')
    this.name = 'ReviewedPlanDivergenceError'
  }
}

export class BatchPreviewNotReadyError extends Error {
  constructor() {
    super('Batch preview is not ready. Wait for every operation to finish preparing, then review again.')
    this.name = 'BatchPreviewNotReadyError'
  }
}
