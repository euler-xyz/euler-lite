import { describe, expect, it } from 'vitest'
import {
  buildAnnouncementConfig,
  buildAnnouncementToken,
  parseAnnouncementItems,
} from '~/utils/announcement-config'

describe('announcement-config', () => {
  it('parses JSON array item config', () => {
    expect(parseAnnouncementItems('["First"," Second ","",42]')).toEqual(['First', 'Second'])
  })

  it('parses newline-delimited item config', () => {
    expect(parseAnnouncementItems('First\n Second \n\nThird')).toEqual(['First', 'Second', 'Third'])
  })

  it('ignores malformed JSON array item config', () => {
    expect(parseAnnouncementItems('["First",')).toEqual([])
  })

  it('disables empty announcement config', () => {
    expect(buildAnnouncementConfig({})).toEqual({
      enabled: false,
      token: '',
      title: '',
      body: '',
      items: [],
      url: '',
    })
  })

  it('enables announcement config when any content field is populated', () => {
    expect(buildAnnouncementConfig({ title: 'Hello' }).enabled).toBe(true)
    expect(buildAnnouncementConfig({ body: 'Hello' }).enabled).toBe(true)
    expect(buildAnnouncementConfig({ items: 'Hello' }).enabled).toBe(true)
    expect(buildAnnouncementConfig({ url: 'https://example.com' }).enabled).toBe(true)
  })

  it('normalizes enabled announcement content', () => {
    expect(buildAnnouncementConfig({
      title: ' Migrate positions ',
      body: ' Move positions between protocols. ',
      items: 'One\nTwo',
      url: ' https://example.com ',
    })).toEqual({
      enabled: true,
      token: JSON.stringify({
        title: 'Migrate positions',
        body: 'Move positions between protocols.',
        items: ['One', 'Two'],
        url: 'https://example.com',
      }),
      title: 'Migrate positions',
      body: 'Move positions between protocols.',
      items: ['One', 'Two'],
      url: 'https://example.com',
    })
  })

  it('changes the token when announcement content changes', () => {
    const base = {
      title: 'Migrate positions',
      body: 'Move positions between protocols.',
      items: ['One', 'Two'],
      url: '',
    }

    expect(buildAnnouncementToken(base)).not.toBe(buildAnnouncementToken({
      ...base,
      body: 'Move positions between Euler, Aave v3, and Morpho.',
    }))
    expect(buildAnnouncementToken(base)).not.toBe(buildAnnouncementToken({
      ...base,
      items: ['One', 'Two', 'Three'],
    }))
  })
})
