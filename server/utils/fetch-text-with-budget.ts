export interface ResponseBudget {
  maxBytes: number
  timeoutMs: number
}

/** Bounds fetch and decoded body bytes, including chunked and error responses. */
export async function fetchTextWithBudget(
  url: string,
  init: RequestInit,
  { maxBytes, timeoutMs }: ResponseBudget,
): Promise<{ response: Response, text: string }> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancel = () => {
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancel()
      reject(new Error('Upstream response deadline exceeded'))
    }, timeoutMs)
  })
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetch(url, { ...init, signal: controller.signal })
      controller.signal.throwIfAborted()
      const length = response.headers.get('content-length')
      if (length !== null && Number(length) > maxBytes) {
        void response.body?.cancel().catch(() => {})
        throw new Error('Upstream response too large')
      }
      reader = response.body?.getReader()
      if (!reader) return { response, text: '' }
      const decoder = new TextDecoder()
      const chunks: string[] = []
      let bytes = 0
      while (true) {
        const { done, value } = await reader.read()
        controller.signal.throwIfAborted()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) throw new Error('Upstream response too large')
        chunks.push(decoder.decode(value, { stream: true }))
      }
      chunks.push(decoder.decode())
      return { response, text: chunks.join('') }
    })()])
  }
  catch (error) {
    cancel()
    throw error
  }
  finally {
    clearTimeout(timer)
  }
}
