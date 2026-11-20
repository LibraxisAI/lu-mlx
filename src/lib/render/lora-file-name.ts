/** A character's name as a file name: plain ASCII, no path parts, never
 *  empty. The same name the web app's download carries. */
export function loraFileName(name: unknown, triggerWord: unknown): string {
  const clean = (value: unknown) =>
    (typeof value === 'string' ? value : '')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._ -]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 80)
      .replace(/[.-]+$/, '')
  return `${clean(name) || clean(triggerWord) || 'character'}.safetensors`
}
