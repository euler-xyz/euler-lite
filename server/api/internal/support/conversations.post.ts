import { createError, readMultipartFormData } from 'h3'
import { helpScoutConfig, isEmail, isSupportConfigured, mailboxCreate, mailboxFetch } from '~/server/utils/helpscout'
import { createRateLimiter } from '~/server/utils/rate-limit'

const rateLimiter = createRateLimiter({ max: 10, windowMs: 600_000, label: 'support-create' })

const MAX_SUBJECT = 200
const MAX_BODY = 20_000
const MAX_ATTACHMENTS = 3
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const toHtml = (value: string) => '<p>' + escapeHtml(value).replace(/\n/g, '<br>') + '</p>'

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  if (!isSupportConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Support is not configured' })
  }

  const parts = await readMultipartFormData(event)
  if (!parts) throw createError({ statusCode: 400, statusMessage: 'Expected multipart body' })

  const field = (name: string) =>
    parts.find(part => part.name === name && !part.filename)?.data.toString('utf8').trim() ?? ''

  const subject = field('subject').slice(0, MAX_SUBJECT)
  const body = field('body').slice(0, MAX_BODY)
  const email = field('email')
  if (!subject || !body) {
    throw createError({ statusCode: 400, statusMessage: 'Subject and message are required' })
  }
  if (!isEmail(email)) throw createError({ statusCode: 400, statusMessage: 'Invalid email' })

  let diagnostics: Record<string, string>
  try {
    diagnostics = JSON.parse(field('diagnostics') || '{}')
  }
  catch {
    diagnostics = {}
  }

  const files = parts
    .filter(part => part.filename && part.data.length)
    .slice(0, MAX_ATTACHMENTS)
    .filter(part => part.data.length <= MAX_ATTACHMENT_BYTES)

  const { mailboxId } = helpScoutConfig()

  // Diagnostics ride along as an internal note rather than in the customer-visible
  // body. Query-string values in the console buffer are already redacted upstream —
  // see utils/console-capture.ts.
  const diagnosticsBlock = [
    'Wallet: ' + (diagnostics.wallet ?? 'unknown'),
    'Chain: ' + (diagnostics.chainId ?? 'unknown'),
    'User agent: ' + (diagnostics.userAgent ?? 'unknown'),
    '',
    'Recent console output:',
    diagnostics.consoleOutput || '(none captured)',
  ].join('\n')

  try {
    const conversationId = await mailboxCreate('/conversations', {
      subject,
      type: 'email',
      mailboxId,
      status: 'active',
      customer: { email },
      threads: [
        {
          type: 'customer',
          customer: { email },
          text: toHtml(body),
          attachments: files.map(file => ({
            fileName: file.filename,
            mimeType: file.type ?? 'application/octet-stream',
            data: file.data.toString('base64'),
          })),
        },
        {
          type: 'note',
          text: '<pre>' + escapeHtml(diagnosticsBlock) + '</pre>',
        },
      ],
    })

    // The human-facing ticket number is only on the conversation itself. A miss
    // here costs the reference chip on the confirmation screen, nothing more.
    let reference = ''
    if (conversationId) {
      try {
        const created = await mailboxFetch<{ number?: number }>('/conversations/' + conversationId)
        if (created?.number) reference = 'EUL-' + created.number
      }
      catch {
        reference = ''
      }
    }

    return { reference }
  }
  catch {
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }
})
