// Regression guard for #108: the local Music tab printed cloud
// facts. It hid the lyrics box while claiming the model writes its own lyrics,
// described a box that was not on screen, implied other music models were
// downloadable, and said the length slider bills per second on a machine where
// nothing is billed.
//
// And for the cloud panel (findings M1 and M2, 2026-10-05): it follows the
// model on screen, so it never describes a lyrics box or a length slider that
// model does not have.
import { describe, it, expect, beforeEach } from 'vitest'
import { LOCAL_MUSIC_TEXT, SECONDS_LENGTH, musicHowtoLines, musicLength, musicText } from '../music-ui'
import { useCloudCatalogStore } from '../../../stores/cloudCatalogStore'
import { neuerServer } from './fixtures/test-catalogs'

beforeEach(() => { useCloudCatalogStore.setState({ models: neuerServer() }) })

const cloudLines = (model: string) =>
  musicHowtoLines('cloud', { text: musicText(model), length: musicLength(model) })

describe('local music', () => {
  it('always offers the lyrics box, because every local checkpoint takes lyrics', () => {
    expect(LOCAL_MUSIC_TEXT).toEqual({ main: 'style', second: { is: 'lyrics' } })
    expect(SECONDS_LENGTH).toMatchObject({ min: 5, max: 240, perSecond: 1 })
    expect(SECONDS_LENGTH.option).toBeUndefined()
  })
})

describe('musicHowtoLines', () => {
  const local = musicHowtoLines('local').join('\n').toLowerCase()
  const cloud = cloudLines('ace-step-1.5').join('\n').toLowerCase()

  it('never talks about billing on the local tab', () => {
    expect(local).not.toContain('bill')
    expect(cloud).toContain('bills per second')
  })

  it('never promises other music models on the local tab, where there is one', () => {
    expect(local).not.toContain('other music models')
    expect(local).not.toContain('this model writes its own lyrics')
  })

  it('only describes the lyrics box where the box exists', () => {
    // Locally the box is always there, so mentioning it is fair.
    expect(local).toContain('lyrics box')
    expect(cloud).toContain('lyrics box')
    for (const model of ['ace-step', 'eleven-music', 'mureka-song', 'minimax-music']) {
      expect(cloudLines(model).join('\n').toLowerCase(), model).not.toContain('lyrics box')
    }
  })

  it('keeps the advice that actually applies to both, the tags and the markers', () => {
    for (const text of [local, cloud]) {
      expect(text).toContain('comma-separated tags')
      expect(text).toContain('[verse]')
    }
  })

  it('leads with the heading and stays a short panel', () => {
    expect(musicHowtoLines('local')[0]).toBe('Make it sing your words')
    expect(musicHowtoLines('local').length).toBe(5)
    expect(cloudLines('ace-step-1.5')[0]).toBe('Make it sing your words')
    expect(cloudLines('ace-step-1.5').length).toBe(5)
  })

  it('the cloud panel says what the model on screen does with the prompt and the length', () => {
    expect(cloudLines('mureka-song')).toEqual([
      'Make it sing your words',
      'The prompt takes your lyrics, and the model sings them as written. Structure them with [Verse], [Chorus] and [Bridge] markers and write in the language you want sung.',
      'Open Style to set genre, mood and voice: comma-separated tags like slow jazz, smoky female vocals, upright bass.',
      'This model decides the length of the track itself.',
    ])
    expect(cloudLines('eleven-music')).toEqual([
      'Make it sing your words',
      'The prompt sets the style: comma-separated tags like slow jazz, smoky female vocals, upright bass.',
      'This model writes its own lyrics from the prompt.',
      'The length slider sets how long the track runs, up to 10 minutes.',
    ])
    expect(cloudLines('minimax-music')[2]).toBe(
      'Open Lyrics to write your own words. Structure them with [Verse], [Chorus] and [Bridge] markers and write in the language you want sung.',
    )
  })
})
