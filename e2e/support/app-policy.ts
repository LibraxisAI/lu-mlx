import { readFileSync } from 'node:fs'
import { expect, type Page } from '@playwright/test'

/**
 * The dev server of this suite sends no Content-Security-Policy, the packaged
 * app does (src-tauri/tauri.conf.json). A test about what the webview may
 * load puts the deciding directives of that policy on the page, or it passes
 * for the wrong reason. Only single directives: the whole policy would refuse
 * the inline scripts of the dev server.
 */
export type PolicyDirective = 'connect-src' | 'media-src'

export function appPolicyDirective(name: PolicyDirective): string {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')) as { app: { security: { csp: string } } }
  const directive = conf.app.security.csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `))
  if (!directive) throw new Error(`tauri.conf.json has no ${name}`)
  return directive
}

/** Call before page.goto('/'). */
export async function serveWithAppPolicy(page: Page, names: PolicyDirective[] = ['connect-src']): Promise<void> {
  const policy = names.map(appPolicyDirective)
  // The part that decides here: the app does not let fetch() read a data: URL.
  expect(appPolicyDirective('connect-src')).not.toMatch(/\sdata:/)
  await page.route((url) => url.pathname === '/', async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy.join('; ') } })
  })
}

/** The policy is really on the page: it refuses a data: URL as the app does. */
export async function expectDataFetchRefused(page: Page): Promise<void> {
  expect(await page.evaluate(() => fetch('data:text/plain,x').then(() => 'read', () => 'refused'))).toBe('refused')
}
