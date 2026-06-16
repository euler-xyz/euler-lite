import type { Ref } from 'vue'

type UserSettings = {
  enableIntrinsicApy: boolean
  enableRewardsApy: boolean
  enableAdvancedMode: boolean
  enableCrossProtocolRefinance: boolean
}

const SETTINGS_KEY = 'user-settings'
const defaults: UserSettings = {
  enableIntrinsicApy: true,
  enableRewardsApy: true,
  enableAdvancedMode: false,
  enableCrossProtocolRefinance: false,
}

type StoredUserSettings = Partial<UserSettings> & {
  enableBatchTransactions?: boolean
}

const normalizeSettings = (value: StoredUserSettings): UserSettings => ({
  enableIntrinsicApy: value.enableIntrinsicApy ?? defaults.enableIntrinsicApy,
  enableRewardsApy: value.enableRewardsApy ?? defaults.enableRewardsApy,
  enableAdvancedMode: value.enableAdvancedMode ?? value.enableBatchTransactions ?? defaults.enableAdvancedMode,
  enableCrossProtocolRefinance: value.enableCrossProtocolRefinance ?? defaults.enableCrossProtocolRefinance,
})

const settings = useLocalStorage<StoredUserSettings>(SETTINGS_KEY, defaults)

settings.value = normalizeSettings(settings.value)

export const useUserSettings = () => ({
  settings: readonly(settings as Ref<UserSettings>),
  updateSetting: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    settings.value = { ...normalizeSettings(settings.value), [key]: value }
  },
})
