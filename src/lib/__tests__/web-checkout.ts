/**
 * Where the web checkout is, for the guards that hold the desktop against the
 * web (catalogue, wording, marks, studio contract, safety).
 *
 * Only LU_WEB_REPO says so. The guards used to try neighbour folders as well,
 * and on a machine with an old checkout next door (lu-300-web, left on
 * release/3.0.1) they compared against a catalogue that no longer existed and
 * stayed red for weeks. A guard that picks its own counterpart proves nothing
 * about the one that ships.
 *
 * Not set: the guard is skipped and says so on stderr.
 * Set, but not a web checkout the guard can read: it fails. A path somebody
 * typed must never turn into a silent skip.
 *
 * Not a test, only the shared reader.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { vi } from 'vitest'

export function webCheckout(guard: string, needs: string[]): string | undefined {
  const set = process.env.LU_WEB_REPO?.trim()
  if (!set) {
    process.stderr.write(
      `[${guard}] skipped: LU_WEB_REPO is not set. Point it at the web checkout this build ships with to run the guard.\n`,
    )
    return undefined
  }
  const repo = resolve(set)
  const missing = needs.filter((path) => !existsSync(resolve(repo, path)))
  if (missing.length > 0) {
    throw new Error(`[${guard}] LU_WEB_REPO=${repo} is not a web checkout this guard can read. Missing: ${missing.join(', ')}`)
  }
  return repo
}

/**
 * Loads a module of the web checkout, the way the web's own tests do.
 *
 * The web marks the files a browser page must never import with the package
 * `server-only`. The desktop does not have that package, and a unit test runs
 * on the server side by nature, so the marker is answered with an empty
 * module for this one import. Nothing else is replaced: the guard compares
 * against the code the web really runs.
 */
export async function webModule<T>(repo: string, path: string): Promise<T> {
  vi.doMock('server-only', () => ({}))
  return (await import(/* @vite-ignore */ resolve(repo, path))) as T
}
