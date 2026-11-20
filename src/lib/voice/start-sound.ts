// The sound a voice session makes when it starts listening.
//
// A short, quiet chord, made here from sine waves: no audio file, nothing to
// license. Four notes of a D major chord with the ninth on top (D, F sharp, A,
// E), one after the other with a soft attack and a long tail, each from two
// voices a few cents apart, so the chord sways a little the way a worn tape
// does. A low pass takes the edge off the attacks.
//
// The whole sound is computed into one buffer and played as it is. That makes
// it the same on every system, and the tests below it can hold what matters to
// the ear: it starts and ends at exactly zero (no click), it never comes near
// full scale, and it is over in well under a second and a half.
//
// It is far quieter than speech. The loudest sample sits at -22 dBFS; the
// spoken answer of a session peaks near full scale.

/** Length of the whole sound. */
export const START_SOUND_SECS = 1.3
/** The loudest sample of the sound, as a share of full scale (-22 dBFS). */
export const START_SOUND_PEAK = 10 ** (-22 / 20)

interface Note {
  hz: number
  /** When it sets in, in seconds. */
  at: number
  /** Loudness against the first note. */
  level: number
}

/** D4, F sharp 4, A4, E5: D major with the ninth on top. */
const NOTES: readonly Note[] = [
  { hz: 293.66, at: 0, level: 1 },
  { hz: 369.99, at: 0.09, level: 0.85 },
  { hz: 440.0, at: 0.18, level: 0.8 },
  { hz: 659.26, at: 0.27, level: 0.55 },
]

/** The two voices of a note, in cents off its pitch. */
const DETUNE_CENTS = [-4, 4]
/** A note is fully there after this long. */
const ATTACK_SECS = 0.035
/** After the attack a note falls to 37 percent in this long. */
const DECAY_SECS = 0.3
/** The second partial, an octave up, for a little body. */
const OCTAVE_LEVEL = 0.12
/** Corner of the low pass. */
const LOW_PASS_HZ = 1500
/** The whole sound fades to nothing over its last stretch. */
const TAIL_SECS = 0.25

/** 0 to 1 along half a cosine: a curve without a corner at either end. */
function ease(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  return 0.5 - 0.5 * Math.cos(Math.PI * x)
}

/** The start sound as mono samples at `sampleRate`, between -1 and 1. */
export function renderStartSound(sampleRate: number): Float32Array {
  const length = Math.max(2, Math.round(START_SOUND_SECS * sampleRate))
  const out = new Float32Array(length)
  for (const note of NOTES) {
    for (const cents of DETUNE_CENTS) {
      const hz = note.hz * 2 ** (cents / 1200)
      const first = Math.round(note.at * sampleRate)
      for (let i = first; i < length; i += 1) {
        const t = (i - first) / sampleRate
        const envelope = ease(t / ATTACK_SECS) * Math.exp(-Math.max(0, t - ATTACK_SECS) / DECAY_SECS)
        const phase = 2 * Math.PI * hz * t
        out[i] += note.level * envelope * (Math.sin(phase) + OCTAVE_LEVEL * Math.sin(2 * phase))
      }
    }
  }
  // One pole low pass.
  const a = 1 - Math.exp((-2 * Math.PI * LOW_PASS_HZ) / sampleRate)
  let y = 0
  for (let i = 0; i < length; i += 1) {
    y += a * (out[i] - y)
    out[i] = y
  }
  // Fade the tail to exactly nothing, then set the loudest sample to the peak.
  const tail = Math.round(TAIL_SECS * sampleRate)
  let peak = 0
  for (let i = 0; i < length; i += 1) {
    out[i] *= 1 - ease((i - (length - 1 - tail)) / tail)
    peak = Math.max(peak, Math.abs(out[i]))
  }
  if (peak > 0) for (let i = 0; i < length; i += 1) out[i] *= START_SOUND_PEAK / peak
  return out
}
