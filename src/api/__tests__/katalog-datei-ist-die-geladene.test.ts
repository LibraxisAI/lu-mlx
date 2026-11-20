/**
 * Die Datei, die ein Katalogeintrag nennt, ist die Datei, die geladen wird.
 *
 * Jeder Eintrag des Chat-Katalogs nennt eine bestimmte GGUF-Datei. Vor dem
 * Download fragt die App den Dateibaum des Repos und waehlt daraus neu. Bis zum
 * 08.10.2026 war die Quant-Bezeichnung der einzige Schluessel dieser Wahl, und
 * der Dateiname des Eintrags wurde gar nicht mit dem Baum verglichen. Drei
 * Formen von Namen fielen dabei durch:
 *
 *   1. Zwei Familien in einem Repo. Alle vier Karten "Qwen 3.8 27B Heretic"
 *      nennen `RVN-<Quant>-multilingual.gguf`. Der Name endet nicht auf dem
 *      Quant, also wurde keiner gelesen, also fiel die Wahl auf die Q4_K_M
 *      Gruppe, die im Baum zuerst steht: `Qwen3.8-27B-Heretic-Q4_K_M.gguf`,
 *      die aeltere Abliteration, vor der der Kommentar am Eintrag warnt.
 *   2. Namen auf `-0731.gguf`. Kein Quant lesbar, die Wahl faellt auf die
 *      erste Datei des Baums.
 *   3. Quants auf `_K_P`. Kein Quant lesbar, dieselbe Folge.
 *
 * Der Waechter hat zwei Haelften. Die erste geht durch JEDEN Katalogeintrag
 * mit festem Dateinamen und stellt ihm einen feindlichen Baum: vor der
 * genannten Datei steht eine Nachbardatei mit demselben Quant, eine mit
 * Q4_K_M und ein Vision-Projektor. Die zweite nimmt die Baeume, die Hugging
 * Face am 08.10.2026 fuer die fuenf betroffenen Repos geliefert hat.
 *
 * Kein Netz. Die Frage an den Baum kommt aus `ggufRequestFor`, derselben
 * Funktion, die der Models-Tab benutzt.
 */
import { describe, it, expect } from 'vitest'
import {
  getUncensoredTextModels, getMainstreamTextModels, ggufRequestFor, selectGgufFromTree,
  type DiscoverModel, type HfTreeEntry,
} from '../discover'

const SHARD = /-(\d{4,5})-of-(\d{4,5})\.gguf$/i

/** Jeder Eintrag des Chat-Katalogs, der eine Datei nennt. */
const eintraege: DiscoverModel[] = [...getUncensoredTextModels(), ...getMainstreamTextModels()]
  .filter(m => m.downloadUrl && m.filename)

const pfadVon = (m: DiscoverModel): string => ggufRequestFor(m)!.exactPath!

/** Alle Teile, die zu der genannten Datei gehoeren: sie selbst, oder bei einem
 *  Mehrteiler jeder Teil des Satzes. */
function teileVon(pfad: string): string[] {
  const m = SHARD.exec(pfad)
  if (!m) return [pfad]
  const anzahl = parseInt(m[2], 10)
  const breite = m[1].length
  return Array.from({ length: anzahl }, (_, i) =>
    pfad.replace(SHARD, `-${String(i + 1).padStart(breite, '0')}-of-${m[2]}.gguf`))
}

/**
 * Der feindliche Baum eines Repos. Vorn die Dateien, auf die die alte Wahl
 * hereinfiel, dahinter die Dateien aller Katalogeintraege dieses Repos, die
 * Teile eines Mehrteilers in umgekehrter Reihenfolge.
 */
function gestellterBaum(repoId: string): HfTreeEntry[] {
  const baum: HfTreeEntry[] = [{ type: 'file', path: 'README.md', size: 1 }]
  const gesehen = new Set<string>()
  const lege = (path: string, size: number) => {
    if (gesehen.has(path)) return
    gesehen.add(path)
    baum.push({ type: 'file', path, size })
  }
  const imRepo = eintraege.filter(m => ggufRequestFor(m)!.repoId === repoId)
  lege('mmproj-F16.gguf', 900)
  lege('Aeltere-Familie-Q4_K_M.gguf', 500)
  for (const m of imRepo) {
    const quant = ggufRequestFor(m)!.preferredQuant
    if (quant) lege(`Aeltere-Familie-${quant}.gguf`, 500)
  }
  for (const m of imRepo) {
    for (const teil of teileVon(pfadVon(m)).reverse()) lege(teil, 1000)
  }
  return baum
}

describe('jeder Katalogeintrag mit festem Dateinamen laedt genau diese Datei', () => {
  it('der Katalog nennt ueberhaupt Dateien, und jede Adresse ist eine Hugging-Face-Adresse', () => {
    expect(eintraege.length).toBeGreaterThan(150)
    for (const m of eintraege) {
      const frage = ggufRequestFor(m)
      expect(frage, m.name).not.toBeNull()
      expect(frage!.exactPath!.split('/').pop(), m.name).toBe(m.filename)
    }
  })

  it.each(eintraege.map(m => [m.name, m] as const))('%s', (_name, m) => {
    const frage = ggufRequestFor(m)!
    const wahl = selectGgufFromTree(gestellterBaum(frage.repoId), frage.repoId, frage.preferredQuant, frage.exactPath)
    expect(wahl).not.toBeNull()
    const teile = teileVon(frage.exactPath!)
    expect(wahl!.files.map(f => f.url)).toEqual(teile.map(t => `https://huggingface.co/${frage.repoId}/resolve/main/${t}`))
    expect(wahl!.files[0].url).toBe(m.downloadUrl)
    expect(wahl!.files[0].filename).toBe(m.filename)
    expect(wahl!.sharded).toBe(teile.length > 1)
  })
})

/**
 * Die GGUF-Dateien der fuenf betroffenen Repos, in der Reihenfolge, in der
 * `/api/models/<repo>/tree/main?recursive=true` sie am 08.10.2026 geliefert
 * hat. Das Heretic-Repo ist ein Auszug (alle Dateien der vier gelisteten
 * Quants, die aeltere Datei, Projektor und MTP-Kopf), die anderen sind
 * vollstaendig.
 */
const ECHTE_BAEUME: Record<string, string[]> = {
  '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF': [
    'Qwen3.8-27B-Heretic-Q4_K_M.gguf',
    'RVN-IQ2_M-mtp.gguf',
    'RVN-IQ2_M-multilingual-mtp.gguf',
    'RVN-IQ2_M-multilingual.gguf',
    'RVN-IQ2_M.gguf',
    'RVN-Q4_K_M-mtp.gguf',
    'RVN-Q4_K_M-multilingual-mtp.gguf',
    'RVN-Q4_K_M-multilingual-vision.gguf',
    'RVN-Q4_K_M-multilingual.gguf',
    'RVN-Q4_K_M-vision.gguf',
    'RVN-Q4_K_M.gguf',
    'RVN-Q5_K_M-mtp.gguf',
    'RVN-Q5_K_M-multilingual-mtp.gguf',
    'RVN-Q5_K_M-multilingual-vision.gguf',
    'RVN-Q5_K_M-multilingual.gguf',
    'RVN-Q5_K_M-vision.gguf',
    'RVN-Q5_K_M.gguf',
    'RVN-Q6_K-mtp.gguf',
    'RVN-Q6_K-multilingual-mtp.gguf',
    'RVN-Q6_K-multilingual.gguf',
    'RVN-Q6_K.gguf',
    'mmproj-Qwen3.8-27B-Q8_0.gguf',
    'mtp-RVN.gguf',
  ],
  'huihui-ai/Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF': [
    'DeepSeek-V4-Flash-Q2-0731.gguf',
    'DeepSeek-V4-Flash-Q2_K-0731.gguf',
    'DeepSeek-V4-Flash-Q4-mxfp4-0731.gguf',
    'DeepSeek-V4-Flash-Q4_K-0731.gguf',
    'dspark-abliterated/dspark-DeepSeek-V4-Flash-0731-BF16.gguf',
    'dspark-abliterated/dspark-DeepSeek-V4-Flash-0731-Q8_0.gguf',
    'dspark/dspark-DeepSeek-V4-Flash-0731-BF16.gguf',
    'dspark/dspark-DeepSeek-V4-Flash-0731-Q8_0.gguf',
  ],
  'HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF': [
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-FastMTP-32K.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ2_M.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ3_M.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ3_XS.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q2_K_P.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q3_K_P.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q5_K_P.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf',
    'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf',
    'mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf',
  ],
  'HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive': [
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-IQ3_M.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q2_K_P.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q3_K_M.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q3_K_P.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_M.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q5_K_P.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf',
    'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf',
    'mmproj-Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-f16.gguf',
  ],
  'DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF': [
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ2_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ3_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ4_NL.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-IQ4_XS.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-IQ2_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-IQ3_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-IQ4_NL.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-IQ4_XS.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-Q4_K_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-Q4_K_S.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-Q5_K_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-Q5_K_S.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-Q6_K.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-MTP-Q8_0.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_S.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q5_K_M.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q5_K_S.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q6_K.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q8_0.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-plusIQ-NEO-MAX-MTP-Q6_K.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-plusIQ-NEO-MAX-MTP-Q8_0.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-plusIQ-NEO-MAX-MTP-bf16.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-plusIQ-TOOLS-NEO-MAX-MTP-Q6_K.gguf',
    'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-plusIQ-TOOLS-NEO-MAX-MTP-Q8_0.gguf',
    'mmproj-BF16.gguf',
    'mmproj-F16.gguf',
    'mmproj-F32.gguf',
  ],
}

const echterBaum = (repoId: string): HfTreeEntry[] =>
  ECHTE_BAEUME[repoId].map(path => ({ type: 'file', path, size: 1000 }))

describe('gegen die Baeume, die Hugging Face am 08.10.2026 geliefert hat', () => {
  const betroffen = eintraege.filter(m => ggufRequestFor(m)!.repoId in ECHTE_BAEUME)

  it('alle fuenf Repos haben Eintraege im Katalog', () => {
    const repos = new Set(betroffen.map(m => ggufRequestFor(m)!.repoId))
    expect([...repos].sort()).toEqual(Object.keys(ECHTE_BAEUME).sort())
  })

  it.each(betroffen.map(m => [m.name, m] as const))('%s', (_name, m) => {
    const frage = ggufRequestFor(m)!
    expect(ECHTE_BAEUME[frage.repoId], 'die genannte Datei steht im echten Baum').toContain(frage.exactPath)
    const wahl = selectGgufFromTree(echterBaum(frage.repoId), frage.repoId, frage.preferredQuant, frage.exactPath)
    expect(wahl!.files.map(f => f.url)).toEqual([m.downloadUrl])
    expect(wahl!.files[0].filename).toBe(m.filename)
  })

  it('der Quant allein fuehrt bei Heretic auf die aeltere Datei, deshalb ist er nur Rueckfall', () => {
    const repo = '0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF'
    const heretic = betroffen.filter(m => ggufRequestFor(m)!.repoId === repo)
    expect(heretic).toHaveLength(4)
    for (const m of heretic) {
      const nurQuant = selectGgufFromTree(echterBaum(repo), repo, ggufRequestFor(m)!.preferredQuant)
      expect(nurQuant!.files[0].filename, m.name).toBe('Qwen3.8-27B-Heretic-Q4_K_M.gguf')
    }
  })

  it('MTP-Zwilling, _K_P und -0731: der genannte Name gewinnt gegen den Nachbarn', () => {
    const faelle: Array<[string, string]> = [
      ['DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q4_K_M.gguf'],
      ['DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF', 'Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-NEO-MAX-Q8_0.gguf'],
      ['HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf'],
      ['HauhauCS/Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-MTP-GGUF', 'Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf'],
      ['HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive', 'Gemma-4-E4B-Uncensored-HauhauCS-Aggressive-Q8_K_P.gguf'],
      ['huihui-ai/Huihui-DeepSeek-V4-Flash-0731-abliterated-GGUF', 'DeepSeek-V4-Flash-Q4_K-0731.gguf'],
    ]
    for (const [repo, datei] of faelle) {
      const m = betroffen.find(e => e.filename === datei)
      expect(m, `${datei} steht im Katalog`).toBeDefined()
      const frage = ggufRequestFor(m!)!
      const wahl = selectGgufFromTree(echterBaum(repo), repo, frage.preferredQuant, frage.exactPath)
      expect(wahl!.files.map(f => f.filename)).toEqual([datei])
      // Ohne den Namen landet jeder dieser Faelle auf einer anderen Datei.
      const nurQuant = selectGgufFromTree(echterBaum(repo), repo, frage.preferredQuant)
      expect(nurQuant!.files[0].filename, datei).not.toBe(datei)
    }
  })
})

describe('der Name ist Vorrang, der Quant bleibt Rueckfall', () => {
  const REPO = 'x/Foo-GGUF'
  const baum: HfTreeEntry[] = [
    { type: 'file', path: 'Foo-Q4_K_M.gguf', size: 10 },
    { type: 'file', path: 'Foo-Q6_K.gguf', size: 20 },
    { type: 'file', path: 'Q8_0/Foo-Q8_0-00002-of-00002.gguf', size: 30 },
    { type: 'file', path: 'Q8_0/Foo-Q8_0-00001-of-00002.gguf', size: 40 },
    { type: 'file', path: 'a/Zwilling.gguf', size: 50 },
    { type: 'file', path: 'b/Zwilling.gguf', size: 60 },
  ]

  it('eine Datei, die es im Baum nicht gibt, faellt auf den Quant zurueck', () => {
    const wahl = selectGgufFromTree(baum, REPO, 'Q6_K', 'Geraten-Q6_K.gguf')
    expect(wahl!.files.map(f => f.filename)).toEqual(['Foo-Q6_K.gguf'])
  })

  it('ein genannter Teil bringt den ganzen Satz mit, sortiert', () => {
    const wahl = selectGgufFromTree(baum, REPO, 'Q4_K_M', 'Q8_0/Foo-Q8_0-00001-of-00002.gguf')
    expect(wahl!.sharded).toBe(true)
    expect(wahl!.files.map(f => f.filename)).toEqual(['Foo-Q8_0-00001-of-00002.gguf', 'Foo-Q8_0-00002-of-00002.gguf'])
    expect(wahl!.totalBytes).toBe(70)
  })

  it('eine Datei, die in einen Ordner gewandert ist, wird am Namen gefunden', () => {
    const wahl = selectGgufFromTree(baum, REPO, 'Q4_K_M', 'Foo-Q8_0-00001-of-00002.gguf')
    expect(wahl!.files).toHaveLength(2)
  })

  it('derselbe Name in zwei Ordnern entscheidet nichts, der volle Pfad schon', () => {
    expect(selectGgufFromTree(baum, REPO, 'Q4_K_M', 'Zwilling.gguf')!.files[0].filename).toBe('Foo-Q4_K_M.gguf')
    expect(selectGgufFromTree(baum, REPO, 'Q4_K_M', 'b/Zwilling.gguf')!.files[0].url).toBe(`https://huggingface.co/${REPO}/resolve/main/b/Zwilling.gguf`)
  })

  it('ohne Namen bleibt alles beim Alten', () => {
    expect(selectGgufFromTree(baum, REPO, 'Q6_K')!.files[0].filename).toBe('Foo-Q6_K.gguf')
    expect(selectGgufFromTree(baum, REPO)!.files[0].filename).toBe('Foo-Q4_K_M.gguf')
  })
})
