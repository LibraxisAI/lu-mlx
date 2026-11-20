/**
 * GH #129, "[Bug]: token" (2026-09-11).
 *
 * Ein eigener OpenAI-kompatibler Server, ein Modell mit 256k Kontext. LU zeigte
 * "6.4K", bot keinen Fensterwaehler an, und nach dem Umbenennen des Modells auf
 * etwas mit "qwen" im Namen "25.6K" plus die Antwort "token limit exceeded" vom
 * eigenen Server.
 *
 * Die Gegenprobe unten rechnet beide Zahlen nach (sie sind kein Zufall) und
 * haelt danach fest, was stattdessen herauskommen muss.
 *
 * HIER LAEUFT KEIN SERVER. Das Netz ist gemockt; die Formen der Antworten
 * stammen aus der Dokumentation von llama.cpp, vLLM und KoboldCpp.
 *
 * Run: npx vitest run src/api/providers/__tests__/openai-context-source.test.ts
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const localFetch = vi.fn()
const localFetchStream = vi.fn()

vi.mock('../../backend', async () => {
  const actual = await vi.importActual<typeof import('../../backend')>('../../backend')
  return {
    ...actual,
    isTauri: () => false,
    localFetch: (...a: Parameters<typeof import('../../backend').localFetch>) => localFetch(...a),
    localFetchStream: (...a: Parameters<typeof import('../../backend').localFetchStream>) => localFetchStream(...a),
    ensureProxyAllowsHost: async () => {},
  }
})

import { OpenAIProvider, __clearContextCatalogForTests } from '../openai-provider'
import type { ProviderConfig, ChatStreamChunk } from '../types'
import { resolveActiveWindow, windowIsAdjustable, windowIsKnown, capIsDerivable, SOURCE_LABEL } from '../../../lib/context-source'
import { effectiveSendWindow } from '../../../lib/send-window'
import { formatContextWindow } from '../../../lib/formatters'
import { useSettingsStore } from '../../../stores/settingsStore'

/** Der Aufbau des Melders: ein eigener Server, LAN, Basis-URL OHNE /v1. */
function reporterConfig(port: number, baseSuffix = ''): ProviderConfig {
  return {
    id: 'openai', name: 'My server', enabled: true,
    baseUrl: `http://192.168.4.${port % 200}:${port}${baseSuffix}`, apiKey: '', isLocal: true,
  }
}

/** llama.cpp /props, gekuerzt. n_ctx ist das wirklich geladene Fenster. */
const PROPS_262K = {
  default_generation_settings: { id: 0, n_ctx: 262144, params: { n_predict: -1 } },
  total_slots: 1,
  model_path: '/models/my-model.gguf',
}

/** Beantwortet nur die URLs, die dieser Server wirklich kennt. */
function serveLlamaCpp(props: unknown = PROPS_262K) {
  localFetch.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/props')) {
      return new Response(JSON.stringify(props), { status: 200 })
    }
    return new Response('{"error":"not found"}', { status: 404 })
  })
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(String(localFetchStream.mock.calls[0][1].body))
}

beforeEach(() => {
  useSettingsStore.getState().updateSettings({ contextWindowByModel: {} })
  __clearContextCatalogForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
  localFetch.mockReset()
  localFetchStream.mockReset()
  useSettingsStore.getState().updateSettings({ contextWindowByModel: {} })
  __clearContextCatalogForTests()
})

describe('GH #129: woher das Fenster kommt', () => {
  it('der alte Weg erklaert die gemeldeten 6.4K und 25.6K', () => {
    // Kein Aufruf von Produktionscode mit Absicht: das hier ist die Rechnung,
    // die der Melder auf dem Schirm hatte, damit die Zahlen im Fehlerbericht
    // nachpruefbar an einer Stelle stehen.
    const guessedPlain = 8192      // guessContextFromName, letzter Boden
    const guessedQwen = 32768      // guessContextFromName, Zweig "qwen"
    const asCloud = (w: number) =>
      formatContextWindow(effectiveSendWindow({ providerId: 'openai', modelWindow: w }))
    expect(asCloud(guessedPlain)).toBe('6.4K')
    expect(asCloud(guessedQwen)).toBe('25.6K')
  })

  it('eine Basis-URL ohne /v1 wird abgefragt statt uebergangen', async () => {
    const provider = new OpenAIProvider(reporterConfig(8081))
    serveLlamaCpp()

    const got = await provider.getContextWindow('my-model')

    expect(got.tokens).toBe(262144)
    expect(got.source).toBe('probe')
    const urls = localFetch.mock.calls.map(([u]) => String(u))
    expect(urls).toContain('http://192.168.4.81:8081/props')
    // Der /v1-Weg wird trotzdem versucht, nur eben zusaetzlich abgeleitet.
    expect(urls.some((u) => u.startsWith('http://192.168.4.81:8081/v1/models/'))).toBe(true)
  })

  it('dieselbe Abfrage laeuft auch, wenn die Basis auf /v1 endet', async () => {
    const provider = new OpenAIProvider(reporterConfig(8082, '/v1'))
    serveLlamaCpp()

    const got = await provider.getContextWindow('my-model')

    expect(got.tokens).toBe(262144)
    expect(localFetch.mock.calls.map(([u]) => String(u)))
      .toContain('http://192.168.4.82:8082/props')
  })

  it('vLLM wird ueber die Modellliste erkannt', async () => {
    const provider = new OpenAIProvider(reporterConfig(8083, '/v1'))
    localFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({
          object: 'list',
          data: [{ id: 'my-model', object: 'model', owned_by: 'vllm', max_model_len: 40960 }],
        }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })

    expect((await provider.getContextWindow('my-model')).tokens).toBe(40960)
  })

  it('KoboldCpp wird ueber seinen eigenen Endpunkt erkannt', async () => {
    const provider = new OpenAIProvider(reporterConfig(8084))
    localFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/extra/true_max_context_length')) {
        return new Response(JSON.stringify({ value: 16384 }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })

    const got = await provider.getContextWindow('my-model')
    expect(got.tokens).toBe(16384)
    expect(got.source).toBe('probe')
  })

  it('antwortet niemand, bleibt es bei geraten', async () => {
    const provider = new OpenAIProvider(reporterConfig(8085))
    localFetch.mockImplementation(async () => new Response('{}', { status: 404 }))

    const got = await provider.getContextWindow('a-name-nobody-knows')
    expect(got.source).toBe('guess')
    expect(got.tokens).toBe(8192)
  })

  it('ein fremder Host im Internet wird nicht abgefragt', async () => {
    const provider = new OpenAIProvider({
      id: 'openai', name: 'Remote', enabled: true,
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', isLocal: false,
    })
    localFetch.mockImplementation(async () => new Response('{}', { status: 200 }))

    const got = await provider.getContextWindow('a-name-nobody-knows')
    expect(got.source).toBe('guess')
    expect(localFetch).not.toHaveBeenCalled()
  })

  it('die Wahl des Nutzers unter dem Fenster gilt und heisst so', async () => {
    const provider = new OpenAIProvider(reporterConfig(8086))
    serveLlamaCpp()
    useSettingsStore.getState().updateSettings({
      contextWindowByModel: { [provider.contextWindowKey('my-model')]: 32768 },
    })

    const got = await provider.getContextWindow('my-model')
    // 32768 liegt unter den 262144, mit denen dieser Server laeuft, also gilt
    // die Wahl unveraendert. Die Decke der Auswahlliste ist das Fenster.
    expect(got).toEqual({ tokens: 32768, source: 'user', modelMax: 262144 })
    // Gefragt wird trotzdem: ohne das laufende Fenster kann niemand wissen, ob
    // die Wahl darueber liegt. Bis zum 11.09.2026 stieg die Kaskade hier vor
    // der Abfrage aus, und eine zu grosse Wahl ging ungeprueft auf die Leitung.
    expect(localFetch).toHaveBeenCalled()
  })
})

describe('GH #129: wer das Fenster verstellen darf', () => {
  // R2-31: die Herkunft der Zahl steht nicht mehr in der Signatur. Sie stand
  // vier Faelle lang daneben und wurde nie gelesen; die sechs Zeilen hielten
  // denselben `localBackend` gegen zwei `source`-Werte und bekamen jedes Mal
  // dasselbe Ergebnis. Jetzt haelt der Typcheck den Rueckbau fest: wer das Feld
  // wieder hineinreicht, bekommt TS2353.
  it('ein eigenes Backend ist verstellbar, egal woher die Zahl kommt', () => {
    // Auch ein gemessenes lokales Fenster bleibt verstellbar: es ist eine
    // Obergrenze auf eigener Hardware, und Ollama, LM Studio und der LU-Motor
    // halten es seit jeher genauso.
    expect(windowIsAdjustable({ localBackend: true })).toBe(true)
  })

  it('ein fremdes, festes Fenster ist es nicht', () => {
    expect(windowIsAdjustable({ localBackend: false })).toBe(false)
  })

  it('und die Antwort haengt weiter an genau diesem einen Feld', () => {
    // Negativkontrolle zum Rueckbau: fuer beide Werte kommt dasselbe heraus
    // wie vor dem Rueckbau, samt der vier Fenster, die durch die lebende
    // Kaskade laufen.
    for (const source of ['probe', 'user', 'trained', 'guess'] as const) {
      const resolved = { tokens: 32768, source, modelMax: 0 }
      expect(resolveActiveWindow({ resolved, localBackend: true }).adjustable, source).toBe(true)
      expect(resolveActiveWindow({ resolved, localBackend: false }).adjustable, source).toBe(false)
    }
  })

  it('nur ein gemessenes oder gesetztes Fenster gilt als bekannt', () => {
    expect(windowIsKnown('probe')).toBe(true)
    expect(windowIsKnown('user')).toBe(true)
    expect(windowIsKnown('guess')).toBe(false)
  })
})

describe('GH #129: max_tokens wird nicht mehr geraten', () => {
  it('ein geratenes Fenster legt gar kein max_tokens auf die Leitung', async () => {
    const provider = new OpenAIProvider(reporterConfig(8087))
    localFetch.mockImplementation(async () => new Response('{}', { status: 404 }))
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))

    await drain(provider.chatStream('a-name-nobody-knows', [{ role: 'user', content: 'hi' }]))

    expect(sentBody()).not.toHaveProperty('max_tokens')
  })

  it('ein ausdruecklicher Wunsch des Nutzers geht trotzdem raus', async () => {
    const provider = new OpenAIProvider(reporterConfig(8088))
    localFetch.mockImplementation(async () => new Response('{}', { status: 404 }))
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))

    await drain(provider.chatStream(
      'a-name-nobody-knows',
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1024 },
    ))

    expect(sentBody().max_tokens).toBe(1024)
  })

  it('ein gemessenes Fenster bekommt weiter seinen Deckel', async () => {
    const provider = new OpenAIProvider(reporterConfig(8089))
    serveLlamaCpp({ default_generation_settings: { n_ctx: 16384 } })
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))

    await drain(provider.chatStream('my-model', [{ role: 'user', content: 'hi' }]))

    const cap = sentBody().max_tokens
    expect(typeof cap).toBe('number')
    expect(cap as number).toBeGreaterThan(0)
    expect(cap as number).toBeLessThanOrEqual(16384)
  })

  it('ein benanntes Modell aus der gepflegten Liste behaelt seinen Deckel (Bug 5)', async () => {
    // Die Ausnahme mit Namen: `KNOWN_CONTEXT` ist eine Liste exakter Ids mit
    // veroeffentlichten Fenstern, keine Teilzeichenketten-Heuristik. Sie
    // schuetzt seit dem 2026-07-11 vor der Ueberdeckelung des Upstreams, und #129
    // nimmt ihr das nicht weg.
    const provider = new OpenAIProvider({
      id: 'openai', name: 'Remote', enabled: true,
      baseUrl: 'https://api.example.com/v1', apiKey: 'sk-x', isLocal: false,
    })
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))

    const got = await provider.getContextWindow('gpt-4o')
    expect(got.guessKind).toBe('table')
    expect(capIsDerivable(got)).toBe(true)
    expect(capIsDerivable({ source: 'guess', guessKind: 'name' })).toBe(false)

    await drain(provider.chatStream('gpt-4o', [{ role: 'user', content: 'hi' }]))
    const cap = sentBody().max_tokens
    expect(typeof cap).toBe('number')
    expect(cap as number).toBeGreaterThan(0)
    expect(cap as number).toBeLessThanOrEqual(128000)
  })

  it('ein vom Nutzer gesetztes Fenster zaehlt als bekannt', async () => {
    const provider = new OpenAIProvider(reporterConfig(8090))
    localFetch.mockImplementation(async () => new Response('{}', { status: 404 }))
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))
    useSettingsStore.getState().updateSettings({
      contextWindowByModel: { [provider.contextWindowKey('a-name-nobody-knows')]: 4096 },
    })

    await drain(provider.chatStream('a-name-nobody-knows', [{ role: 'user', content: 'hi' }]))

    const cap = sentBody().max_tokens
    expect(typeof cap).toBe('number')
    expect(cap as number).toBeLessThanOrEqual(4096)
  })
})

/**
 * T4 auf der Box, 11.09.2026, Punkt 4 und N3.
 *
 * Gemessen wurde ein `lu-llama-server.exe ... --ctx-size 16384` hinter einem
 * Mitschnitt-Proxy. `/props` nannte `n_ctx` 16384, `/models` in derselben
 * Karte `meta.n_ctx` 16384 und `meta.n_ctx_train` 40960. Die App zeigte 40K
 * mit dem Etikett `from server`, bot `40K · max` an und legte
 * `"max_tokens":32768` auf die Leitung, also das Doppelte des ganzen
 * Serverfensters.
 *
 * Die Koerper unten sind aus den in T4.md zitierten Feldern nachgebaut (die
 * Rohantworten liegen nicht in T4-belege/, der Mitschnitt protokolliert nur
 * Pfade und Anfragekoerper); die Modell-Id und die 32768 stehen so im
 * Bericht.
 */
const BOX_MODEL =
  'C:\\Users\\alice\\AppData\\Roaming\\Locally Uncensored\\models\\Qwen3-4B-Q4_K_M.gguf'
const BOX_PROPS = {
  default_generation_settings: { id: 0, n_ctx: 16384, params: { n_predict: -1 } },
  total_slots: 1,
  model_path: BOX_MODEL,
}
/** Die Modellkarte, wie llama-server sie liefert: beide Zahlen nebeneinander. */
const BOX_MODELS = {
  object: 'list',
  data: [{
    id: BOX_MODEL,
    object: 'model',
    owned_by: 'llamacpp',
    meta: { n_vocab: 151936, n_ctx: 16384, n_ctx_train: 40960, n_embd: 2560 },
  }],
}
/** Dieselbe Karte von einem Bau, der `meta.n_ctx` nicht mitschickt. */
const BOX_MODELS_NUR_TRAIN = {
  object: 'list',
  data: [{
    id: BOX_MODEL,
    object: 'model',
    owned_by: 'llamacpp',
    meta: { n_vocab: 151936, n_ctx_train: 40960, n_embd: 2560 },
  }],
}

/** Beantwortet die drei Pfade, die dieser Server wirklich kennt. */
function serveBox(models: unknown, props: unknown = BOX_PROPS) {
  localFetch.mockImplementation(async (url: string) => {
    const u = String(url)
    if (u.endsWith('/props')) return new Response(JSON.stringify(props), { status: 200 })
    if (u.endsWith('/models')) return new Response(JSON.stringify(models), { status: 200 })
    return new Response('{"error":"not found"}', { status: 404 })
  })
}

describe('T4 Punkt 4: das laufende Fenster schlaegt die trainierte Decke', () => {
  it('16384 gelaufen, 40960 trainiert: der Waehler zeigt 16K vom Server', async () => {
    const provider = new OpenAIProvider(reporterConfig(8131))
    serveBox(BOX_MODELS)

    // Der Weg der App: erst die Liste fuer den Modellwaehler, dann das Fenster.
    await provider.listModels()
    const resolved = await provider.getContextWindow(BOX_MODEL)
    const win = resolveActiveWindow({ resolved, localBackend: true })

    expect(resolved.tokens).toBe(16384)
    expect(resolved.source).toBe('probe')
    expect(SOURCE_LABEL[resolved.source]).toBe('from server')
    expect(formatContextWindow(win.contextWindow)).toBe('16K')
    // Die Auswahlliste endet am laufenden Fenster: LU kann das `-c` dieses
    // Servers nicht setzen, also waere jede groessere Zahl im Waehler eine
    // Behauptung ueber ihn. Die trainierten 40960 kommen hier nicht mehr vor.
    expect(win.modelMax).toBe(16384)
    expect(formatContextWindow(win.modelMax)).toBe('16K')
    // Und nicht mehr das, was der Tester sah.
    expect(formatContextWindow(win.contextWindow)).not.toBe('40K')
  })

  it('nennt die Liste nur die Decke, wird /props gelesen statt uebergangen', async () => {
    const provider = new OpenAIProvider(reporterConfig(8132))
    serveBox(BOX_MODELS_NUR_TRAIN)

    await provider.listModels()
    const resolved = await provider.getContextWindow(BOX_MODEL)

    expect(resolved.tokens).toBe(16384)
    expect(resolved.source).toBe('probe')
    expect(resolved.modelMax).toBe(16384)
    expect(localFetch.mock.calls.map(([u]) => String(u)))
      .toContain('http://192.168.4.132:8132/props')
  })

  it('nur die Decke und sonst nichts: 40960 mit ehrlichem Etikett', async () => {
    const provider = new OpenAIProvider(reporterConfig(8133))
    // Kein /props: der Server antwortet nur mit seiner Modellliste.
    localFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/models')
        ? new Response(JSON.stringify(BOX_MODELS_NUR_TRAIN), { status: 200 })
        : new Response('{"error":"not found"}', { status: 404 }))

    await provider.listModels()
    const resolved = await provider.getContextWindow(BOX_MODEL)

    expect(resolved.tokens).toBe(40960)
    expect(resolved.source).toBe('trained')
    expect(SOURCE_LABEL[resolved.source]).not.toContain('from server')
    expect(SOURCE_LABEL[resolved.source])
      .toBe("from the model's training limit (the server may run smaller)")
    // Aus einer Decke wird kein Budget: der Server kennt seine Voreinstellung.
    expect(capIsDerivable(resolved)).toBe(false)
    expect(windowIsKnown('trained')).toBe(false)
  })

  it('am Draht liegt kein max_tokens ueber dem laufenden Fenster', async () => {
    const provider = new OpenAIProvider(reporterConfig(8134))
    serveBox(BOX_MODELS)
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))

    await provider.listModels()
    await drain(provider.chatStream(BOX_MODEL, [{ role: 'user', content: 'hi' }]))

    const cap = sentBody().max_tokens as number
    expect(typeof cap).toBe('number')
    expect(cap).toBeGreaterThan(0)
    // Gemessen stand hier 32768, das Doppelte des ganzen Fensters.
    expect(cap).not.toBe(32768)
    // Fenster minus Prompt minus Reserve, also strikt unter dem Fenster.
    expect(cap).toBeLessThanOrEqual(16384 - 512)
  })

  it('kennt der Server nur seine Decke, geht gar kein max_tokens raus', async () => {
    const provider = new OpenAIProvider(reporterConfig(8135))
    localFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/models')
        ? new Response(JSON.stringify(BOX_MODELS_NUR_TRAIN), { status: 200 })
        : new Response('{"error":"not found"}', { status: 404 }))
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))

    await provider.listModels()
    await drain(provider.chatStream(BOX_MODEL, [{ role: 'user', content: 'hi' }]))

    expect(sentBody()).not.toHaveProperty('max_tokens')
  })

  it('eine gespeicherte Wahl ueber dem Fenster wird darauf geklemmt', async () => {
    const provider = new OpenAIProvider(reporterConfig(8137))
    serveBox(BOX_MODELS)
    useSettingsStore.getState().updateSettings({
      contextWindowByModel: { [provider.contextWindowKey(BOX_MODEL)]: 40960 },
    })

    await provider.listModels()
    const resolved = await provider.getContextWindow(BOX_MODEL)
    const win = resolveActiveWindow({ resolved, localBackend: true })

    expect(resolved.tokens).toBe(16384)
    expect(resolved.source).toBe('user')
    expect(resolved.clampedFrom).toBe(40960)
    // Die Liste endet am Fenster, nicht an der alten Wahl.
    expect(win.modelMax).toBe(16384)
    // Der Speicher bleibt unangetastet: wer seinen Server groesser neu
    // startet, bekommt seine 40960 zurueck.
    expect(useSettingsStore.getState().settings.contextWindowByModel?.[
      provider.contextWindowKey(BOX_MODEL)
    ]).toBe(40960)
  })

  it('und der Draht traegt dann hoechstens das Fenster minus Prompt', async () => {
    const provider = new OpenAIProvider(reporterConfig(8138))
    serveBox(BOX_MODELS)
    localFetchStream.mockResolvedValue(new Response('data: [DONE]\n\n', { status: 200 }))
    useSettingsStore.getState().updateSettings({
      contextWindowByModel: { [provider.contextWindowKey(BOX_MODEL)]: 40960 },
    })

    await provider.listModels()
    await drain(provider.chatStream(BOX_MODEL, [{ role: 'user', content: 'hi' }]))

    const cap = sentBody().max_tokens as number
    expect(cap).toBeGreaterThan(0)
    expect(cap).not.toBe(32768)
    expect(cap).toBeLessThanOrEqual(16384 - 512)
  })

  it('ohne laufendes Fenster bleibt die Wahl des Nutzers stehen', async () => {
    // Kein /props, nur die trainierte Decke: dann weiss niemand, dass 40960 zu
    // gross waere, und die Wahl ist das Beste, was es gibt.
    const provider = new OpenAIProvider(reporterConfig(8139))
    localFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/models')
        ? new Response(JSON.stringify(BOX_MODELS_NUR_TRAIN), { status: 200 })
        : new Response('{"error":"not found"}', { status: 404 }))
    useSettingsStore.getState().updateSettings({
      contextWindowByModel: { [provider.contextWindowKey(BOX_MODEL)]: 40960 },
    })

    await provider.listModels()
    const resolved = await provider.getContextWindow(BOX_MODEL)

    expect(resolved.tokens).toBe(40960)
    expect(resolved.source).toBe('user')
    expect(resolved.clampedFrom).toBeUndefined()
    expect(resolved.modelMax).toBe(40960)
  })

  it('LM Studio: geladen ist das Fenster, das Koennen nur die Decke', async () => {
    // Dieselbe Fehlerklasse an der anderen Quelle. LM Studio schneidet einen
    // Prompt ueber `loaded_context_length` hart ab; ein Budget gegen
    // `max_context_length` verliert die Mitte des eigenen Prompts.
    const provider = new OpenAIProvider(reporterConfig(8136))
    localFetch.mockImplementation(async (url: string) =>
      String(url).includes('/api/v0/models/')
        ? new Response(JSON.stringify({
            id: 'qwen2.5-32b', max_context_length: 131072, loaded_context_length: 8192,
          }), { status: 200 })
        : new Response('{"error":"not found"}', { status: 404 }))

    const resolved = await provider.getContextWindow('qwen2.5-32b')

    expect(resolved.tokens).toBe(8192)
    expect(resolved.source).toBe('probe')
    expect(resolved.modelMax).toBe(8192)
  })
})

describe('GH #129: die Gegenprobe zum Fehlerbericht', () => {
  it('256k gemeldet, 256k gezeigt, und der Waehler ist da', async () => {
    const provider = new OpenAIProvider(reporterConfig(8091))
    serveLlamaCpp()

    const resolved = await provider.getContextWindow('my-model')
    const win = resolveActiveWindow({ resolved, localBackend: true })

    // Der Nenner des Zaehlers: sendWindow, sonst contextWindow (TokenCounter).
    const denominator = win.sendWindow > 0 ? win.sendWindow : win.contextWindow
    expect(denominator).toBe(262144)
    expect(formatContextWindow(denominator)).toBe('256K')
    // ContextDropdown rendert den Waehler genau dann, wenn das hier wahr ist.
    expect(win.adjustable).toBe(true)
    expect(win.source).toBe('probe')
    // Und nicht mehr das, was der Melder sah.
    expect(formatContextWindow(denominator)).not.toBe('6.4K')
    expect(formatContextWindow(denominator)).not.toBe('25.6K')
  })
})
