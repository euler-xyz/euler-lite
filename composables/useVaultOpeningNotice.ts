import { computed, onUnmounted, watch } from 'vue'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultOpeningNoticeModal } from '#components'
import { getVaultOpeningNotice } from '~/utils/vault-assessment/flagged'

/** Decides once per page, after `addresses` is non-empty and labels are ready, so a later label refresh never reopens it. */
export const useVaultOpeningNotice = (addresses: () => readonly string[]) => {
  const modal = useModal()
  const router = useRouter()
  const { isReady, source, visibility } = useEulerLabels()
  const { isVerifiedVault, registryVersion } = useVaultRegistry()
  let decided = false
  let modalId: number | undefined

  const notice = computed(() => {
    const list = addresses()
    if (!list.length || !isReady.value) return undefined
    void registryVersion.value
    return getVaultOpeningNotice(list, { isVerified: isVerifiedVault, source: source.value, visibility: visibility.value })
  })

  const goBack = () => {
    if (router.options.history.state.back) router.back()
    else router.replace('/')
  }

  watch(notice, (value) => {
    if (decided || value === undefined) return
    decided = true
    if (!value) return
    modalId = modal.open(VaultOpeningNoticeModal, {
      isNotClosable: true,
      onClose: () => { modalId = undefined },
      props: value.kind === 'flagged'
        ? { flaggedText: value.text, cancelAction: goBack }
        : { cancelAction: () => router.replace('/') },
    })
  }, { immediate: true })

  onUnmounted(() => {
    if (modalId !== undefined) modal.close(modalId)
  })
}
