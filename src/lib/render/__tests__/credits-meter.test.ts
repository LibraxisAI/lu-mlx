/**
 * The desktop credits chip, and the Create button that shares its rule.
 *
 * The desktop meter read only `remaining.credits` while the server had been
 * sending `video`, `trainings` and `topup` for a long time. Two things
 * followed: a user who had spent their monthly character trainings saw a
 * healthy green bar and an enabled Create button, then got a 429; and the chip
 * could never say "about N more like it", which is the one number a person
 * actually wants from a meter.
 *
 * These lock the three rules that are easy to get backwards: an ABSENT field
 * means uncapped and must never gate, the top-up wallet is exempt from the
 * video sub-budget and therefore extends it, and the sub-budget is named only
 * when it really binds.
 *
 * Run: npx vitest run src/lib/render/__tests__/credits-meter.test.ts
 */
import { describe, it, expect } from 'vitest'
import { meterState, drawsVideoBudget } from '../credits-meter'
import type { CloudQuota } from '../cloud-jobs'

/** Hosted as it stands after the 2026-08-05 lift: video limit equals the pool. */
function hosted(over: Partial<CloudQuota> = {}): CloudQuota {
  return {
    tier: 'hosted',
    period: '2026-08-05',
    limits: { credits: 900_000 },
    costs: { image: 300, video: 15_000 },
    used: { credits_used: 0 },
    remaining: { credits: 900_000 },
    topup: { credits: 0 },
    video: { limit: 900_000, used: 0, remaining: 900_000 },
    trainings: { limit: 2, used: 0, remaining: 2 },
    ...over,
  }
}

describe('drawsVideoBudget', () => {
  it('counts real video renders and never a training', () => {
    expect(drawsVideoBudget('video', 'generate')).toBe(true)
    expect(drawsVideoBudget('video', 'animate')).toBe(true)
    expect(drawsVideoBudget('video', 'lora-train')).toBe(false)
    expect(drawsVideoBudget('image', 'generate')).toBe(false)
    expect(drawsVideoBudget('audio', 'music')).toBe(false)
  })
})

describe('with the video cap lifted (the shipping shape)', () => {
  it('does not name a sub-budget that equals the pool', () => {
    // Quoting "900000 of 900000 credits left" would advertise a limit the
    // pricing page says we do not have.
    const s = meterState(hosted(), 40_000, 'video', 'generate')
    expect(s).toMatchObject({ kind: 'ok', showVideoBudget: false, runsLeft: 22, unit: 'clips' })
  })

  it('counts images off the whole pool', () => {
    expect(meterState(hosted(), 300, 'image', 'generate')).toMatchObject({
      kind: 'ok', runsLeft: 3000, unit: 'images',
    })
  })
})

describe('with a real cap back in place', () => {
  it('binds the count and names the budget', () => {
    // Exactly the old 300k Hosted shape. Lowering one number brings the whole
    // behaviour back, which is why the branch is derived and not deleted.
    const s = meterState(
      hosted({ video: { limit: 300_000, used: 0, remaining: 300_000 } }),
      40_000, 'video', 'generate',
    )
    expect(s).toMatchObject({ kind: 'ok', showVideoBudget: true, runsLeft: 7 })
  })

  it('refuses the clip once the sub-budget cannot cover it', () => {
    expect(
      meterState(
        hosted({ video: { limit: 300_000, used: 290_000, remaining: 10_000 } }),
        40_000, 'video', 'generate',
      ),
    ).toEqual({ kind: 'no-video-budget' })
  })
})

describe('the top-up wallet is exempt from the video sub-budget', () => {
  it('funds a clip even when the monthly video room is spent', () => {
    // The dialog and the 429 body both promise this. Gating on the monthly
    // figure alone would refuse a clip the server would happily run.
    const s = meterState(
      hosted({
        remaining: { credits: 100_000 },
        topup: { credits: 100_000 },
        video: { limit: 900_000, used: 900_000, remaining: 0 },
      }),
      40_000, 'video', 'generate',
    )
    expect(s).toMatchObject({ kind: 'ok', runsLeft: 2 })
  })
})

describe('character trainings use included runs or paid credits', () => {
  it('lets a credit-only buyer train without any included runs', () => {
    const q = hosted({
      remaining: { credits: 450_000 },
      topup: { credits: 450_000 },
      trainings: { limit: 0, used: 0, remaining: 0 },
    })
    expect(meterState(q, 100_000, 'image', 'lora-train')).toMatchObject({ kind: 'ok', runsLeft: 4 })
  })

  it('requires enough paid credits for the complete selected trainer', () => {
    const q = hosted({
      topup: { credits: 100_000 },
      trainings: { limit: 2, used: 2, remaining: 0 },
    })
    expect(meterState(q, 100_000, 'image', 'lora-train')).toMatchObject({ kind: 'ok' })
    expect(meterState(q, 125_000, 'image', 'lora-train')).toEqual({ kind: 'no-trainings' })
  })

  it('refuses the training when the monthly count is spent', () => {
    const q = hosted({ trainings: { limit: 2, used: 2, remaining: 0 } })
    expect(meterState(q, 100_000, 'image', 'lora-train')).toEqual({ kind: 'no-trainings' })
  })

  it('still lets an ordinary image through on the same quota', () => {
    // The count gates trainings only. Blocking the whole surface would be the
    // obvious over-correction.
    const q = hosted({ trainings: { limit: 2, used: 2, remaining: 0 } })
    expect(meterState(q, 300, 'image', 'generate')).toMatchObject({ kind: 'ok' })
  })

  it('counts down by the remaining trainings, not by what the credits allow', () => {
    // 900k credits buy 9 runs at 100k, but the plan allows 2.
    const s = meterState(hosted(), 100_000, 'image', 'lora-train')
    expect(s).toMatchObject({ kind: 'ok', runsLeft: 2, unit: 'trainings' })
  })
})

// B6 (review-a1.md): the two new trainingPackRun cases proved the branch
// exists, but left three gaps the review named by name. These three close
// them without touching meterState itself, which is why the two existing
// cases above still pass unchanged.
describe('B6: der gemischte Fall aus Monatsraum und Pack-Wallet', () => {
  it('9 Trainings, wenn beide Quellen zusammen neun Laeufe decken', () => {
    // Hosted-Pool 900k plus ein 450k-Pack, beide Trainings des Plans schon
    // verbraucht, ein Training kostet 150k: (900k + 450k) / 150k = 9. Das ist
    // genau die Zahl aus B4, die vor diesem Test nirgends festgenagelt war.
    const q = hosted({
      remaining: { credits: 1_350_000 },
      topup: { credits: 450_000 },
      trainings: { limit: 2, used: 2, remaining: 0 },
    })
    expect(meterState(q, 150_000, 'image', 'lora-train')).toMatchObject({
      kind: 'ok', runsLeft: 9, unit: 'trainings',
    })
  })
})

describe('B6: die starter-Form der Quota (kein Plan, nur Wallet)', () => {
  it('ein reiner Pack-Kaeufer ohne Plan-Trainings kann trotzdem trainieren', () => {
    // starter traegt trainings.limit 0 und video.limit 0 (so steht es
    // auf dem Server): kein Monatsraum
    // fuer eins von beiden, nur die Wallet. Der bestehende Test oben pruefte
    // das nur an der hosted-Form, wo ein Monatsraum existiert.
    const starter: CloudQuota = {
      tier: 'starter',
      period: '2026-09-01',
      limits: { credits: 450_000 },
      costs: { image: 300, video: 15_000 },
      used: { credits_used: 0 },
      remaining: { credits: 450_000 },
      topup: { credits: 450_000 },
      video: { limit: 0, used: 0, remaining: 0 },
      trainings: { limit: 0, used: 0, remaining: 0 },
    }
    expect(meterState(starter, 100_000, 'image', 'lora-train')).toMatchObject({
      kind: 'ok', runsLeft: 4, unit: 'trainings',
    })
  })

  it('GEGENPROBE: eine leere Wallet lehnt trotz gekauftem Nullplan ab', () => {
    const starter: CloudQuota = {
      tier: 'starter',
      period: '2026-09-01',
      limits: { credits: 0 },
      costs: { image: 300, video: 15_000 },
      used: { credits_used: 0 },
      remaining: { credits: 0 },
      topup: { credits: 0 },
      video: { limit: 0, used: 0, remaining: 0 },
      trainings: { limit: 0, used: 0, remaining: 0 },
    }
    expect(meterState(starter, 100_000, 'image', 'lora-train')).toEqual({
      kind: 'insufficient', remaining: 0, cost: 100_000,
    })
  })
})

describe('B6: Gegenprobe, der Video-Unterdeckel bleibt von trainingPackRun unberuehrt', () => {
  it('ein Pack, gross genug fuer ein Training, oeffnet nicht den Video-Unterdeckel', () => {
    // trainingPackRun greift nur bei isTraining (op === 'lora-train'). Die
    // Wallet reicht fuer das 20k-Training, aber nicht fuer den 40k-Videoclip:
    // ein Video-Render mit derselben Wallet muss weiterhin am eigenen
    // Unterdeckel scheitern, sonst haette das Zusammenlegen beider Zweige in
    // einer Funktion den Video-Deckel mit durchlaessig gemacht.
    const q = hosted({
      remaining: { credits: 50_000 },
      topup: { credits: 30_000 },
      video: { limit: 900_000, used: 900_000, remaining: 0 },
    })
    expect(meterState(q, 40_000, 'video', 'generate')).toEqual({ kind: 'no-video-budget' })
  })

  it('dieselbe Wallet, als guenstigeres Training statt Video, laesst den Lauf durch', () => {
    // Gegenstueck zum Test daneben: derselbe Kontostand, nur der Zweig und die
    // Kosten wechseln. Das zeigt, dass die beiden Deckel wirklich getrennt
    // bleiben, nicht dass einer von beiden immer sperrt oder immer durchlaesst.
    const q = hosted({
      remaining: { credits: 50_000 },
      topup: { credits: 30_000 },
      trainings: { limit: 2, used: 2, remaining: 0 },
    })
    expect(meterState(q, 20_000, 'image', 'lora-train')).toMatchObject({ kind: 'ok' })
  })
})

describe('an older server never gates', () => {
  it('treats absent video and training fields as uncapped', () => {
    // A pre-0029 server sends neither. Reading a missing field as zero would
    // lock every training and every clip out of the app.
    const bare: CloudQuota = {
      tier: 'hosted',
      period: '2026-08-05',
      limits: { credits: 900_000 },
      costs: { image: 300, video: 15_000 },
      used: { credits_used: 0 },
      remaining: { credits: 900_000 },
    }
    expect(meterState(bare, 100_000, 'image', 'lora-train')).toMatchObject({ kind: 'ok' })
    expect(meterState(bare, 40_000, 'video', 'generate')).toMatchObject({
      kind: 'ok', showVideoBudget: false,
    })
  })
})

describe('the balance itself', () => {
  it('reports insufficient with the numbers the chip prints', () => {
    const q = hosted({ remaining: { credits: 100 } })
    expect(meterState(q, 300, 'image', 'generate')).toEqual({
      kind: 'insufficient', remaining: 100, cost: 300,
    })
  })

  it('claims no count while the run cost is still unknown', () => {
    // costs are 0 until the catalogue loads. floor(pool / 0) is Infinity, and
    // "≈Infinity images" is worse than showing the balance alone.
    expect(meterState(hosted(), 0, 'image', 'generate')).toMatchObject({
      kind: 'ok', runsLeft: null,
    })
  })

  it('uses the singular when exactly one run is left', () => {
    const q = hosted({ remaining: { credits: 40_000 } })
    expect(meterState(q, 40_000, 'video', 'generate')).toMatchObject({
      runsLeft: 1, unit: 'clip',
    })
  })

  it('fills the bar from the plan limit and clamps it', () => {
    expect(meterState(hosted(), 300, 'image', 'generate')).toMatchObject({ pct: 1 })
    const half = hosted({ remaining: { credits: 450_000 } })
    expect(meterState(half, 300, 'image', 'generate')).toMatchObject({ pct: 0.5 })
    // A bonus grant can push remaining past the plan limit; the bar stops at 1.
    const over = hosted({ remaining: { credits: 1_800_000 } })
    expect(meterState(over, 300, 'image', 'generate')).toMatchObject({ pct: 1 })
  })
})
