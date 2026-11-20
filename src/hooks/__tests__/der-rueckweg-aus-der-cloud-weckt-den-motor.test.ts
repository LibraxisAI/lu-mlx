/**
 * @vitest-environment jsdom
 *
 * Fund 1 der E2E-Kampagne 3.0.0, gemessen von T3 an der installierten 3.0.0 auf
 * der Windows-Box am 11.09.2026.
 *
 * Cloud an: die App haelt Motor und Einbettung an, `16:41:34.858101Z INFO
 * engine: the LU Engine was stopped port=8127`. Cloud aus: die Einbettung auf
 * 8128 kam um 16:47:27 von selbst zurueck, der Chatmotor auf 8127 nicht, und der
 * Waehler stand auf `Select a chat model`. Zwischen 16:41:34 und 17:58:59 UTC
 * war lokaler Chat ohne jeden Hinweis nicht benutzbar, bis der Tester das Modell
 * von Hand neu waehlte.
 *
 * Zwei Ursachen, hier beide festgenagelt:
 *   1. Die Wahl. In der Cloud traegt `activeModel` den Wolkennamen. Auf dem
 *      Rueckweg faellt der durch, und was von selbst einspringt, muss
 *      `canAutoSelectChat` bestehen (mindestens 7B). Das Modell der Box hat 3B.
 *   2. Der Motor. Sein Wiederanlauf hatte EINEN Schuss je Sitzung, den der Start
 *      der App laengst verbraucht hatte; der Einbettungsserver hat keinen
 *      solchen Schuss und kam deshalb wieder.
 *
 * Run: npx vitest run src/hooks/__tests__/der-rueckweg-aus-der-cloud-weckt-den-motor.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { pickForMode } from '../../lib/active-model-mode'

const bundledEngineStatus = vi.fn(async () => ({ running: false, healthy: false, port: 8127 }))
const bundledEmbedStatus = vi.fn(async () => ({ running: false, healthy: false, port: 8128 }))
const startBundledEmbed = vi.fn(async () => ({ ok: true }))
const activateBuiltinModel = vi.fn(async () => true)

/** Das Modell der Box: 3B, also nie ein Vorschlag der App, immer eine Wahl von
 *  Hand (lib/chat-model-minimum, keine 3B-Modelle von selbst). */
const HERMES = { name: 'Hermes-3-Llama-3.2-3B.Q4_K_M', path: '/m/Hermes-3-Llama-3.2-3B.Q4_K_M.gguf', size: 1, loaded: false }
const EMBED = { name: 'nomic-embed-text-v1.5.Q4_K_M', path: '/m/nomic-embed-text-v1.5.Q4_K_M.gguf', size: 1, loaded: false }
const HERMES_ROW = `openai::${HERMES.name}`

vi.mock('../../api/backend', () => ({
  isTauri: () => true,
  isMacOS: () => true,
  isWindows: () => false,
  isLinux: () => false,
  backendCall: vi.fn(async () => null),
}))
vi.mock('../../api/comfyui', () => ({
  getInstalledImageModels: vi.fn(async () => []),
  getInstalledVideoModels: vi.fn(async () => []),
  checkComfyConnection: vi.fn(async () => false),
  readModelDiskSizes: vi.fn(async () => new Map()),
}))
vi.mock('../../api/ollama', () => ({
  listModels: vi.fn(async () => []),
  pullModel: vi.fn(),
  pullModelTauri: vi.fn(),
  deleteModel: vi.fn(),
}))
vi.mock('../../api/providers', async () => {
  const actual = await vi.importActual<typeof import('../../api/providers')>('../../api/providers')
  return { ...actual, getEnabledProviders: () => [] }
})
const listBundledModels = vi.fn(async () => [HERMES, EMBED])
vi.mock('../../api/engine', async () => {
  const actual = await vi.importActual<typeof import('../../api/engine')>('../../api/engine')
  return {
    ...actual,
    listBundledModels: (...a: unknown[]) => listBundledModels(...(a as [])),
    isManagedBuiltinActive: () => true,
    bundledEngineStatus,
    bundledEmbedStatus,
    startBundledEmbed,
    activateBuiltinModel,
  }
})

// ── Teil 1: die Wahl ueberlebt den Ausflug ──────────────────────────────────

const zeile = (name: string, provider: string) => ({ name, model: name, type: 'text', provider })
const KIMI = 'lu-cloud::llama-3.1-8b-turbo'
const FLASH = 'lu-cloud::deepseek-v4.1-flash-70b'
const KATALOG = [
  zeile(HERMES_ROW, 'openai'),
  zeile(KIMI, 'lu-cloud'),
  zeile(FLASH, 'lu-cloud'),
]
const nichts = { local: null, cloud: null }

describe('jeder Modus behaelt seine eigene Wahl', () => {
  it('Cloud an ohne Vorgeschichte: nichts ist gewaehlt, der Kopf des Katalogs springt nicht mehr ein', () => {
    // T1, Nebenfund 7: genau das stand da, `Llama 3.1 8B Turbo`, ohne dass der
    // Tester es gewaehlt hatte. Bis zum 05.10.2026 galt das beim ERSTEN
    // Eintritt als richtig. Gemessen am selben Tag: dieses Modell lehnt
    // Erwachsenen-Fiktion ab, und die Ablehnung im Verlauf uebernehmen danach
    // auch die guten Modelle. In der Cloud waehlt jetzt der Nutzer.
    const hin = pickForMode(HERMES_ROW, KATALOG, 'cloud', null, { local: HERMES_ROW, cloud: null })
    expect(hin.change).toBe(true)
    expect(hin.next).toBeNull()
  })

  it('THE FIX, Cloud an mit Vorgeschichte: die letzte Wolkenwahl, nicht der Kopf', () => {
    const hin = pickForMode(HERMES_ROW, KATALOG, 'cloud', null, { local: HERMES_ROW, cloud: FLASH })
    expect(hin.next).toBe(FLASH)
  })

  it('ohne die Wolken-Erinnerung landet der Hinweg auf keinem der beiden Cloud-Modelle', () => {
    const hin = pickForMode(HERMES_ROW, KATALOG, 'cloud', null, { local: HERMES_ROW, cloud: null })
    expect(hin.next).not.toBe(KIMI)
    expect(hin.next).not.toBe(FLASH)
  })

  it('THE FIX, Cloud aus: der Waehler steht wieder auf dem Modell von vorher', () => {
    const zurueck = pickForMode(FLASH, KATALOG, 'local', null, { local: HERMES_ROW, cloud: FLASH })
    expect(zurueck.next).toBe(HERMES_ROW)
    expect(zurueck.change).toBe(true)
  })

  it('DIE ROTE ZAHL des Rueckwegs: ohne Erinnerung genau das, was T3 gesehen hat', () => {
    // `Select a chat model` ist der Waehlertext zu `next: null`. Das einzige
    // lokale Modell der Box hat 3B und liegt unter der 7B-Grenze, also springt
    // von selbst nichts ein.
    const ohne = pickForMode(FLASH, KATALOG, 'local', null, nichts)
    expect(ohne.next).toBeNull()
  })

  it('hin und zurueck und wieder hin: keine Erinnerung ueberschreibt die andere', () => {
    const erinnert = { local: HERMES_ROW, cloud: FLASH }
    expect(pickForMode(HERMES_ROW, KATALOG, 'cloud', null, erinnert).next).toBe(FLASH)
    expect(pickForMode(FLASH, KATALOG, 'local', null, erinnert).next).toBe(HERMES_ROW)
    expect(pickForMode(HERMES_ROW, KATALOG, 'cloud', null, erinnert).next).toBe(FLASH)
  })

  it('der Auftrag des Nutzers schlaegt die Erinnerung', () => {
    // Die angeklickte Zeile im lokalen LU-Cloud-Streifen nennt ihr Modell. Sie
    // bleibt der staerkste Wunsch, sonst waere Nebenbefund 1 der R10-Messung
    // wieder da.
    const hin = pickForMode(HERMES_ROW, KATALOG, 'cloud', KIMI, { local: HERMES_ROW, cloud: FLASH })
    expect(hin.next).toBe(KIMI)
    expect(hin.usedRequest).toBe(true)
  })

  it('GEGENPFAD: war vor dem Ausflug nichts gewaehlt, kommt auch nichts zurueck', () => {
    const ohneWahl = pickForMode(null, KATALOG, 'local', null, nichts)
    expect(ohneWahl.next).toBeNull()
    expect(ohneWahl.change).toBe(false)
  })

  it('GEGENPFAD: die Erinnerung redet in eine lebende Wahl desselben Modus nicht hinein', () => {
    const liste = [...KATALOG, zeile('openai::Qwen3-14B-Q4_K_M', 'openai')]
    const laufend = pickForMode('openai::Qwen3-14B-Q4_K_M', liste, 'local', null, { local: HERMES_ROW, cloud: FLASH })
    expect(laufend.change).toBe(false)
    expect(laufend.next).toBe('openai::Qwen3-14B-Q4_K_M')
  })

  it('GEGENPFAD: ein Modell, das es nicht mehr gibt, kommt nicht zurueck', () => {
    const weg = pickForMode(FLASH, KATALOG, 'local', null, { local: 'openai::geloescht.gguf', cloud: FLASH })
    expect(weg.next).toBeNull()
  })

  it('GEGENPFAD: die leere Liste beweist nichts und aendert nichts', () => {
    const leer = pickForMode(FLASH, [], 'local', null, { local: HERMES_ROW, cloud: FLASH })
    expect(leer.change).toBe(false)
    expect(leer.next).toBe(FLASH)
  })
})

describe('die Tuer zur Wahl legt sie in die Erinnerung ihres Modus', () => {
  beforeEach(() => { vi.resetModules() })

  it('lokal schreibt lokal, Wolke schreibt Wolke, und keine loescht die andere', async () => {
    const { useModelStore } = await import('../../stores/modelStore')
    useModelStore.setState({ models: KATALOG as never, activeModel: null, lastLocalModel: null, lastCloudModel: null })
    useModelStore.getState().setActiveModel(HERMES_ROW)
    expect(useModelStore.getState().lastLocalModel).toBe(HERMES_ROW)
    expect(useModelStore.getState().lastCloudModel).toBeNull()
    useModelStore.getState().setActiveModel(FLASH)
    expect(useModelStore.getState().activeModel).toBe(FLASH)
    expect(useModelStore.getState().lastCloudModel).toBe(FLASH)
    expect(useModelStore.getState().lastLocalModel, 'die Wolke ist keine lokale Wahl').toBe(HERMES_ROW)
  })

  it('GEGENPFAD: eine Bilddatei ist in keinem Modus eine Chatwahl', async () => {
    const { useModelStore } = await import('../../stores/modelStore')
    const bild = { name: 'sd_turbo.safetensors', model: 'sd_turbo.safetensors', type: 'image', provider: 'comfyui' }
    useModelStore.setState({
      models: [...KATALOG, bild] as never,
      activeModel: null, lastLocalModel: HERMES_ROW, lastCloudModel: FLASH,
    })
    useModelStore.getState().setActiveModel('sd_turbo.safetensors')
    expect(useModelStore.getState().lastLocalModel).toBe(HERMES_ROW)
    expect(useModelStore.getState().lastCloudModel).toBe(FLASH)
  })
})

// ── Teil 2: der Motor kommt denselben Weg zurueck wie die Einbettung ────────

/** Eine frische App-Sitzung. Gibt einen Weg zurueck, in DERSELBEN Sitzung neu
 *  zu laden, so wie es der Wiederanlauf-Test der Kampagne 2.6.8 tut. */
async function appMitRunde() {
  vi.resetModules()
  const { useModels } = await import('../useModels')
  const { useModelStore } = await import('../../stores/modelStore')
  const { useSettingsStore } = await import('../../stores/settingsStore')
  const { result } = renderHook(() => useModels())
  const runde = async () => {
    await act(async () => { await result.current.fetchModels() })
    // Die Wiederanlaeufe laufen ohne await, damit die Liste nicht auf einen
    // kalten Motorstart warten muss. Diese Microtasks noch landen lassen.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
  const modus = (m: 'local' | 'cloud') => useSettingsStore.getState().updateSettings({ appMode: m })
  return { runde, modus, useModelStore }
}

beforeEach(() => {
  listBundledModels.mockReset()
  listBundledModels.mockResolvedValue([HERMES, EMBED])
  bundledEngineStatus.mockClear()
  bundledEmbedStatus.mockClear()
  startBundledEmbed.mockClear()
  activateBuiltinModel.mockClear()
})

describe('der Rueckweg aus der Cloud weckt den Motor', () => {
  it('THE FIX: nach Cloud an und wieder aus startet der Motor mit demselben Modell', async () => {
    const { runde, modus, useModelStore } = await appMitRunde()
    useModelStore.setState({ activeModel: HERMES_ROW, lastLocalModel: HERMES_ROW })
    // Der Start der App: sein Schuss ist damit verbraucht.
    await runde()
    expect(activateBuiltinModel).toHaveBeenCalledWith(HERMES_ROW)
    activateBuiltinModel.mockClear()
    bundledEngineStatus.mockClear()

    // Cloud an. Der Schalter haelt den Motor an (AppShell,
    // `offload_local_models`) und macht den Wiederanlauf wieder faellig.
    const { oweEngineResume } = await import('../../lib/engine-resume-policy')
    modus('cloud')
    oweEngineResume()
    await runde()
    expect(activateBuiltinModel, 'in der Cloud startet die App keinen lokalen Motor').not.toHaveBeenCalled()

    // Cloud aus, und die Runde, um die der Schalter bittet.
    modus('local')
    await runde()
    expect(activateBuiltinModel).toHaveBeenCalledWith(HERMES_ROW)
    expect(startBundledEmbed, 'die Einbettung kommt wie bisher mit').toHaveBeenCalledWith(EMBED.path)
  })

  it('DIE ROTE ZAHL: ohne das Faelligmachen bleibt 8127 zu, wie am 11.09. gemessen', async () => {
    const { runde, modus, useModelStore } = await appMitRunde()
    useModelStore.setState({ activeModel: HERMES_ROW, lastLocalModel: HERMES_ROW })
    await runde()
    activateBuiltinModel.mockClear()
    // Genau derselbe Weg, nur ohne `oweEngineResume` (das der Cloud-Schalter
    // ruft): der verbrauchte Schuss ist die ganze Krankheit.
    modus('cloud')
    await runde()
    modus('local')
    await runde()
    expect(activateBuiltinModel).not.toHaveBeenCalled()
    expect(startBundledEmbed, 'und genau deshalb kam nur die Einbettung zurueck').toHaveBeenCalledWith(EMBED.path)
  })

  it('GEGENPFAD: ohne gewaehltes Modell wird nichts gestartet', async () => {
    const { runde, modus, useModelStore } = await appMitRunde()
    useModelStore.setState({ activeModel: null, lastLocalModel: null })
    const { oweEngineResume } = await import('../../lib/engine-resume-policy')
    modus('cloud')
    oweEngineResume()
    await runde()
    modus('local')
    await runde()
    expect(activateBuiltinModel, 'niemand hat ein Modell gewaehlt, also startet keins').not.toHaveBeenCalled()
  })

  it('der Schuss wird in der Cloud nicht verbraucht, sonst fehlt er auf dem Rueckweg', async () => {
    const { runde, modus } = await appMitRunde()
    const { engineResumeIsOwed } = await import('../../lib/engine-resume-policy')
    modus('cloud')
    await runde()
    expect(engineResumeIsOwed(), 'eine Liste im Cloud-Modus darf den Schuss nicht wegnehmen').toBe(true)
  })
})

// ── Der Schalter und die Runde, die er ausloest ─────────────────────────────

describe('der Cloud-Schalter macht den Wiederanlauf faellig und bittet um die Runde', () => {
  it('beides steht in derselben Bewegung wie das Anhalten', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const hier = dirname(fileURLToPath(import.meta.url))
    const shell = readFileSync(resolve(hier, '../../components/layout/AppShell.tsx'), 'utf8')
    // Das Anhalten steht seit 2.5.9 hier und bleibt, wo es ist.
    expect(shell).toMatch(/backendCall\('offload_local_models'\)/)
    // Neu daneben: der Schuss wird faellig, und der Rueckweg bittet um die
    // Runde, die den Motor holt. Kein zweiter Startweg, nur derselbe Anlass.
    expect(shell).toMatch(/oweEngineResume\(\)/)
    expect(shell).toMatch(/dispatchEvent\(new CustomEvent\('lu-models-refresh'\)\)/)
  })
})
