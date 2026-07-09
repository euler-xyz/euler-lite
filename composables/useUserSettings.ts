import type { Ref } from 'vue'

type UserSettings = {
  enableIntrinsicApy: boolean
  enableRewardsApy: boolean
  enableAdvancedMode: boolean
}

const SETTINGS_KEY = 'user-settings'
const defaults: UserSettings = {
  enableIntrinsicApy: true,
  enableRewardsApy: true,
  enableAdvancedMode: false,
}

type StoredUserSettings = Partial<UserSettings> & {
  enableBatchTransactions?: boolean
}

const normalizeSettings = (value: StoredUserSettings): UserSettings => ({
  enableIntrinsicApy: value.enableIntrinsicApy ?? defaults.enableIntrinsicApy,
  enableRewardsApy: value.enableRewardsApy ?? defaults.enableRewardsApy,
  enableAdvancedMode: value.enableAdvancedMode ?? value.enableBatchTransactions ?? defaults.enableAdvancedMode,
})

const settings = useLocalStorage<StoredUserSettings>(SETTINGS_KEY, defaults)

settings.value = normalizeSettings(settings.value)

export const useUserSettings = () => ({
  settings: readonly(settings as Ref<UserSettings>),
  updateSetting: <K extends keyof UserSettings>(key: K, value: UserSettings[K]) => {
    settings.value = { ...normalizeSettings(settings.value), [key]: value }
  },
})
