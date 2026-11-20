// MIRRORED from the web app (lib/create/media-wish.ts), without its comments. Do not edit here.
// scripts/create-chat-mirror.mjs writes this file, and web-parity.test.ts
// holds it to its source. Only the import paths differ, the places listed
// under PATCHES in that script, and the classes under CLASSES.
export type MediaWishKind = 'image' | 'video' | 'music' | 'voice'

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim()
}

const NOUNS: Record<MediaWishKind, string[]> = {
  voice: [
    'voice-?overs?', 'voice overs?', 'narrations?', 'audio (?:version|clip|recording)s?', 'voice (?:recording|clip|message)s?',
    'vertonung(?:en)?', 'sprachaufnahmen?', 'sprachnachricht(?:en)?', 'audioaufnahmen?',
  ],
  video: ['videos?', 'clips?', 'animations?', 'gifs?', 'animation(?:en)?'],
  music: [
    'songs?', 'tracks?', 'beats?', 'melod(?:y|ies)', 'jingles?', 'tunes?', 'instrumentals?', 'soundtracks?',
    'lied(?:er)?', 'melodien?', 'musikstuecke?',
  ],
  image: [
    'images?', 'pictures?', 'pics?', 'photos?', 'photographs?', 'drawings?', 'illustrations?', 'paintings?',
    'wallpapers?', 'logos?', 'artworks?', 'posters?', 'avatars?', 'memes?',
    'bild(?:er)?', 'fotos?', 'zeichnung(?:en)?', 'gemaelde', 'illustration(?:en)?', 'hintergrundbild(?:er)?',
    'profilbild(?:er)?',
  ],
}
const KINDS: MediaWishKind[] = ['voice', 'video', 'music', 'image']
const alt = (list: string[]) => `(?:${list.join('|')})`
const ANY_NOUN = alt(KINDS.flatMap((k) => NOUNS[k]))
const VISUAL_NOUN = alt([...NOUNS.image, ...NOUNS.video])
const PLURAL_NOUN = alt([
  'images', 'pictures', 'pics', 'photos', 'drawings', 'illustrations', 'paintings', 'wallpapers', 'logos', 'videos',
  'clips', 'animations', 'gifs', 'songs', 'tracks', 'beats', 'voice-?overs',
  'bilder', 'fotos', 'zeichnungen', 'illustrationen', 'animationen', 'lieder',
])
const MUSIC_MASS = '(?:music|musik)'

const KIND_RE = Object.fromEntries(
  KINDS.map((k) => [k, new RegExp(`^${alt(NOUNS[k])}$`)]),
) as Record<MediaWishKind, RegExp>

function kindOf(noun: string): MediaWishKind {
  if (noun === 'speech') return 'voice'
  if (noun === 'music' || noun === 'musik') return 'music'
  return KINDS.find((k) => KIND_RE[k].test(noun)) ?? 'image'
}

const ADDRESSED = '(?=(?:(?:can|could|would|will)\\s+(?:you|u)|are\\s+you\\s+able|please|pls|bitte|kannst|koenntest|wuerdest)\\b)'
const START = `(?:^|(?:,\\s*|\\b(?:and|then|und|dann)\\s+)${ADDRESSED})`
const LEAD =
  '(?:(?:please|pls|plz|hey|hi|hello|ok|okay|so|now|also|just|and|then|quickly|great|thanks|cool|nice|yes|yeah|well|alright'
  + '|bitte|hallo|jetzt|nun|und|dann|super|danke|ja|gut)[,\\s]+)*'
const EN_FILL = '(?:(?:please|pls|just|also|now|maybe|quickly|then|even|actually)\\s+)*'
const ASK_EN =
  `(?:(?:(?:can|could|would|will)\\s+(?:you|u)|are\\s+you\\s+able\\s+to)\\s+${EN_FILL}`
  + '|i\\s+(?:want|need)\\s+you\\s+to\\s+|i(?:\'d|\\s+would)\\s+like\\s+you\\s+to\\s+|go\\s+ahead\\s+and\\s+)?'
const ASK_EN_WIDE =
  `(?:(?:(?:can|could|would|will)\\s+(?:you|u)|are\\s+you\\s+able\\s+to)\\s+${EN_FILL}`
  + '|i\\s+want\\s+(?:you\\s+)?to\\s+|i\\s+need\\s+you\\s+to\\s+|i(?:\'d|\\s+would)\\s+like\\s+(?:you\\s+)?to\\s+|go\\s+ahead\\s+and\\s+)?'
const VERB_EN = '(?:generate|create|make|draw|paint|sketch|render|design|produce|compose)'
const TO_ME_EN = '(?:(?:me|us)\\s+)?'
const DET_EN = '(?:a|an|another|one|two|three|four|some|a\\s+few|a\\s+couple\\s+of|\\d+|the|this|that|my|our)\\s+'
const DET_EN_NEW = '(?:a|an|another|one|two|three|four|some|a\\s+few|\\d+)\\s+'

const VERB_DE =
  '(?:mache?|erstelle?|erzeuge?|generiere?|entwirf|produziere?|komponiere?|rendere?|zeichne|male?)'
const TO_ME_DE = '(?:(?:mir|uns)\\s+)?'
const DE_FILL = '(?:(?:bitte|mal|doch|jetzt|noch|nochmal|einfach|schnell|kurz|auch|gern|gerne|eigentlich|ueberhaupt)\\s+)*'
const DET_DE = '(?:ein|eine|einen|zwei|drei|vier|ein\\s+paar|\\d+|das|dieses|diesen|diese|den|die|mein|meine|meinen)\\s+'
const DET_DE_NEW = '(?:ein|eine|einen|zwei|drei|vier|ein\\s+paar|\\d+)\\s+'
const MAKE_DE = '(?:machen|erstellen|erzeugen|generieren|malen|zeichnen|entwerfen|produzieren|komponieren|rendern|basteln|zaubern)'
const ASK_DE = '(?:kannst|koenntest|kannste|wuerdest)\\s+(?:du\\s+)?'

const SLOT_STOP =
  'a|an|the|this|that|these|those|my|your|his|her|their|our|der|die|das|dem|den|des|ein|eine|einen|einem|einer|'
  + 'of|for|to|about|on|in|with|which|and|or|from|as|like|into|by|at|if|is|are|was'
  + '|list|table|plan|prompt|script|description|summary|text|caption|title'
  + '|von|fuer|zu|ueber|auf|mit|dass|und|oder|aus|als|wie|bei|an|zum|zur|im|am|vom|beim'
  + '|liste|tabelle|beschreibung|zusammenfassung|drehbuch|skript|titel|idee|ideen'
const SLOT = `(?:(?!(?:${SLOT_STOP})\\b)[a-z0-9'-]+\\s+){0,3}?`

const FOLLOW =
  '(?![\\w-])(?=\\s*$|\\s*[,)]|\\s+(?:'
  + 'of|with|showing|featuring|depicting|where|in|on|at|that|about|for|from|based|like|using|to|into|please|pls|now|again|so'
  + '|von|mit|wo|auf|das|der|die|den|dem|ueber|fuer|aus|wie|im|bitte|jetzt|nochmal|zu|dazu|davon|zum|vom'
  + `|${MAKE_DE.slice(3, -1)}`
  + ')\\b)'
const NOT_A_COMPOUND =
  '(?![\\w-])(?!\\s+(?:ideas?|calls?|games?|scripts?|prompts?|editors?|players?|codecs?|formats?|files?|frames?|albums?'
  + '|books?|galler(?:y|ies)|classifiers?|models?|generators?|tools?|apps?|sites?|websites?|pages?|tags?|elements?'
  + '|components?|descriptions?|captions?|titles?|lists?|playlists?|librar(?:y|ies)|pipelines?|quality|size|resolution'
  + '|uploads?|urls?|links?|folders?|datasets?|viewers?|converters?)\\b)'

const re = (source: string) => new RegExp(source)

const NOUN_FORMS: RegExp[] = [
  re(`${START}${LEAD}${ASK_EN_WIDE}${VERB_EN}\\s+${TO_ME_EN}${DET_EN}${SLOT}(${ANY_NOUN})${FOLLOW}`),
  re(`${START}${LEAD}(?:${ASK_EN}${VERB_EN}\\s+${TO_ME_EN}|${VERB_DE}\\s+${TO_ME_DE}${DE_FILL})(${ANY_NOUN})(?![\\w-])(?=\\s+(?:of|von)\\b)`),
  re(`${START}${LEAD}(?:${ASK_EN}remove\\s+the\\s+(background)|entferne\\s+${DE_FILL}den\\s+(hintergrund))\\b`),
  re(`${START}${LEAD}${ASK_EN}${VERB_EN}\\s+${TO_ME_EN}(?:some\\s+)?(${PLURAL_NOUN})${FOLLOW}`),
  re(`${START}${LEAD}${ASK_EN}${VERB_EN}\\s+${TO_ME_EN}(?:some\\s+|a\\s+little\\s+|a\\s+bit\\s+of\\s+)?(?:(?!(?:${SLOT_STOP})\\b)[a-z'-]+\\s+){0,2}?(${MUSIC_MASS})${FOLLOW}`),
  re(`${START}${LEAD}i(?:\\s+want|'d\\s+(?:like|love)|\\s+would\\s+(?:like|love))\\s+${DET_EN_NEW}${SLOT}(${ANY_NOUN})(?![\\w-])(?=\\s*$|\\s*[,)]|\\s+(?:of|with|showing|featuring|depicting|where|in\\s+the\\s+style|please)\\b)`),
  re(`${START}${LEAD}${ASK_EN}(?:edit|retouch|upscale|enhance|animate|colou?rize|restyle|recolou?r)\\s+(?:this|that|the|my|our|these|those)\\s+${SLOT}(${VISUAL_NOUN})${NOT_A_COMPOUND}`),
  re(`${START}${LEAD}${ASK_EN}(?:turn|convert|transform|make)\\s+(?:this|that|it|the|my|these)\\s+(?:[a-z0-9'-]+\\s+){0,3}?(?:into|to)\\s+(?:(?:a|an|some)\\s+)?${SLOT}(${ANY_NOUN}|${MUSIC_MASS}|speech)${NOT_A_COMPOUND}`),

  re(`${START}${LEAD}${VERB_DE}\\s+${TO_ME_DE}${DE_FILL}${DET_DE}${SLOT}(${ANY_NOUN})${FOLLOW}`),
  re(`${START}${LEAD}${VERB_DE}\\s+${TO_ME_DE}${DE_FILL}(${PLURAL_NOUN})${FOLLOW}`),
  re(`${START}${LEAD}${VERB_DE}\\s+${TO_ME_DE}${DE_FILL}(?:etwas\\s+|ein\\s+bisschen\\s+)?(?:(?!(?:${SLOT_STOP})\\b)[a-z'-]+\\s+){0,2}?(${MUSIC_MASS})${FOLLOW}`),
  re(`${START}${LEAD}${ASK_DE}${TO_ME_DE}${DE_FILL}${DET_DE_NEW}${SLOT}(${ANY_NOUN})(?![\\w-])(?=.*\\b${MAKE_DE}\\b)`),
  re(`${START}${LEAD}${ASK_DE}${TO_ME_DE}${DE_FILL}(${PLURAL_NOUN}|${MUSIC_MASS})\\s+${DE_FILL}${MAKE_DE}\\b`),
  re(`${START}${LEAD}ich\\s+(?:moechte|will|haette\\s+gerne?|wuensche\\s+mir)\\s+${DE_FILL}${DET_DE_NEW}${SLOT}(${ANY_NOUN})(?![\\w-])(?=\\s*$|\\s*[,)]|\\s+(?:von|mit|wo|auf\\s+dem|in\\s+dem|im\\s+stil|bitte|${MAKE_DE.slice(3, -1)})\\b)`),
  re(`${START}${LEAD}(?:${ASK_DE})?(?:bearbeite|animiere|verbessere|retuschiere|koloriere|skaliere)\\s+${DE_FILL}(?:das|dieses|diesen|diese|den|die|mein|meine|meinen)\\s+${SLOT}(${VISUAL_NOUN})(?![\\w-])`),
  re(`${START}${LEAD}mache?\\s+${TO_ME_DE}${DE_FILL}aus\\s+(?:dem|diesem|meinem|der|dieser|meiner|den|diesen)\\s+[a-z0-9'-]+\\s+${DE_FILL}${DET_DE_NEW}${SLOT}(${ANY_NOUN})(?![\\w-])`),
]

const DRAW_FORMS: RegExp[] = [
  re(`${START}${LEAD}${ASK_EN}(?:draw|paint|sketch)\\s+(?:(?:me|us)\\s+)?(?:a|an|another|some|two|three|\\d+)\\s+[a-z]`),
  re(`${START}${LEAD}${ASK_EN}(?:draw|paint|sketch)\\s+(?:me|us)\\s+[a-z]`),
  re(`${START}${LEAD}(?:zeichne|male)\\s+${TO_ME_DE}${DE_FILL}(?:ein|eine|einen|zwei|drei|\\d+)\\s+[a-z]`),
  re(`${START}${LEAD}mal\\s+(?:mir|uns)\\s+${DE_FILL}(?:ein|eine|einen|zwei|drei|\\d+)\\s+[a-z]`),
  re(`${START}${LEAD}${ASK_DE}${TO_ME_DE}${DE_FILL}(?:ein|eine|einen)\\s+.*\\b(?:zeichnen|malen)(?:\\s+bitte)?\\s*$`),
]
const DRAW_BUT_NO_PICTURE =
  /\b(?:conclusions?|comparisons?|parallels?|distinctions?|lines?|lot|blank|cards?|plan|outline|diagram|chart|graph|table|timeline|flowchart|bath|walls?|rooms?|house|fence|ceiling|doors?|nails?|numbers?|samples?|names?|winner|crowd|salary|gun|weapon|sword|inference|analogy|idea|proposal|draft|roadmap|strategy|schema|diagramm|tabelle|grundriss|schaubild|linie|strich|wand|zimmer|haus|zaun|fazit|vergleich)\b/

const VOICE_FORMS: RegExp[] = [
  re(`${START}${LEAD}${ASK_EN}(?:read|say)\\s+(?:me\\s+)?(?:this|that|it|the\\s+following|(?:the|your|my)\\s+[a-z]+)(?:\\s+[a-z]+){0,2}?\\s+(?:aloud|out\\s+loud)\\b`),
  re(`${START}${LEAD}(?:lies|lese)\\s+${TO_ME_DE}(?:das|es|(?:den|diesen|deinen|meinen)\\s+text|(?:die|diese|deine|meine)\\s+(?:geschichte|antwort))\\s+${DE_FILL}(?:laut\\s+)?vor\\b`),
  re(`${START}${LEAD}${ASK_DE}${TO_ME_DE}(?:das|es|(?:den|diesen|deinen|meinen)\\s+text|(?:die|diese|deine|meine)\\s+(?:geschichte|antwort))\\s+${DE_FILL}(?:laut\\s+)?vorlesen\\b`),
]

const NOT_FOR_CREATE =
  /\b(?:code|function|python|javascript|typescript|js|css|html|svg|docker\w*|container|kubernetes|iso|disk|vm|opencv|pillow|pil|matplotlib|ffmpeg|imagemagick|latex|markdown|ascii|mermaid|api|sdk|react|regex|sql|base64)\b|\bhow\s+(?:do|does|can|could|would|should|to)\b|\bwie\s+(?:kann|koennte|mache?|macht|erstelle|erstellt|erzeuge|geht|funktioniert)\b/
const WANTS_TO_USE =
  /\b(?:watch|see|find|upload|share|send|buy|listen|hear|analy[sz]e|describe|explain|search|look|recommend\w*|suggest\w*|sehen|schauen|ansehen|anschauen|gucken|hochladen|teilen|schicken|senden|finden|suchen|kaufen|hoeren|anhoeren|zeigen|analysieren|beschreiben|erklaeren|verstehen|empfehl\w*)\b/
const WANT_FORM = /\bi(?:\s+want|'d\s+(?:like|love)|\s+would\s+(?:like|love))\s+(?:a|an|another|one|two|three|four|some|\d)|\bich\s+(?:moechte|will|haette\s+gerne?|wuensche\s+mir)\b/

const LONG_TEXT = 500

export function mediaWish(text: string): MediaWishKind | null {
  if (!text || !text.trim()) return null
  let clauses = text.split(/[.!?;:\n]+/).map(fold).filter(Boolean)
  if (text.length > LONG_TEXT && clauses.length > 2) clauses = [clauses[0], clauses[clauses.length - 1]]

  for (const clause of clauses) {
    if (NOT_FOR_CREATE.test(clause)) continue
    for (const form of VOICE_FORMS) if (form.test(clause)) return 'voice'
    const wantsToUse = WANT_FORM.test(clause) && WANTS_TO_USE.test(clause)
    if (!wantsToUse) {
      for (const form of NOUN_FORMS) {
        const hit = form.exec(clause)
        if (hit) return kindOf(hit[1] ?? hit[2])
      }
    }
    if (!DRAW_BUT_NO_PICTURE.test(clause) && DRAW_FORMS.some((form) => form.test(clause))) return 'image'
  }
  return null
}
