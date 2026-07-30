import { createError, getQuery, setResponseHeader } from 'h3'
import { docsFetch, helpScoutConfig } from '~/server/utils/helpscout'
import { createRateLimiter } from '~/server/utils/rate-limit'

const rateLimiter = createRateLimiter({ max: 120, windowMs: 60_000, label: 'support-docs' })

interface DocsSearchResponse {
  articles: {
    items: { id: string, name: string, preview: string, collectionId?: string }[]
  }
}

interface DocsArticleResponse {
  article: { id: string, name: string, text: string }
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const query = getQuery(event)
  const { docsKey, collectionId } = helpScoutConfig()

  // Search is unavailable rather than broken when the key is absent, so the
  // panel can still be used to open a ticket.
  if (!docsKey) throw createError({ statusCode: 503, statusMessage: 'Docs search is not configured' })

  // Single-article mode — used when the panel opens an article from a result row.
  if (typeof query.id === 'string' && query.id) {
    if (!/^[\w-]{1,40}$/.test(query.id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid article id' })
    }
    try {
      const data = await docsFetch<DocsArticleResponse>('/articles/' + encodeURIComponent(query.id))
      setResponseHeader(event, 'Cache-Control', 'private, max-age=300')
      return { id: data.article.id, name: data.article.name, preview: '', text: data.article.text }
    }
    catch {
      throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
    }
  }

  const term = typeof query.q === 'string' ? query.q.trim() : ''
  if (term.length < 2) return []
  if (term.length > 120) throw createError({ statusCode: 400, statusMessage: 'Query too long' })

  try {
    const data = await docsFetch<DocsSearchResponse>('/search/articles', {
      query: term,
      collectionId,
      status: 'published',
      pageSize: '8',
    })
    setResponseHeader(event, 'Cache-Control', 'private, max-age=60')
    return data.articles.items.map(item => ({
      id: item.id,
      name: item.name,
      preview: item.preview,
    }))
  }
  catch {
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }
})
