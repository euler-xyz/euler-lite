const KNOWN_DOPPLER_ENVIRONMENTS = new Set(['dev', 'stg', 'prd'])

function getDopplerEnvironment(): string | undefined {
  return process.env.DOPPLER_ENVIRONMENT?.trim() || undefined
}

export function isProductionRuntime(): boolean {
  const dopplerEnvironment = getDopplerEnvironment()
  if (dopplerEnvironment && KNOWN_DOPPLER_ENVIRONMENTS.has(dopplerEnvironment)) {
    return dopplerEnvironment === 'prd'
  }

  return process.env.NODE_ENV === 'production'
}

export function isDevelopmentRuntime(): boolean {
  return getDopplerEnvironment() === 'dev'
}
