// Die Vorgaben sind eine Lehre, kein Zierrat.
//
// 19.09.2026, zwei Befunde vom Inhaber an einem Tag: ein Satz auf einem
// Tag-Modell brachte das Haus statt der Figur, und eine Stimmung auf einem
// Videomodell brachte einen Vogel, der stillsteht. Also muss an den Vorgaben
// ABLESBAR sein, was in einen Prompt gehoert: das Wort fotorealistisch beim
// Bild, und eine Bewegung beim Video.
import { describe, expect, it } from 'vitest'
import { createIdeas, promptIdeas } from '../prompt-ideas'
import { CREATE_PRESETS } from '../create-presets'

describe('Prompt-Vorgaben', () => {
  it('sagt bei jedem Bild-Set, dass fotorealistisch in den Prompt gehoert', () => {
    for (const kategorie of ['Horror', 'Character', 'Product'] as const) {
      const ideen = promptIdeas('image', kategorie)
      expect(ideen.length, kategorie).toBe(10)
      const mitWort = ideen.filter((i) => /photorealistic/.test(i.text))
      // Nicht jede einzelne: eine bewusst als Schwarzweissfilm. Aber die
      // grosse Mehrheit, damit das Wort als Muster erkennbar ist.
      expect(mitWort.length, kategorie).toBeGreaterThanOrEqual(9)
    }
  })

  it('beschreibt bei Bewegung, was sich bewegt, und nicht nur die Kamera', () => {
    const ideen = promptIdeas('animate', 'Horror')
    expect(ideen).toHaveLength(10)
    const motiv = ideen.filter((i) => /the subject/.test(i.text))
    expect(motiv.length).toBeGreaterThanOrEqual(5)
    // Und keine davon verkauft eine Stimmung als Bewegung.
    for (const i of ideen) expect(i.text, i.label).not.toMatch(/\b(mood|feels|stressed|happy|sad)\b/)
  })

  it('gibt jedem Schritt mit einem Szenenfeld Anfaenge, und den anderen keine', () => {
    for (const preset of CREATE_PRESETS) {
      for (const step of preset.steps) {
        const ideen = promptIdeas(step.role, preset.category)
        const brauchtWelche = ['image', 'animate', 'extend', 'soundtrack', 'edit'].includes(step.role)
        expect(ideen.length > 0, `${preset.id}/${step.title}`).toBe(brauchtWelche)
      }
    }
  })

  it('bietet im Create-Fenster genau das an, was die Absicht braucht', () => {
    expect(createIdeas('video').map((g) => g.label)).toEqual(['Movement'])
    expect(createIdeas('animate').map((g) => g.label)).toEqual(['Movement'])
    expect(createIdeas('music').map((g) => g.label)).toEqual(['Sound'])
    expect(createIdeas('image').map((g) => g.label)).toEqual(['Horror', 'Character', 'Product', 'Video'])
    // Wo ein Prompt keine Szene beschreibt, steht auch keine Liste.
    for (const intent of ['lipsync', 'motion', 'character', 'removebg']) {
      expect(createIdeas(intent), intent).toEqual([])
    }
  })

  it('jede Vorgabe traegt eine kurze Beschriftung und einen brauchbaren Text', () => {
    const alle = [...createIdeas('image'), ...createIdeas('video'), ...createIdeas('music')].flatMap((g) => g.ideas)
    expect(alle.length).toBeGreaterThan(40)
    for (const i of alle) {
      // Die Beschriftung muss in eine schmale Liste passen.
      expect(i.label.length, i.label).toBeLessThanOrEqual(22)
      expect(i.text.length, i.label).toBeGreaterThan(30)
    }
  })

  it('kein Eintrag einer Liste traegt denselben Namen wie ein anderer darin', () => {
    // In EINER Liste muss der Name eindeutig sein, sonst laege beim Klick der
    // falsche Text im Feld. Ueber getrennte Listen hinweg darf er sich
    // wiederholen: sie stehen nie zusammen auf dem Schirm.
    for (const intent of ['image', 'video', 'music']) {
      const namen = createIdeas(intent).flatMap((g) => g.ideas.map((i) => `${g.label}/${i.label}`))
      expect(new Set(namen).size, intent).toBe(namen.length)
    }
    for (const kategorie of ['Horror', 'Character', 'Product', 'Video']) {
      const namen = promptIdeas('image', kategorie).map((i) => i.label)
      expect(new Set(namen).size, kategorie).toBe(namen.length)
    }
  })
})
