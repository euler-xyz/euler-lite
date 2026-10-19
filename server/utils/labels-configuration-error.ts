/** Messages contain setting names and chain IDs, never configured URLs or secrets. */
export class LabelsConfigurationError extends Error {
  override name = 'LabelsConfigurationError'
}
