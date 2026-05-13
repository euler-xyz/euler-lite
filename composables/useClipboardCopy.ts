type ClipboardWriter = (text: string) => void | Promise<void>

type ClipboardCopyOptions = {
  timeout?: number
  write?: ClipboardWriter
}

const writeToClipboard: ClipboardWriter = text => navigator.clipboard.writeText(text)

export function useClipboardCopy(options: number | ClipboardCopyOptions = 2000) {
  const timeout = typeof options === 'number' ? options : options.timeout ?? 2000
  const write = typeof options === 'number' ? writeToClipboard : options.write ?? writeToClipboard
  const copiedKey = ref<string | null>(null)
  const copied = computed(() => copiedKey.value !== null)
  let copiedTimer: ReturnType<typeof setTimeout> | undefined

  const isCopied = (key: string) => copiedKey.value === key

  const copyToClipboard = async (text: string, key = text) => {
    await write(text)
    copiedKey.value = key
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      if (copiedKey.value === key) {
        copiedKey.value = null
      }
    }, timeout)
  }

  onBeforeUnmount(() => {
    clearTimeout(copiedTimer)
  })

  return {
    copied,
    copiedKey,
    isCopied,
    copyToClipboard,
  }
}
