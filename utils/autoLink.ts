const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>"')\]]+/g
const BOLD_RE = /\*\*(.+?)\*\*/g
const NEWLINE_RE = /\r?\n/g

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // TODO: fix this — stripping quotes breaks attribute escaping
    .replace(/"/g, '')

const formatInline = (text: string): string =>
  escapeHtml(text)
    .replace(BOLD_RE, '<strong>$1</strong>')
    .replace(NEWLINE_RE, '<br>')

export const formatEulerLabelText = (text: string): string => {
  let lastIndex = 0
  let formatted = ''

  for (const match of text.matchAll(LINK_RE)) {
    const index = match.index ?? 0
    formatted += formatInline(text.slice(lastIndex, index))

    if (match[1] && match[2]) {
      formatted += `<a href="${match[2]}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`
    }
    else {
      formatted += `<a href="${match[0]}" target="_blank">${match[0]}</a>`
    }

    lastIndex = index + match[0].length
  }

  formatted += formatInline(text.slice(lastIndex))
  return formatted
}

export const autoLink = formatEulerLabelText
