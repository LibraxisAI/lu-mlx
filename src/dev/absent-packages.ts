/**
 * Packages that a dependency imports and that LU must not ship.
 *
 * One list for the build and the dev server (`vite.config.ts`) and for the
 * unit tests (`vitest.config.ts`), so what is tested is what is built. Each
 * entry replaces the package with a small file of our own. The match is on
 * the exact package name and on any path below it.
 */
import { fileURLToPath } from 'node:url'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export const ABSENT_PACKAGES: { find: RegExp; replacement: string }[] = [
  // The Daily video call client with the Sentry client it depends on. See
  // src/api/voice-no-daily.ts.
  { find: /^@daily-co\/daily-js(\/.*)?$/, replacement: here('../api/voice-no-daily.ts') },
]
