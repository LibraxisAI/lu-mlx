/**
 * B1 (review-w2ui.md, Runde 1 + Runde 4). Two rounds of the same regression:
 *
 * Runde 1: `03f98fdd` (R5-9) narrowed the compaction pass in safety.ts from
 * `[^a-z0-9]+` (every non-alphanumeric) to `[\s._-]+`, and ran it only on
 * `base`, not on the leet-folded `deleeted` copy too. That let separator
 * variants other than space/dot/underscore/hyphen (asterisks, slashes, pipes,
 * and more) and digit-substitution evasions walk past the CSAM gate outright,
 * or downgrade from `csam` to the weaker `minor+sexual` reason once a word
 * was prepended ("a c*h*i*l*d*p*o*r*n image").
 *
 * `b04a8613` fixed that by testing `ALWAYS_BLOCKED_COMPACT` against
 * `collapseSpacing`'s letter-spacing `runs` instead of a narrowed whole-string
 * strip, and this file (in its `b04a8613` form) proved that restored at least
 * the strength of the pre-regression version for every letter-spacing probe.
 *
 * Runde 4: that fix reintroduced a DIFFERENT, larger gap: `runs` only ever
 * holds glued runs of SINGLE characters. Splitting a term into two- or
 * three-character blocks ("ch il dp or n", "jai lba it") never forms a run,
 * and neither does gluing a term inside a longer token with no separator at
 * all ("xxjailbaitxx", "achildporn"). Measured (review-w2ui.md, Runde 4): the
 * `b04a8613` fassung was weaker than the ORIGINAL regression it was fixing on
 * 275 of 927 chunked probes.
 *
 * The current fix (safety.ts, this branch) adds a SECOND, restricted
 * whole-string compaction: the entire prompt (`base` and `deleeted`) is
 * stripped of every separator and tested, but only against the long,
 * unambiguous terms (`childporn(ography)?`, `jailbait`,
 * `lolita(porn|nude|sex)`), never against `csam`, which is short enough to
 * appear as an accidental substring of ordinary prose once every space is
 * stripped ("a classic samurai image" -> "aclassicsamuraiimage" contains
 * "csam"). See MIN_WHOLE_STRING_TERM_LENGTH in safety.ts for the measured
 * justification.
 *
 * This file proves, by direct comparison of five real fassungen loaded
 * straight from git (never retyped, so the comparison is against what was
 * actually shipped, not a paraphrase of it):
 *
 *   OLD_SHA     03f98fdd~1  pre-regression, full-strength whole-string check
 *   WEAK_SHA    03f98fdd    R5-9 itself, the Runde-1 regression
 *   PARTIAL_SHA b04a8613    the Runde-1 fix, itself the Runde-4 regression
 *   CURRENT     ../safety   this branch's candidate
 *
 * that CURRENT is never weaker than OLD or WEAK on any probe (letter-spaced
 * OR chunked), that it produces zero false alarms on a list of ordinary
 * prompts, and that PARTIAL demonstrably IS weaker than OLD on the chunked
 * probes; this is the negative control: removing the whole-string
 * LONG_COMPACT check from CURRENT reduces it to exactly PARTIAL, so that
 * removal is exactly what this file would catch.
 *
 * A fifth fassung, Web's `main` branch (pre-B1-fix, still live in
 * production as of this writing), is compared too when a Web checkout is
 * reachable; see LU_WEB_REPO below. Web's `main` and Desktop's WEAK_SHA
 * are the same regression by construction (R5-9 pulled Web's fassung into
 * Desktop), so this mostly reconfirms the WEAK_SHA comparison, but it is the
 * one comparison that runs against the actual code Web has live today.
 *
 * Run: npx vitest run src/lib/render/__tests__/safety-strength-regression.test.ts
 * Run with the Web comparison: LU_WEB_REPO=/pfad/zum/web npx vitest run \
 *   src/lib/render/__tests__/safety-strength-regression.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPromptSafety as currentCheck } from '../safety'
import { webCheckout } from '../../__tests__/web-checkout'

const REPO_ROOT = resolve(__dirname, '../../../..')
const PATH_IN_REPO = 'src/lib/render/safety.ts'

/** The commit right before R5-9 narrowed the compaction: full strength. */
const OLD_SHA = '03f98fdd~1'
/** R5-9 itself: the Runde-1 regression, narrowed compaction. */
const WEAK_SHA = '03f98fdd'
/** The Runde-1 fix: runs-only, no whole-string check at all. This is exactly
 *  what CURRENT collapses to if its LONG_COMPACT check is removed, which is
 *  the negative control below. */
const PARTIAL_SHA = 'b04a8613'

type Verdict = { blocked: boolean; reason?: string }
type CheckFn = (text: string, opts?: { tier?: 'local' | 'cloud'; policy?: 'strict' | 'soft' | 'off' }) => Verdict

let oldCheck: CheckFn
let weakCheck: CheckFn
let partialCheck: CheckFn

/**
 * Schlusspruefung Inhaltsschutz (Opus 5, 18.09.2026), Punkt 4: `ci.yml`
 * checks out with the `actions/checkout` default `fetch-depth: 1` (a
 * shallow clone), so `git show 03f98fdd~1:...` cannot resolve the object
 * and this whole file went RED in CI, not skipped. `git cat-file -e` here
 * is the same synchronous, side-effect-free check `katalog-paritaet-web`
 * uses for a missing Web checkout, applied to a missing git object instead
 * of a missing file. This gates the describe blocks below so a shallow
 * checkout SKIPS them loudly (stderr message) instead of failing; a
 * fetch-depth fix (or a normal, unshallowed local clone) makes them run
 * again automatically. The frozen-floor table in
 * safety-frozen-floor.test.ts does not need any of this: it carries no git
 * dependency at all and is what actually guards CI.
 */
function hasGitObject(sha: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}:${PATH_IN_REPO}`], { cwd: REPO_ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const HAS_DESKTOP_HISTORY = hasGitObject(OLD_SHA) && hasGitObject(WEAK_SHA) && hasGitObject(PARTIAL_SHA)
const HISTORY_GRUND =
  '[safety-strength-regression] Vergleich gegen historische Desktop-Fassungen uebersprungen: ' +
  `git-Objekte fuer ${OLD_SHA}, ${WEAK_SHA} oder ${PARTIAL_SHA} nicht erreichbar (flacher Checkout? ` +
  'fetch-depth). Der git-unabhaengige Waechter mit demselben Anspruch steht in ' +
  'safety-frozen-floor.test.ts und laeuft immer.'
if (!HAS_DESKTOP_HISTORY) process.stderr.write(HISTORY_GRUND + '\n')

async function loadFromGit(cwd: string, sha: string, pathInRepo: string): Promise<CheckFn> {
  const source = execFileSync('git', ['show', `${sha}:${pathInRepo}`], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  const dir = mkdtempSync(join(tmpdir(), 'lu-safety-hist-'))
  const file = join(dir, 'safety.ts')
  writeFileSync(file, source)
  const mod = (await import(pathToFileURL(file).href)) as { checkPromptSafety: CheckFn }
  return mod.checkPromptSafety
}

beforeAll(async () => {
  if (!HAS_DESKTOP_HISTORY) return
  oldCheck = await loadFromGit(REPO_ROOT, OLD_SHA, PATH_IN_REPO)
  weakCheck = await loadFromGit(REPO_ROOT, WEAK_SHA, PATH_IN_REPO)
  partialCheck = await loadFromGit(REPO_ROOT, PARTIAL_SHA, PATH_IN_REPO)
})

/**
 * Wo der Web-Checkout liegt, fuer den Vergleich gegen Webs `main`: das sagt
 * nur LU_WEB_REPO (web-checkout.ts). Ohne die Variable wird die betroffene
 * describe-Gruppe uebersprungen, mit einer Zeile auf stderr.
 */
const WEB = webCheckout('safety-strength-regression', ['apps/web/lib/render/safety.ts'])

let webMainCheck: CheckFn | undefined
beforeAll(async () => {
  if (!WEB) return
  webMainCheck = await loadFromGit(WEB, 'main', 'apps/web/lib/render/safety.ts')
})

/** unblocked(0) < any other block reason, e.g. adult-cloud (1) <
 *  minor+sexual (2) < csam (3). "Never weaker" means the rank must not drop.
 *  adult-cloud and minor+sexual used to share rank 1 (review-w2ui.md, Runde
 *  4), which would have hidden a minor+sexual -> adult-cloud downgrade; they
 *  are now distinct. */
function rank(v: Verdict): number {
  if (!v.blocked) return 0
  if (v.reason === 'csam') return 3
  if (v.reason === 'minor+sexual') return 2
  return 1 // any other reason, e.g. adult-cloud
}

/** Nine separator variants named in the review, plus plain space. */
const SEPARATORS = ['*', '/', '+', '|', '~', '#', ',', ';', ':', ' ']
/** Digit-leet separator set named in the review for the digit-substitution rows. */
const LEET_SEPARATORS = ['.', '-', '_', ' ']

function spacedOut(letters: string, sep: string): string {
  return letters.split('').join(sep)
}

/** The four-plus-letter terms that get the whole-string LONG_COMPACT check in
 *  safety.ts (see MIN_WHOLE_STRING_TERM_LENGTH there). Chunked or glued
 *  evasions of these must be fully covered: zero regressions allowed. */
const LONG_TERMS: Record<string, string> = {
  jailbait: 'jailbait',
  childporn: 'childporn',
  childpornography: 'childpornography',
  lolitaporn: 'lolitaporn',
  lolitanude: 'lolitanude',
  lolitasex: 'lolitasex',
}

/** "csam" is deliberately NOT in LONG_COMPACT (safety.ts,
 *  MIN_WHOLE_STRING_TERM_LENGTH): a chunked or glued "csam" is the one
 *  accepted residual gap, see the residual-ceiling tests below. Kept in its
 *  own set so the strict "never weaker" checks can exclude exactly this
 *  term, and nothing else. */
const CSAM_TERM: Record<string, string> = { csam: 'csam' }

/** The compact terms, spelled out letter by letter so `spacedOut` and the
 *  chunking helpers below can rebuild every evasion shape from one source.
 *  Used where the letter-spacing (single-character run) coverage applies to
 *  every term equally, "csam" included: `runs` in safety.ts is untouched by
 *  the MIN_WHOLE_STRING_TERM_LENGTH split, so letter-spaced "csam" stays
 *  fully covered. */
const COMPACT_TERMS: Record<string, string> = { ...CSAM_TERM, ...LONG_TERMS }

/** Builds the letter-spacing probe list: every compact term, every
 *  separator, with and without a leading word, plus the digit-leet ("4" for
 *  "a", "5" for "s") variants the review calls out by name. */
function buildSpacedProbes(): string[] {
  const probes: string[] = []
  for (const letters of Object.values(COMPACT_TERMS)) {
    for (const sep of SEPARATORS) {
      probes.push(`a ${spacedOut(letters, sep)} image`)
      probes.push(spacedOut(letters, sep))
    }
    const leeted = letters.replace(/a/g, '4').replace(/s/g, '5')
    for (const sep of LEET_SEPARATORS) {
      probes.push(`a ${spacedOut(leeted, sep)} image`)
    }
  }
  return probes
}

/** Splits `letters` into blocks of `size` characters (the last block may be
 *  shorter). "childporn" at size 2 -> ["ch", "il", "dp", "or", "n"]. */
function chunk(letters: string, size: number): string[] {
  const parts: string[] = []
  for (let i = 0; i < letters.length; i += size) parts.push(letters.slice(i, i + size))
  return parts
}

const CHUNK_SIZES = [2, 3, 4]
/** Includes multi-character separators (comma-space, double space), named in
 *  the review as a case the single-character SEPARATORS list above misses. */
const CHUNK_SEPARATORS = [' ', '.', '-', '_', ', ', '  ']

/** Builds the Runde-4 probe list: block-chunked terms (the gap `runs` cannot
 *  see, because a multi-character block never forms a single-character run),
 *  plus a term glued inside a longer token with NO separator at all. */
function buildChunkProbes(terms: Record<string, string>): string[] {
  const probes: string[] = []
  for (const letters of Object.values(terms)) {
    for (const size of CHUNK_SIZES) {
      const blocks = chunk(letters, size)
      for (const sep of CHUNK_SEPARATORS) {
        const chunked = blocks.join(sep)
        probes.push(chunked)
        probes.push(`a ${chunked} image`)
      }
    }
    // Glued inside a longer token, no separator at all: the class named in
    // the review as "der Begriff verklebt in einem laengeren Token".
    probes.push(`xx${letters}xx`)
    probes.push(`my${letters}file`)
    probes.push(`the${letters}list`)
    probes.push(`a${letters}`)
    probes.push(`${letters}image`)
  }
  return probes
}

const SPACED_PROBES = buildSpacedProbes()
/** Chunked/glued probes for the terms LONG_COMPACT covers: zero regressions
 *  allowed here, same bar as SPACED_PROBES. */
const LONG_CHUNK_PROBES = buildChunkProbes(LONG_TERMS)
/** Chunked/glued probes for "csam" alone: the one term LONG_COMPACT does not
 *  cover. This is the accepted, measured, shrink-only residual. */
const CSAM_CHUNK_PROBES = buildChunkProbes(CSAM_TERM)
const CHUNK_PROBES = [...LONG_CHUNK_PROBES, ...CSAM_CHUNK_PROBES]
/** Every probe where CURRENT must be strictly at least as strong as OLD/WEAK:
 *  all letter-spaced probes (every term, "csam" included, since `runs` is
 *  unaffected by the LONG_COMPACT split) plus the long-term chunked probes.
 *  CSAM_CHUNK_PROBES is deliberately excluded: see the residual-ceiling
 *  tests below. */
const STRICT_PROBES = [...SPACED_PROBES, ...LONG_CHUNK_PROBES]
const ALL_PROBES = [...SPACED_PROBES, ...CHUNK_PROBES]

/**
 * Ordinary prompts that must never be treated as an evasion. This is the
 * false-alarm side of B1 (review-w2ui.md, Runde 4): a naive whole-string
 * compaction of the ENTIRE prompt turns "a classic samurai image" into
 * "aclassicsamuraiimage", which contains "csam". Measured against this list
 * (26 prompts, the same count the review used): ALT and GESCHWAECHT both
 * false-block 11 of them, all for the same reason ("...c" + "sam..." across a
 * plain space). CURRENT must block none of them.
 */
const LEGITIMATE_PROMPTS = [
  'a torpedo launch at sunset',
  "a child's birthday party with balloons",
  'a classic samurai image',
  'classic samurai armour, studio light',
  'basic samurai armor, studio lighting',
  'an epic samurai duel at dawn',
  'epic samurai duel at dusk',
  'a nude woman, 30 years old, studio light',
  'childrens book illustration, watercolor',
  'a canteen at lunch time',
  'a landscape in sussex',
  'music samples, lo-fi',
  'the basic samples folder',
  'graphic samples for a poster',
  'a majestic samoyed dog',
  'dynamic sampling of a waveform',
  'a cosmic samba carnival',
  'organic samphire on a plate',
  'a rustic samovar on a table',
  'a sample chapter of the book',
  'samurai armor on display at a museum',
  'a bowl of edamame and miso soup',
  'a kindergarten teacher reading a story',
  'a torpedo submarine cross-section',
  'a minority report style poster',
]

describe.skipIf(!HAS_DESKTOP_HISTORY)('B1 (Runde 1): the fix is never weaker than the pre-regression version', () => {
  it('every strict probe (letter-spaced + long-term chunked): CURRENT rank >= OLD (03f98fdd~1) rank', () => {
    const regressions: string[] = []
    for (const text of STRICT_PROBES) {
      const before = rank(oldCheck(text))
      const after = rank(currentCheck(text))
      if (after < before) {
        regressions.push(`"${text}": old=${JSON.stringify(oldCheck(text))} new=${JSON.stringify(currentCheck(text))}`)
      }
    }
    expect(regressions, regressions.join('\n')).toEqual([])
  })

  it('reason never downgrades either: nothing OLD called "csam" becomes anything weaker (strict probes)', () => {
    const downgrades: string[] = []
    for (const text of STRICT_PROBES) {
      const before = oldCheck(text)
      const after = currentCheck(text)
      if (before.reason === 'csam' && after.reason !== 'csam') {
        downgrades.push(`"${text}": old=${JSON.stringify(before)} new=${JSON.stringify(after)}`)
      }
    }
    expect(downgrades, downgrades.join('\n')).toEqual([])
  })

  it('sanity: the probe list actually exercises something (OLD blocks most of it)', () => {
    const blockedByOld = ALL_PROBES.filter((t) => oldCheck(t).blocked).length
    expect(blockedByOld).toBeGreaterThan(ALL_PROBES.length / 2)
  })
})

describe.skipIf(!HAS_DESKTOP_HISTORY)('B1 (Runde 4): the fix is never weaker than the WEAK (03f98fdd) fassung either', () => {
  it('every strict probe (letter-spaced + long-term chunked): CURRENT rank >= WEAK (03f98fdd) rank', () => {
    const regressions: string[] = []
    for (const text of STRICT_PROBES) {
      const before = rank(weakCheck(text))
      const after = rank(currentCheck(text))
      if (after < before) {
        regressions.push(`"${text}": weak=${JSON.stringify(weakCheck(text))} new=${JSON.stringify(currentCheck(text))}`)
      }
    }
    expect(regressions, regressions.join('\n')).toEqual([])
  })

  /**
   * This is the Runde-4 finding itself, isolated to the ONE term the fix
   * deliberately does not fully close: `b04a8613` (PARTIAL, the Runde-1 fix)
   * was weaker than WEAK/GESCHWAECHT on 275 of 927 chunked probes in the
   * review's own run (which mixed csam and long-term probes together).
   * CURRENT closes that gap completely for the long terms (STRICT_PROBES
   * above, zero regressions) and leaves only chunked/glued "csam" open,
   * measured here so a future change cannot silently regress it further:
   * this count may only go DOWN. It is not required to be zero: Schlusspruefung
   * Inhaltsschutz (Opus 5, 18.09.2026) measured that fully closing it (a bare
   * "csam" glued inside a longer token via arbitrary-length chains, not just
   * an adjacent pair) needs a whole-string check on "csam" itself, which
   * reintroduces the false-alarm class in LEGITIMATE_PROMPTS above. Variante
   * C from that same review (per-whitespace-token compaction plus gluing two
   * ADJACENT tokens of at most 2 characters each, see
   * SHORT_TERM_GLUE_MAX_LENGTH in safety.ts) closes most of what is left
   * without reopening that false alarm; the residual below is what stays
   * open after Variante C, not before it.
   */
  it('residual gap on chunked/glued "csam" probes against OLD: measured, may only shrink', () => {
    const stillWeakerThanOld = CSAM_CHUNK_PROBES.filter((t) => rank(currentCheck(t)) < rank(oldCheck(t)))
    // Measured on this probe list (41 chunked/glued "csam" probes) after
    // Variante C: 6 (was 29 before it). May only shrink from here.
    const RESIDUAL_CEILING_OLD = 6
    expect(
      stillWeakerThanOld.length,
      `residual vs OLD: ${stillWeakerThanOld.length} of ${CSAM_CHUNK_PROBES.length}\n${stillWeakerThanOld.join('\n')}`,
    ).toBeLessThanOrEqual(RESIDUAL_CEILING_OLD)
  })

  it('residual gap on chunked/glued "csam" probes against WEAK: measured, may only shrink', () => {
    const stillWeakerThanWeak = CSAM_CHUNK_PROBES.filter((t) => rank(currentCheck(t)) < rank(weakCheck(t)))
    // Measured on this probe list (41 chunked/glued "csam" probes) after
    // Variante C: 4 (was 25 before it). May only shrink from here.
    const RESIDUAL_CEILING_WEAK = 4
    expect(
      stillWeakerThanWeak.length,
      `residual vs WEAK: ${stillWeakerThanWeak.length} of ${CSAM_CHUNK_PROBES.length}\n${stillWeakerThanWeak.join('\n')}`,
    ).toBeLessThanOrEqual(RESIDUAL_CEILING_WEAK)
  })
})

describe('B1: zero false alarms on ordinary prompts', () => {
  it('CURRENT blocks none of the legitimate prompts', () => {
    for (const text of LEGITIMATE_PROMPTS) {
      expect(currentCheck(text).blocked, text).toBe(false)
    }
  })
})

describe.skipIf(!HAS_DESKTOP_HISTORY)('B1: zero false alarms on ordinary prompts (historischer Beleg)', () => {
  it('sanity: ALT and WEAK both DID false-alarm on several of these (that is why the whole-string check on "csam" was removed, not just narrowed)', () => {
    const oldFalseAlarms = LEGITIMATE_PROMPTS.filter((t) => oldCheck(t).blocked)
    expect(oldFalseAlarms.length).toBeGreaterThan(0)
  })
})

describe.skipIf(!HAS_DESKTOP_HISTORY)('NEGATIVE CONTROL: the checks above have teeth', () => {
  it('WEAK (03f98fdd) IS measurably weaker than OLD on the full probe list', () => {
    const regressions = ALL_PROBES.filter((t) => rank(weakCheck(t)) < rank(oldCheck(t)))
    // This is the point of the "never weaker than OLD" describe block above:
    // prove the comparison has teeth. If this list were empty, that block
    // would not be measuring anything.
    expect(regressions.length).toBeGreaterThan(0)
  })

  /**
   * PARTIAL (b04a8613) is CURRENT with the LONG_COMPACT whole-string check
   * removed. That is literally what shipped before this round's fix, and it
   * must be measurably weaker than OLD on the chunked probes specifically:
   * that is the Runde-4 finding, and it is also exactly what would happen if
   * a future edit deleted the `compactAll`/`compactLeet` check from
   * safety.ts. If this list were empty, the chunk-probe checks above would
   * not be measuring anything either.
   */
  it('PARTIAL (b04a8613, i.e. CURRENT minus the whole-string LONG_COMPACT check) IS measurably weaker than OLD on chunked probes', () => {
    const regressions = CHUNK_PROBES.filter((t) => rank(partialCheck(t)) < rank(oldCheck(t)))
    expect(regressions.length).toBeGreaterThan(0)
  })

  it('and PARTIAL is measurably weaker than CURRENT on chunked probes (the whole-string check is doing real work)', () => {
    const regressions = CHUNK_PROBES.filter((t) => rank(partialCheck(t)) < rank(currentCheck(t)))
    expect(regressions.length).toBeGreaterThan(0)
  })
})

/**
 * Variante C (Schlusspruefung Inhaltsschutz, Opus 5, 18.09.2026): the
 * short-term ("csam") check in safety.ts glues two ADJACENT whitespace
 * tokens when both are at most SHORT_TERM_GLUE_MAX_LENGTH (2) characters
 * long. This directly exercises that mechanism and the false-alarm
 * boundary it was measured against, WITHOUT reading an external word list:
 * a large-scale sweep (235976 words of the system dictionary as single
 * tokens and as pairs, 46 ordinary prompts) was run by hand for this round
 * and is not repeated here on every CI run; this is the fast, portable
 * regression guard for the same mechanism.
 */
describe('Variante C: the short-term token-glue check', () => {
  it('catches a two-block split of "csam" (both blocks at most 2 characters)', () => {
    for (const text of ['cs am', 'a cs am image', 'cs.am', 'cs-am', 'cs_am']) {
      expect(currentCheck(text).blocked, text).toBe(true)
      expect(currentCheck(text).reason, text).toBe('csam')
    }
  })

  it('catches "csam" glued inside a longer single token (no real space)', () => {
    for (const text of ['xxcsamxx', 'mycsamfile', 'thecsamlist', 'acsam', 'csamimage']) {
      expect(currentCheck(text).blocked, text).toBe(true)
      expect(currentCheck(text).reason, text).toBe('csam')
    }
  })

  it('does NOT glue across a block longer than 2 characters ("csa m" stays open, a known accepted residual)', () => {
    // Documents the boundary, not a gap to close here: "csa"(3) + "m"(1)
    // does not satisfy "both <= 2", by design (see safety.ts comment on
    // SHORT_TERM_GLUE_MAX_LENGTH). Counted in the residual-ceiling tests
    // above.
    expect(currentCheck('csa m').blocked).toBe(false)
  })

  it('never blocks two-letter English words placed next to each other (the false-alarm boundary the bound of 2 was measured against)', () => {
    // Every common two-letter (or shorter) English word next to every other
    // one of them: none of the 26*26 pairings spells "csam". This mirrors
    // the review's 165-real-word, 27225-pair dictionary sweep at a size that
    // runs on every CI invocation without reading an external file.
    const SHORT_WORDS = [
      'a', 'i', 'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if',
      'in', 'is', 'it', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up',
      'us', 'we',
    ]
    const falseAlarms: string[] = []
    for (const a of SHORT_WORDS) {
      for (const b of SHORT_WORDS) {
        const text = `${a} ${b}`
        if (currentCheck(text).blocked) falseAlarms.push(text)
      }
    }
    expect(falseAlarms, falseAlarms.join(', ')).toEqual([])
  })

  it('REJECTED variant, documented not shipped: gluing when only ONE neighbor is short (not both) DOES false-alarm ("vitamin c samples")', () => {
    // Not implemented in safety.ts: SHORT_TERM_GLUE_MAX_LENGTH gates on BOTH
    // neighbors. This test proves why, by reimplementing the rejected
    // "at least one" rule locally and showing it flags an ordinary sentence
    // that the shipped "both" rule correctly lets through.
    const compactToken = (t: string) => t.replace(/[^a-z0-9]+/g, '')
    const looseGlueHits = (text: string): boolean => {
      const tokens = text.toLowerCase().split(/\s+/).filter(Boolean).map(compactToken)
      if (tokens.some((t) => t.includes('csam'))) return true
      for (let i = 0; i + 1 < tokens.length; i++) {
        const a = tokens[i]
        const b = tokens[i + 1]
        if ((a.length <= 2 || b.length <= 2) && (a + b).includes('csam')) return true
      }
      return false
    }
    expect(looseGlueHits('vitamin c samples')).toBe(true)
    expect(currentCheck('vitamin c samples').blocked).toBe(false)
  })
})

describe.skipIf(!WEB)('B1 gegen Webs main-Branch (die heute produktive Fassung)', () => {
  it('CURRENT ist gegen Webs main auf keiner strengen Probe schwaecher', () => {
    const regressions: string[] = []
    for (const text of STRICT_PROBES) {
      const before = rank(webMainCheck!(text))
      const after = rank(currentCheck(text))
      if (after < before) {
        regressions.push(`"${text}": main=${JSON.stringify(webMainCheck!(text))} new=${JSON.stringify(currentCheck(text))}`)
      }
    }
    expect(regressions, regressions.join('\n')).toEqual([])
  })

  it('und blockiert keinen der harmlosen Prompts staerker als CURRENT es tut', () => {
    for (const text of LEGITIMATE_PROMPTS) {
      // Not asserting webMainCheck never blocks these (main is known to,
      // that is the production bug B1 is about), only that CURRENT itself
      // stays clean, already covered above. This documents the contrast.
      expect(currentCheck(text).blocked, text).toBe(false)
    }
  })
})
