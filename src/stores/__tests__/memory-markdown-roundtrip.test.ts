/**
 * R2-25 (Logikkontrolle) / J (3.0.1-Liste): the Markdown export/import round
 * trip lost everything past a memory's first line, the rest of a multi-line
 * content, the source and the date, because the importer reads the export
 * one physical line at a time and a real line break inside `entry.content`
 * split ONE list item across several lines. See the comment on
 * `escapeMdContent` in `../memoryStore.ts` for the full mechanism.
 *
 * Run: npx vitest run src/stores/__tests__/memory-markdown-roundtrip.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useMemoryStore } from '../memoryStore'

function reset() {
  useMemoryStore.setState({
    entries: [], localEntries: [], accountCollections: {},
    memorySyncBaselines: {}, memorySyncPending: {}, activeMemoryOwner: null,
    memoryCollectionRevision: 0, lastSynced: 0,
  })
}

describe('memory markdown round trip: multi-line content', () => {
  beforeEach(reset)

  it('a multi-line content survives export + import unchanged, with source and date', () => {
    const multiline = 'Erste Zeile.\nZweite Zeile mit Details.\nDritte Zeile, Abschluss.'
    useMemoryStore.getState().addMemory({
      type: 'project',
      title: 'Mehrzeiliger Eintrag',
      description: multiline.slice(0, 120),
      content: multiline,
      tags: ['t1'],
      source: 'unit-test',
    })

    const md = useMemoryStore.getState().exportAsMarkdown()
    reset()
    const result = useMemoryStore.getState().importFromMarkdown(md)

    expect(result.added).toBe(1)
    const back = useMemoryStore.getState().entries[0]
    expect(back.content).toBe(multiline)
    expect(back.title).toBe('Mehrzeiliger Eintrag')
    expect(back.source).toBe('unit-test')
    // The date round-trips too, a lost date falls back to "now" (today),
    // which a same-day test cannot tell apart from a real bug. Assert the
    // export actually carries a source/date suffix on the item's own line
    // instead, which is the thing that was silently dropped before the fix.
    expect(md).toMatch(/\*\(unit-test\)\*, \d{4}-\d{2}-\d{2}/)
  })

  it('a content with a literal backslash-n survives too, not mistaken for a line break', () => {
    const literal = 'the path is C:\\nope\\here'
    useMemoryStore.getState().addMemory({
      type: 'project', title: 'Backslash', description: literal, content: literal,
      tags: [], source: 'unit-test',
    })
    const md = useMemoryStore.getState().exportAsMarkdown()
    reset()
    useMemoryStore.getState().importFromMarkdown(md)
    expect(useMemoryStore.getState().entries[0].content).toBe(literal)
  })

  it('the export is exactly one physical line per entry, even for multi-line content', () => {
    const multiline = 'a\nb\nc'
    useMemoryStore.getState().addMemory({
      type: 'user', title: 'Line count', description: multiline, content: multiline,
      tags: [], source: 'unit-test',
    })
    const md = useMemoryStore.getState().exportAsMarkdown()
    const itemLines = md.split('\n').filter((l) => l.startsWith('- '))
    expect(itemLines).toHaveLength(1)
  })
})

/**
 * Opus-Review Nachbesserung 5: `\n` alone was not the whole data-loss class.
 * A JS regex's `.` refuses every LINE TERMINATOR the spec defines, not just
 * `\n`, `\r`, U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR)
 * silently dropped the entire entry the same way `\n` used to. This is the
 * property test the review asked for: round trip a list of hostile contents
 * and require content, source, date and title all identical afterward.
 */
describe('memory markdown round trip: the whole data-loss class (Opus-Review Nachbesserung 5)', () => {
  beforeEach(reset)

  const HOSTILE_CONTENTS: Array<[string, string]> = [
    ['CRLF (Windows paste)', 'Erste Zeile.\r\nZweite Zeile.\r\nDritte Zeile.'],
    ['bare CR (old Mac paste)', 'Erste Zeile.\rZweite Zeile.'],
    ['tabs', 'Spalte1\tSpalte2\tSpalte3'],
    ['backslashes', 'C:\\Users\\alice\\Desktop\\LU'],
    ['an escape sequence already spelled out', 'the literal text is \\n not a newline'],
    ['a markdown list marker at line start', '- this looks like another item\n- and this too'],
    ['U+2028 LINE SEPARATOR', 'Erste Zeile.\u2028Zweite Zeile.'],
    ['U+2029 PARAGRAPH SEPARATOR', 'Erster Absatz.\u2029Zweiter Absatz.'],
    ['an empty line in the middle', 'Erste Zeile.\n\nDritte Zeile nach einer Leerzeile.'],
    ['a very long line', 'x'.repeat(5000)],
    ['every escape character mixed together', 'a\\b\rc\nd\u2028e\u2029f\\n\\r literal'],
  ]

  for (const [label, content] of HOSTILE_CONTENTS) {
    it(`survives: ${label}`, () => {
      useMemoryStore.getState().addMemory({
        type: 'reference', title: `Fall: ${label}`, description: content.slice(0, 120), content,
        tags: ['evil'], source: 'hostile-test',
      })
      const before = useMemoryStore.getState().entries[0]

      const md = useMemoryStore.getState().exportAsMarkdown()
      reset()
      const result = useMemoryStore.getState().importFromMarkdown(md)

      expect(result.added).toBe(1)
      const after = useMemoryStore.getState().entries[0]
      expect(after.content).toBe(content)
      expect(after.content).toBe(before.content)
      expect(after.title).toBe(before.title)
      expect(after.source).toBe(before.source)
      // The date round trips to DAY precision only (see isoTag/isoBack),
      // that is the export format, not a bug this test should flag.
      const beforeDay = new Date(before.updatedAt).toISOString().slice(0, 10)
      const afterDay = new Date(after.updatedAt).toISOString().slice(0, 10)
      expect(afterDay).toBe(beforeDay)
    })
  }
})

/**
 * Opus-Review Runde 2, Punkt 6: a data-loss class the property test above
 * does not reach, because it only ever fed CRLF as content the export then
 * escapes. Here the FILE itself gets CRLF line endings, the way a Windows
 * text editor or `git core.autocrlf` would save a Version 2 export back to
 * disk. `importFromMarkdown` splits on `markdown.split('\n')`, so every
 * physical line then carries a trailing literal `\r`; `MD_ITEM` is
 * `$`-anchored and `.` never matches `\r`, so every line refuses to match
 * and the WHOLE import comes back empty, not just the odd entry. See the
 * `\r` strip at the top of the `importFromMarkdown` loop in `../memoryStore.ts`.
 */
describe('memory markdown import: CRLF file line endings (Opus-Review Runde 2, Punkt 6)', () => {
  beforeEach(reset)

  it('a Version 2 export with every line ending turned into CRLF still imports identically', () => {
    useMemoryStore.getState().addMemory({
      type: 'project', title: 'Erster Eintrag', description: 'kurz', content: 'Inhalt eins',
      tags: ['a', 'b'], source: 'unit-test',
    })
    useMemoryStore.getState().addMemory({
      type: 'user', title: 'Zweiter Eintrag', description: 'auch kurz', content: 'Inhalt zwei\nmit zweiter Zeile',
      tags: [], source: 'unit-test',
    })
    const before = [...useMemoryStore.getState().entries].sort((a, b) => a.title.localeCompare(b.title))

    const md = useMemoryStore.getState().exportAsMarkdown()
    const crlf = md.replace(/\n/g, '\r\n')
    expect(crlf).not.toBe(md)

    reset()
    const result = useMemoryStore.getState().importFromMarkdown(crlf)

    expect(result.added).toBe(2)
    const after = [...useMemoryStore.getState().entries].sort((a, b) => a.title.localeCompare(b.title))
    expect(after).toHaveLength(2)
    expect(after.map((e) => e.title)).toEqual(before.map((e) => e.title))
    expect(after.map((e) => e.content)).toEqual(before.map((e) => e.content))
    expect(after.map((e) => e.source)).toEqual(before.map((e) => e.source))
    expect(after.map((e) => e.tags)).toEqual(before.map((e) => e.tags))
  })

  it('NEGATIVE CONTROL: an LF export with no CRLF conversion imports the same way', () => {
    // Confirms the assertions above are not accidentally tautological, the
    // CRLF file is compared against a genuine LF-only import of the same data.
    useMemoryStore.getState().addMemory({
      type: 'project', title: 'Kontrolle', description: 'kurz', content: 'unveraendert',
      tags: [], source: 'unit-test',
    })
    const md = useMemoryStore.getState().exportAsMarkdown()
    reset()
    const result = useMemoryStore.getState().importFromMarkdown(md)
    expect(result.added).toBe(1)
    expect(useMemoryStore.getState().entries[0].content).toBe('unveraendert')
  })
})

describe('memory markdown import: Rueckwaertskompatibilitaet (Opus-Review Nachbesserung 5)', () => {
  beforeEach(reset)

  it('an old export (no format marker) is read back without mutating a literal backslash-n', () => {
    // Handwritten to look exactly like a PRE-fix export: no
    // `<!-- lu-memory-format: 2 -->` marker, and the content below was never
    // escaped because escapeMdContent did not exist yet when it was written.
    const altesExport =
      '# Memory\n\n## User\n\n'
      + '- **Alter Pfad**, the path is C:\\nope\\here *(legacy-export)*, 2026-01-01\n\n'

    const result = useMemoryStore.getState().importFromMarkdown(altesExport)

    expect(result.added).toBe(1)
    const back = useMemoryStore.getState().entries[0]
    // A real fix must not silently turn this file's literal backslash-n into
    // a line break, that would be a silent mutation of a file nobody asked
    // to have rewritten, not a bug fix.
    expect(back.content).toBe('the path is C:\\nope\\here')
  })

  it('a fresh export from this build carries the format marker', () => {
    useMemoryStore.getState().addMemory({
      type: 'user', title: 'x', description: 'y', content: 'y', tags: [], source: 'unit-test',
    })
    const md = useMemoryStore.getState().exportAsMarkdown()
    expect(md).toContain('<!-- lu-memory-format: 2 -->')
  })

  it('a marked export still unescapes a real multi-line entry (the marker does not just suppress escaping)', () => {
    const multiline = 'Zeile eins.\nZeile zwei.'
    useMemoryStore.getState().addMemory({
      type: 'user', title: 'x', description: multiline, content: multiline, tags: [], source: 'unit-test',
    })
    const md = useMemoryStore.getState().exportAsMarkdown()
    reset()
    useMemoryStore.getState().importFromMarkdown(md)
    expect(useMemoryStore.getState().entries[0].content).toBe(multiline)
  })
})

// ── R5-23: a file exported by the other app must not lose tags/source/date ──
//
// the web app writes a different separator pair: a colon
// after the title and a middle dot before the date, instead of Desktop's
// comma. Desktop's own export format is unchanged (that half of R5-23 is
// Desktop's to set), but the import side now reads every separator either
// app writes, so a memory file that crossed apps once is not the one that
// gets silently truncated.
describe('memory markdown import: liest auch Webs Trenner (R5-23)', () => {
  beforeEach(reset)

  it('a line written the way Web writes it survives import with tag, source and date', () => {
    // The middle dot (·) before the date is Web's own separator,
    // written as a code point for the same house-rule reason MD_ITEM's own
    // dashes are: this is not a banned em/en dash, but no separator this
    // file matches against belongs in the source as a literal character.
    const md =
      '# Memory\n\n## User\n\n'
      + '- **Web Titel**: web content here [tag-eins, tag-zwei] *(web-export)*' + '·' + ' 2026-05-01\n\n'

    const result = useMemoryStore.getState().importFromMarkdown(md)

    expect(result.added).toBe(1)
    const back = useMemoryStore.getState().entries[0]
    expect(back.title).toBe('Web Titel')
    expect(back.content).toBe('web content here')
    expect(back.tags).toEqual(['tag-eins', 'tag-zwei'])
    expect(back.source).toBe('web-export')
  })

  it('the colon-only title separator (no source, no date) also parses', () => {
    const md = '# Memory\n\n## User\n\n- **Nur Titel**: nur Inhalt, ohne Quelle\n\n'
    const result = useMemoryStore.getState().importFromMarkdown(md)
    expect(result.added).toBe(1)
    expect(useMemoryStore.getState().entries[0].title).toBe('Nur Titel')
    expect(useMemoryStore.getState().entries[0].content).toBe('nur Inhalt, ohne Quelle')
  })

  it('NEGATIVE CONTROL: a bare comma in the content is untouched, as before', () => {
    const md = '# Memory\n\n## User\n\n- **x**, content, with a comma\n\n'
    useMemoryStore.getState().importFromMarkdown(md)
    expect(useMemoryStore.getState().entries[0].content).toBe('content, with a comma')
  })
})
