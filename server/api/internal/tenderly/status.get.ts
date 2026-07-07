import { resolveTenderlyConfig } from '~/server/utils/tenderly'

export default defineEventHandler(() => {
  return { enabled: !!resolveTenderlyConfig() }
})
