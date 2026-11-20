// What the Music tab offers and may claim, per backend and per model.
//
// #108 was a page of cloud facts printed at a local user: the tab
// said the model writes its own lyrics while hiding the lyrics box, the how-to
// described a box that was not there, promised other downloadable music
// models, and said the length slider "bills per second" on a machine where
// nothing is billed. The copy lives here so those claims can be asserted
// instead of eyeballed.
//
// In the cloud the answer comes from the model itself (the web twin is
// the web app). The classic music models take a
// length in seconds and bill by it. A Studio music model carries its own
// schema: one has a length field in milliseconds, the others have none at all,
// and for two of them the prompt field is the lyrics. The tab shows a control
// only where the run reads it, and sets exactly the field the run sends.

import { STUDIO_MODELS, studioFields } from './studio-contract'
import { cloudModelById } from '../../stores/cloudCatalogStore'
import { improveKindForIntent, type ImproveKind } from './improve-prompt'

export type CreateBackendKind = 'local' | 'cloud'

export interface MusicText {
  /** What the big text field carries: a description of the track, or the words
   *  the model sings. A Studio model says so itself (`promptField`). */
  main: 'style' | 'lyrics'
  /** The other text, where the model reads one. `option` names the Studio
   *  option that carries it. Unset means the lyrics box of the store, which a
   *  classic cloud model gets as `params.lyrics` and every local one as
   *  `lyrics`. */
  second: null | { is: 'style' | 'lyrics'; option?: string }
}

/**
 * Local music runs an ACE-Step or a YuE2 checkpoint through buildMusicWorkflow,
 * and that builder feeds `lyrics` into the encoder for every one of them, so
 * the prompt is the style and the lyrics box is always right locally.
 */
export const LOCAL_MUSIC_TEXT: MusicText = { main: 'style', second: { is: 'lyrics' } }

/** Which text goes where for this cloud music model. A classic one offers the
 *  lyrics box only where the catalog says the endpoint has the input. */
export function musicText(model: string): MusicText {
  const studio = STUDIO_MODELS[model]
  if (!studio) return { main: 'style', second: cloudModelById(model)?.lyrics === true ? { is: 'lyrics' } : null }
  const fields = studioFields(model)
  if (studio.promptField === 'lyrics') {
    const option = ['style', 'prompt'].find((key) => fields[key]?.type === 'string')
    return { main: 'lyrics', second: option ? { is: 'style', option } : null }
  }
  return { main: 'style', second: fields.lyrics?.type === 'string' ? { is: 'lyrics', option: 'lyrics' } : null }
}

/** "Improve my prompt" for the cloud run on screen. It rewrites a description
 *  into a better description. Lyrics are the customer's own words and are sung
 *  as written, so a model whose text field is the lyrics never gets a rewrite. */
export function improveKindForRun(intent: string, model: string): ImproveKind | null {
  if (intent === 'music' && musicText(model).main === 'lyrics') return null
  return improveKindForIntent(intent)
}

export const MUSIC_PLACEHOLDER = {
  style: 'Describe the track. Genre, mood, tempo, instruments…',
  lyrics: 'Write the lyrics. [Verse] and [Chorus] markers help the model sing them…',
} as const

export interface MusicLength {
  /** The Studio option that carries the length. Unset where the length is the
   *  store's seconds: a classic cloud model (`params.duration`) and local. */
  option?: string
  /** How many units of the option make one second (1000 for milliseconds). */
  perSecond: number
  /** The slider, in seconds. */
  min: number
  max: number
  step: number
}

const STEP = 5

/** The slider of the store's seconds: every local model and the classic cloud ones. */
export const SECONDS_LENGTH: MusicLength = { perSecond: 1, min: 5, max: 240, step: STEP }

/** The length control of this cloud music model, or null where the model has
 *  no length to set. */
export function musicLength(model: string): MusicLength | null {
  const studio = STUDIO_MODELS[model]
  if (!studio) return SECONDS_LENGTH
  const fields = studioFields(model)
  const option = studio.price.durationField ?? 'duration'
  const schema = fields[option]
  if (schema?.minimum === undefined || schema.maximum === undefined) return null
  const perSecond = studio.price.unitDivisor ?? 1
  return {
    option,
    perSecond,
    min: Math.ceil(schema.minimum / perSecond / STEP) * STEP,
    max: Math.floor(schema.maximum / perSecond / STEP) * STEP,
    step: STEP,
  }
}

/** The how-to panel, as lines. First line is the heading. The cloud panel
 *  follows the model on screen (`cloud`), the local one is the same for every
 *  checkpoint. */
export function musicHowtoLines(
  backend: CreateBackendKind,
  cloud: { text: MusicText; length: MusicLength | null } = { text: LOCAL_MUSIC_TEXT, length: SECONDS_LENGTH },
): string[] {
  const lines = ['Make it sing your words']
  if (backend === 'local') {
    lines.push(
      'The prompt sets the style: comma-separated tags like slow jazz, smoky female vocals, upright bass.',
      'Structure your lines with [Verse], [Chorus] and [Bridge] markers so the model sings them. Plain lines get wrapped in a [Verse] for you.',
      'Leave the lyrics box empty for an instrumental track, and write in the language you want sung.',
      'The length slider sets the track length, up to 4 minutes. Local runs cost nothing but time.',
    )
    return lines
  }
  const { text, length } = cloud
  const second = text.second
  if (text.main === 'style') {
    lines.push('The prompt sets the style: comma-separated tags like slow jazz, smoky female vocals, upright bass.')
    lines.push(second
      ? 'Open Lyrics to write your own words. Structure them with [Verse], [Chorus] and [Bridge] markers and write in the language you want sung.'
      : 'This model writes its own lyrics from the prompt.')
    if (second && !second.option) lines.push('Plain lines get wrapped in a [Verse] for you. Leave the lyrics box empty for an instrumental track.')
  } else {
    lines.push('The prompt takes your lyrics, and the model sings them as written. Structure them with [Verse], [Chorus] and [Bridge] markers and write in the language you want sung.')
    if (second) lines.push('Open Style to set genre, mood and voice: comma-separated tags like slow jazz, smoky female vocals, upright bass.')
  }
  if (length && !length.option) lines.push('The length slider bills per second, tracks can run up to 4 minutes.')
  if (length?.option) lines.push(`The length slider sets how long the track runs, up to ${Math.floor(length.max / 60)} minutes.`)
  if (!length) lines.push('This model decides the length of the track itself.')
  return lines
}
