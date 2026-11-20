/**
 * The type line of an attached file comes from its bytes, not from its name.
 *
 * Run: npx vitest run src/lib/__tests__/file-magic.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectFileKind, fileExtension, looksLikeText } from '../file-magic'

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

/** A buffer of `size` zero bytes with `bytes` written at `at`. */
function withBytes(size: number, at: number, bytes: number[]): Uint8Array {
  const out = new Uint8Array(size)
  out.set(bytes, at)
  return out
}

const GBA_LOGO = [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21]

describe('console ROMs, the request that started this', () => {
  it('reads an iNES header', () => {
    expect(detectFileKind(withBytes(64, 0, [...ascii('NES'), 0x1a]), 'whatever.bin').label).toBe('NES ROM (iNES)')
  })

  it('reads a Game Boy Advance cartridge by its logo, whatever the name says', () => {
    const rom = withBytes(512, 0, [0x2e, 0x00, 0x00, 0xea, ...GBA_LOGO])
    expect(detectFileKind(rom, 'game.bin')).toEqual({ label: 'Game Boy Advance ROM', isText: false })
  })

  it('tells a Nintendo DS cartridge from a GBA one: same logo, other place', () => {
    expect(detectFileKind(withBytes(512, 0xc0, GBA_LOGO), 'game.bin').label).toBe('Nintendo DS ROM')
  })

  it('reads a Game Boy cartridge', () => {
    const rom = withBytes(512, 0x104, [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b])
    expect(detectFileKind(rom, 'game.bin').label).toBe('Game Boy ROM')
  })

  it('reads all three byte orders of a Nintendo 64 ROM', () => {
    expect(detectFileKind(withBytes(64, 0, [0x80, 0x37, 0x12, 0x40]), 'a').label).toContain('.z64')
    expect(detectFileKind(withBytes(64, 0, [0x37, 0x80, 0x40, 0x12]), 'a').label).toContain('.v64')
    expect(detectFileKind(withBytes(64, 0, [0x40, 0x12, 0x37, 0x80]), 'a').label).toContain('.n64')
  })

  it('names a SNES ROM by its extension, because it carries no signature', () => {
    const rom = withBytes(1024, 0, [0x78, 0x18, 0xfb, 0xc2, 0x30, 0x00, 0x00, 0x9c])
    expect(detectFileKind(rom, 'zelda.sfc').label).toBe('SNES ROM')
    // Negative control: the same bytes under a name that says nothing.
    expect(detectFileKind(rom, 'zelda.xyz').label).toBe('Binary file (.xyz)')
    expect(detectFileKind(rom, 'zelda').label).toBe('Binary file')
  })
})

describe('everything else a person might drop in', () => {
  it('knows the common signatures', () => {
    const cases: [number[], string][] = [
      [[0x7f, ...ascii('ELF')], 'ELF executable'],
      [[...ascii('MZ'), 0x90, 0x00, 0x03], 'Windows executable (PE)'],
      [[0xcf, 0xfa, 0xed, 0xfe], 'Mach-O executable (64 bit)'],
      [[0x00, ...ascii('asm')], 'WebAssembly module'],
      [[0x1f, 0x8b, 0x08, 0x00], 'gzip archive'],
      [[...ascii('%PDF-1.7'), 0x0a, 0xff], 'PDF document'],
      [[...ascii('SQLite format 3'), 0x00], 'SQLite database'],
      [[0x89, ...ascii('PNG')], 'PNG image'],
      [[...ascii('GGUF'), 0x03, 0x00], 'GGUF model file'],
    ]
    for (const [bytes, label] of cases) {
      expect(detectFileKind(withBytes(64, 0, bytes), 'x.bin').label).toBe(label)
    }
  })

  it('looks inside a ZIP only as far as the name allows', () => {
    const zip = withBytes(64, 0, [...ascii('PK'), 0x03, 0x04])
    expect(detectFileKind(zip, 'report.docx').label).toBe('Word document (.docx)')
    expect(detectFileKind(zip, 'stuff.zip').label).toBe('ZIP archive')
  })

  it('reads what a RIFF container holds', () => {
    expect(detectFileKind(withBytes(64, 0, [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]), 'a').label).toBe('WAV audio')
    expect(detectFileKind(withBytes(64, 0, [...ascii('RIFF'), 0, 0, 0, 0, ...ascii('AVI ')]), 'a').label).toBe('AVI video')
  })

  it('tells a Java class from a universal Mach-O binary, which open alike', () => {
    expect(detectFileKind(withBytes(64, 0, [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]), 'a').label).toBe('Java class file')
    expect(detectFileKind(withBytes(64, 0, [0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]), 'a').label).toBe('Mach-O universal binary')
  })
})

describe('text is text, also when it starts like a signature', () => {
  it('recognises plain text and names its extension', () => {
    expect(detectFileKind(new Uint8Array(ascii('{"a": 1}\n')), 'data.json')).toEqual({ label: 'Text file (.json)', isText: true })
    expect(detectFileKind(new Uint8Array(ascii('hello\n')), 'README')).toEqual({ label: 'Text file', isText: true })
  })

  it('does not call a note that starts with "BM" or "MZ" an image or a program', () => {
    expect(detectFileKind(new Uint8Array(ascii('BMW is a car maker.\n')), 'note.txt').isText).toBe(true)
    expect(detectFileKind(new Uint8Array(ascii('MZ was here\n')), 'note.txt').isText).toBe(true)
  })

  it('a Markdown file is text, a binary .md is a Mega Drive ROM', () => {
    expect(detectFileKind(new Uint8Array(ascii('# Title\n')), 'notes.md').label).toBe('Text file (.md)')
    expect(detectFileKind(withBytes(64, 0, [0x00, 0xff, 0x00, 0xfe]), 'sonic.md').label).toBe('Sega Mega Drive / Genesis ROM')
  })

  it('accepts UTF-8 and a window that ends inside a character', () => {
    const utf8 = new TextEncoder().encode('Grüße aus Köln, 東京')
    expect(looksLikeText(utf8)).toBe(true)
    expect(looksLikeText(utf8.subarray(0, utf8.length - 1))).toBe(true)
  })

  it('refuses NUL bytes, invalid UTF-8 and the empty file', () => {
    expect(looksLikeText(new Uint8Array([0x68, 0x00, 0x69]))).toBe(false)
    expect(looksLikeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBe(false)
    expect(looksLikeText(new Uint8Array(0))).toBe(false)
  })
})

describe('fileExtension', () => {
  it('reads the last extension, lowercased, and nothing from a dotfile', () => {
    expect(fileExtension('Game.GBA')).toBe('gba')
    expect(fileExtension('archive.tar.gz')).toBe('gz')
    expect(fileExtension('C:\\roms\\mario.nes')).toBe('nes')
    expect(fileExtension('.gitignore')).toBe('')
    expect(fileExtension('Makefile')).toBe('')
  })
})
