/**
 * What kind of file is this, read from its first bytes.
 *
 * A language model cannot open a binary, so the chat hands it a description
 * instead (lib/chat-files.ts). The most useful single line in that
 * description is the type, and the file extension is the weakest witness for
 * it: a `.bin` can be anything. The signature inside the file is checked
 * first, the extension only names what a signature cannot (a SNES ROM has no
 * magic number at all).
 *
 * Pure and synchronous: it looks at a byte window the caller already holds.
 */

interface Signature {
  /** Where the signature starts. */
  at: number
  bytes: readonly number[]
  label: string
  /** Two or three plain letters that an ordinary text can start with as well
   *  ("BMW is ...", "MZ ..."). Such a signature only counts in a file that is
   *  not text. */
  weak?: true
}

const text = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

/** The first eight bytes of the Nintendo logo, as a GBA and an NDS cartridge carry it. */
const GBA_LOGO = [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21]
/** The first eight bytes of the Nintendo logo in a Game Boy header. */
const GB_LOGO = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b]

/**
 * Ordered: the first match wins, so a container that shares its opening bytes
 * with a more specific format comes after it.
 */
const SIGNATURES: readonly Signature[] = [
  // Console ROMs first, the request that started this (Discord).
  { at: 0, bytes: [...text('NES'), 0x1a], label: 'NES ROM (iNES)' },
  { at: 4, bytes: GBA_LOGO, label: 'Game Boy Advance ROM' },
  { at: 0xc0, bytes: GBA_LOGO, label: 'Nintendo DS ROM' },
  { at: 0x104, bytes: GB_LOGO, label: 'Game Boy ROM' },
  { at: 0, bytes: [0x80, 0x37, 0x12, 0x40], label: 'Nintendo 64 ROM (big endian, .z64)' },
  { at: 0, bytes: [0x37, 0x80, 0x40, 0x12], label: 'Nintendo 64 ROM (byte swapped, .v64)' },
  { at: 0, bytes: [0x40, 0x12, 0x37, 0x80], label: 'Nintendo 64 ROM (little endian, .n64)' },
  { at: 0x100, bytes: text('SEGA'), label: 'Sega Mega Drive / Genesis ROM' },
  { at: 0x8001, bytes: text('CD001'), label: 'ISO 9660 disc image' },
  // Executables and bytecode.
  { at: 0, bytes: [0x7f, ...text('ELF')], label: 'ELF executable' },
  { at: 0, bytes: text('MZ'), label: 'Windows executable (PE)', weak: true },
  { at: 0, bytes: [0xcf, 0xfa, 0xed, 0xfe], label: 'Mach-O executable (64 bit)' },
  { at: 0, bytes: [0xce, 0xfa, 0xed, 0xfe], label: 'Mach-O executable (32 bit)' },
  { at: 0, bytes: [0x00, ...text('asm')], label: 'WebAssembly module' },
  { at: 0, bytes: [...text('dex'), 0x0a], label: 'Android DEX bytecode' },
  { at: 0, bytes: [0x1b, ...text('Lua')], label: 'Lua bytecode' },
  // Archives and containers.
  { at: 0, bytes: [...text('PK'), 0x03, 0x04], label: 'ZIP archive' },
  { at: 0, bytes: [0x1f, 0x8b], label: 'gzip archive' },
  { at: 0, bytes: [...text('7z'), 0xbc, 0xaf, 0x27, 0x1c], label: '7-Zip archive' },
  { at: 0, bytes: [...text('Rar!'), 0x1a, 0x07], label: 'RAR archive' },
  { at: 0, bytes: [0xfd, ...text('7zXZ'), 0x00], label: 'XZ archive' },
  { at: 0, bytes: text('BZh'), label: 'bzip2 archive', weak: true },
  { at: 0, bytes: [0x28, 0xb5, 0x2f, 0xfd], label: 'Zstandard archive' },
  { at: 257, bytes: text('ustar'), label: 'tar archive' },
  // Documents and data.
  { at: 0, bytes: text('%PDF'), label: 'PDF document' },
  { at: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], label: 'Microsoft Office document (legacy)' },
  { at: 0, bytes: text('SQLite format 3'), label: 'SQLite database' },
  { at: 0, bytes: text('GGUF'), label: 'GGUF model file' },
  // Media.
  { at: 0, bytes: [0x89, ...text('PNG')], label: 'PNG image' },
  { at: 0, bytes: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { at: 0, bytes: text('GIF8'), label: 'GIF image' },
  { at: 0, bytes: text('BM'), label: 'BMP image', weak: true },
  { at: 0, bytes: text('ID3'), label: 'MP3 audio', weak: true },
  { at: 0, bytes: text('OggS'), label: 'Ogg media' },
  { at: 0, bytes: text('fLaC'), label: 'FLAC audio' },
  { at: 4, bytes: text('ftyp'), label: 'MP4 / QuickTime media' },
  { at: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], label: 'Matroska / WebM media' },
  // Fonts.
  { at: 0, bytes: text('wOFF'), label: 'WOFF font' },
  { at: 0, bytes: text('wOF2'), label: 'WOFF2 font' },
  { at: 0, bytes: text('OTTO'), label: 'OpenType font', weak: true },
  { at: 0, bytes: [0x00, 0x01, 0x00, 0x00, 0x00], label: 'TrueType font' },
]

/** What an extension says about a binary whose bytes carry no signature. */
const BY_EXTENSION: Readonly<Record<string, string>> = {
  sfc: 'SNES ROM',
  smc: 'SNES ROM',
  gb: 'Game Boy ROM',
  gbc: 'Game Boy Color ROM',
  gba: 'Game Boy Advance ROM',
  nds: 'Nintendo DS ROM',
  nes: 'NES ROM',
  z64: 'Nintendo 64 ROM',
  n64: 'Nintendo 64 ROM',
  v64: 'Nintendo 64 ROM',
  md: 'Sega Mega Drive / Genesis ROM',
  gen: 'Sega Mega Drive / Genesis ROM',
  sms: 'Sega Master System ROM',
  gg: 'Sega Game Gear ROM',
  pce: 'PC Engine ROM',
  a26: 'Atari 2600 ROM',
  rom: 'ROM image',
  iso: 'Disc image',
  img: 'Disk image',
  safetensors: 'Safetensors model file',
  dll: 'Windows library',
  so: 'Shared library',
  dylib: 'macOS library',
  class: 'Java class file',
  pyc: 'Python bytecode',
  dat: 'Data file',
  sav: 'Save file',
}

function matches(bytes: Uint8Array, sig: Signature): boolean {
  if (bytes.length < sig.at + sig.bytes.length) return false
  for (let i = 0; i < sig.bytes.length; i++) {
    if (bytes[sig.at + i] !== sig.bytes[i]) return false
  }
  return true
}

/** The lowercase extension without the dot, or '' when the name has none. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** A RIFF file names its content in bytes 8 to 11. */
function riffKind(bytes: Uint8Array): string | null {
  if (!matches(bytes, { at: 0, bytes: text('RIFF'), label: '' }) || bytes.length < 12) return null
  const form = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
  if (form === 'WAVE') return 'WAV audio'
  if (form === 'AVI ') return 'AVI video'
  if (form === 'WEBP') return 'WebP image'
  return 'RIFF container'
}

/**
 * 0xCAFEBABE opens both a Java class file and a universal Mach-O binary. The
 * next four bytes tell them apart: a class file carries its version there
 * (45 and up), a universal binary the number of architectures (a handful).
 */
function cafeBabeKind(bytes: Uint8Array): string | null {
  if (!matches(bytes, { at: 0, bytes: [0xca, 0xfe, 0xba, 0xbe], label: '' }) || bytes.length < 8) return null
  const next = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]
  return next >= 45 ? 'Java class file' : 'Mach-O universal binary'
}

/** A ZIP is also the shell of every modern Office file and of a few others. */
function zipKind(extension: string): string {
  const inner: Record<string, string> = {
    docx: 'Word document (.docx)',
    xlsx: 'Excel workbook (.xlsx)',
    pptx: 'PowerPoint presentation (.pptx)',
    odt: 'OpenDocument text',
    epub: 'EPUB book',
    jar: 'Java archive (.jar)',
    apk: 'Android package (.apk)',
  }
  return inner[extension] ?? 'ZIP archive'
}

/**
 * True when this window reads as text: valid UTF-8 without control bytes that
 * no text file carries. A window that ends in the middle of a multi-byte
 * character is still text, so the last few bytes may be an open sequence.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false
  for (const b of bytes) {
    // Tab, line feed, form feed, carriage return and escape are fine.
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

export interface FileKind {
  /** A short name a person recognises, for the chip and for the model. */
  label: string
  /** True when the content can be shown as text instead of as a hex dump. */
  isText: boolean
}

/**
 * The type of a file from the first bytes of it (give it at least the first
 * 33 KiB when the file is that long, the ISO 9660 signature sits at 0x8001)
 * and its name.
 */
export function detectFileKind(head: Uint8Array, name: string): FileKind {
  const extension = fileExtension(name)
  const special = riffKind(head) ?? cafeBabeKind(head)
  if (special) return { label: special, isText: false }
  const isText = looksLikeText(head)
  for (const sig of SIGNATURES) {
    if ((sig.weak && isText) || !matches(head, sig)) continue
    return { label: sig.label === 'ZIP archive' ? zipKind(extension) : sig.label, isText: false }
  }
  if (isText) return { label: extension ? `Text file (.${extension})` : 'Text file', isText: true }
  return { label: BY_EXTENSION[extension] ?? (extension ? `Binary file (.${extension})` : 'Binary file'), isText: false }
}
