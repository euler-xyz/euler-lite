export class ReviewedExecutionChangedError extends Error {
  constructor() {
    super('Migration inputs changed after review. Review the migration again.')
    this.name = 'ReviewedExecutionChangedError'
  }
}

export const assertReviewedExecutionCurrent = ({
  reviewedKey,
  currentKey,
}: {
  reviewedKey: string
  currentKey: string
}) => {
  if (!reviewedKey || reviewedKey !== currentKey) {
    throw new ReviewedExecutionChangedError()
  }
}
