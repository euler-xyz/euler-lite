import type { DataIssue } from '@eulerxyz/euler-v2-sdk'

export const isSdkErrorDiagnostic = (issue: unknown): issue is DataIssue =>
  typeof issue === 'object'
  && issue !== null
  && (issue as { severity?: unknown }).severity === 'error'
