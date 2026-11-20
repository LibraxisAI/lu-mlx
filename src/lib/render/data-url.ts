// Decoded by hand instead of fetch(dataUrl): the webview CSP's connect-src
// (rightly) has no data: entry, so fetching a data URL throws "Load failed"
// and killed every source-needing op before the upload even started.
export function dataUrlToBlob(dataUrl: string): Blob {
  // A blob:/http(s) url here means an ImageRef broke the "url is always a data
  // url" invariant. Parsing it as a data url silently yields a text blob the
  // server 415s ("unsupported image format"): fail loudly at the source.
  if (!dataUrl.startsWith('data:')) {
    throw new Error(`dataUrlToBlob expects a data: URL, got "${dataUrl.slice(0, 16)}…"`)
  }
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(5, comma)
  const data = dataUrl.slice(comma + 1)
  const mime = meta.split(';')[0] || 'application/octet-stream'
  if (meta.includes('base64')) {
    const bin = atob(data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: mime })
  }
  return new Blob([decodeURIComponent(data)], { type: mime })
}

/**
 * The bytes behind a URL the app holds for a picture or a clip.
 *
 * A `data:` URL is decoded here and never fetched, for the reason at the top
 * of this file. A render made on this machine sits in the gallery as one
 * until the next start (after that it is a `blob:` URL read back from disk),
 * so "fetch whatever the gallery holds" failed for exactly the pictures made
 * in the running session and worked for every older one.
 *
 * Every place that reads such a URL goes through here. A bare fetch() of a
 * held URL turns data-url-fetch-guard.test.ts red.
 */
export async function blobFromUrl(url: string): Promise<Blob> {
  if (url.startsWith('data:')) return dataUrlToBlob(url)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`media request failed (${res.status})`)
  return res.blob()
}
