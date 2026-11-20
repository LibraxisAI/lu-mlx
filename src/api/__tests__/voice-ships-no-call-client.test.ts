/**
 * LU is local and private. `@pipecat-ai/websocket-transport` depends on
 * `@daily-co/daily-js`, the client of a video call service, which brings the
 * Sentry browser client and loads its call code from c.daily.co. Before this
 * test existed that code sat in the Voice chunk of every build, unused.
 *
 * Two things are held here. The package name resolves to our own small file,
 * in the tests exactly as in the build (one shared list). And a real
 * production build of the app, made with the real vite.config.ts, contains
 * no trace of the Daily client or of a Sentry client in any file it emits.
 *
 * Run: npx vitest run src/api/__tests__/voice-ships-no-call-client.test.ts
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'
import Daily from '@daily-co/daily-js'
import { WebSocketTransport } from '@pipecat-ai/websocket-transport'
import absentCallClient from '../voice-no-daily'
import { ABSENT_PACKAGES } from '../../dev/absent-packages'

const root = resolve(__dirname, '../../..')

/** What only the Daily client carries. */
const DAILY = /daily\.co|DailyIframe|call-machine/
/**
 * What only a Sentry client carries. The bare word is no use: pdf.js has
 * `canvasEntry` and `hasXfaDatasetsEntry`, the drop zone has
 * `webkitGetAsEntry`.
 */
const SENTRY = /@sentry|sentry\.io|__SENTRY__|sentry-trace|SENTRY_RELEASE|sentry_key|getCurrentHub/

describe('the Daily call client is not part of LU', () => {
  it('resolves the package to our stand-in', () => {
    expect(Daily).toBe(absentCallClient)
    expect(ABSENT_PACKAGES.some((entry) => entry.find.test('@daily-co/daily-js'))).toBe(true)
    expect(ABSENT_PACKAGES.some((entry) => entry.find.test('@daily-co/daily-js/dist/daily-esm.js'))).toBe(true)
    expect(ABSENT_PACKAGES.some((entry) => entry.find.test('@daily-co/daily-js-extra'))).toBe(false)
    for (const entry of ABSENT_PACKAGES) expect(existsSync(entry.replacement), entry.replacement).toBe(true)
  })

  it('fails loudly when a transport is built without the media manager of LU', () => {
    expect(() => new WebSocketTransport()).toThrow('The Daily call client is not part of LU')
  })

  it('uses the one list in the build, the dev server and the tests', () => {
    for (const config of ['vite.config.ts', 'vitest.config.ts']) {
      expect(readFileSync(resolve(root, config), 'utf8'), config).toContain('resolve: { alias: ABSENT_PACKAGES }')
    }
  })

  it('knows the marks of both clients in the package as it installs', () => {
    // Guards the two patterns: if they stop matching the real package, the
    // build check below would pass on anything.
    const installed = resolve(root, 'node_modules/@daily-co/daily-js/dist/daily-esm.js')
    if (!existsSync(installed)) return
    const code = readFileSync(installed, 'utf8')
    expect(DAILY.test(code)).toBe(true)
    expect(SENTRY.test(code)).toBe(true)
  })

  it('emits no file with Daily or Sentry code in a production build', async () => {
    const result = await build({
      root,
      configFile: resolve(root, 'vite.config.ts'),
      logLevel: 'silent',
      build: { write: false },
    })
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) => ('output' in entry ? entry.output : []))
    const scripts = outputs.filter((file) => /\.(m?js)$/.test(file.fileName))
    expect(scripts.length).toBeGreaterThan(20)
    const voice = scripts.find((file) => /VoiceView/.test(file.fileName))
    expect(voice, 'the Voice chunk').toBeTruthy()

    const text = (file: (typeof outputs)[number]) => (file.type === 'chunk' ? file.code : String(file.source))
    expect(scripts.filter((file) => DAILY.test(text(file))).map((file) => file.fileName)).toEqual([])
    expect(scripts.filter((file) => SENTRY.test(text(file))).map((file) => file.fileName)).toEqual([])
    // The stand-in is what the transport got instead.
    expect(scripts.some((file) => text(file).includes('The Daily call client is not part of LU'))).toBe(true)
  }, 180_000)
})
