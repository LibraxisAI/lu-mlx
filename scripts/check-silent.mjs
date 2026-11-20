// Keeps the repository quiet about what runs behind the hosted service.
//
// The client code for the hosted service is public, and that is fine. What
// does not belong in a public tree is who serves it, what it costs to serve,
// how the private server repository is laid out, who reported a bug, and under
// which account name somebody's home folder lies. This script reads every
// tracked text file outside docs/ and names each line that carries one of
// those.
//
//   node scripts/check-silent.mjs            the whole tree, exit 1 on a hit
//   node scripts/check-silent.mjs a.ts b.rs  only these files
//   node scripts/check-silent.mjs --held     what stands in the held-back areas
//
// src/lib/__tests__/silent-repo.test.ts runs the same scan in the normal gate.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What is looked for. `id` names the rule in a report and in ALLOWED. */
export const RULES = [
  // Whoever answers, renders, bills or hosts behind the hosted service.
  { id: 'vendor', re: /wavespeed|deepinfra|phala|runpod|novita|replicate\.(com|delivery)|fal\.(ai|run)|fal-ai\/|venice|\bstripe(?![a-z])|\bmollie|digitalocean|\bdroplet\b|hetzner/i },
  // The layout of the private server repository.
  { id: 'server-path', re: /apps\/web|lib\/billing|\buselu\b|\blu-web\b|infra\/supabase|ops\/wissen|\/root\/lu-/ },
  { id: 'server-constant', re: /\b(LENGTH_MODEL_USD|MEDIA_MODEL_USD|CREDIT_USD|VOICE_USD|VIDEO_UPSCALE_USD|IMAGE_UPSCALE_USD|DIRECT_MARKUP|DIRECT_CREDIT_FACTOR|TIER_CREDITS|TIER_VIDEO_CREDITS|TOPUP_PACKS|CATALOG_PRICES|BILLING_[A-Z_]+|PAID_THROUGH_GRACE_DAYS)\b/ },
  { id: 'migration', re: /migration[ -]?\d{3,4}\b|\b00\d\d_[a-z_]+/i },
  { id: 'table', re: /\b(billing_settings|chat_credit_holds|credit_topups|credit_topup_reversals|credit_wallets|flash_request_lease|flash_usage_daily|quota_usage|render_jobs|starter_credit_policy|webhook_events|bonus_credits)\b/ },
  // What a run costs to buy, and what is put on top.
  { id: 'money', re: /\$\s?\d+[.,]\d{2,}|\bUSD\b|\bUS-?Dollar|\b0,0\d+ Dollar/ },
  { id: 'margin', re: /Einkaufspreis|\bEinkauf\b|Gewinnmarge|Preisaufschlag|\bwholesale\s+(price|cost|rate|\$)|purchase price|\bmarkup (of|on|over)\b|\bour (cost|margin)\b|kostet uns\b/ },
  // Machines and addresses of the people who build this.
  { id: 'host', re: /lu-box|dd\.local|\.ts\.net|rustdesk|192\.168\.0\.54/i },
  // The story of a billing fault. The reason for a line may stay, the story not.
  { id: 'billing-story', re: /Geldfalle|(?=.*(credit|billing|charge|refund|wallet|quota|\b40[29]\b|Abrechnung|Guthaben|Erstattung))(.*(Vorfall|\bincident\b|until 20\d\d-\d\d-\d\d|bis zum \d\d\.\d\d\.))/i },
  // Who reported it.
  { id: 'reporter', re: /@[a-z0-9_.]{4,},? (on )?Discord/ },
  // A home folder under the account name of a real person or machine. Only
  // the names in HOME_NAME_HASHES count, `alice` and `user` stay free.
  { id: 'home-name', re: /\b(?:Users|home)[/\\]+([A-Za-z0-9_-]+)/gi, among: () => HOME_NAME_HASHES },
  { id: 'mail', re: /[A-Za-z0-9._%+-]+@(?!example\.com|lu-labs\.ai|anthropic\.com|github\.com|users\.noreply|x\.com|bar\.com|civitai\.com)[A-Za-z0-9-]+\.(com|ai|de|org|io|net)\b/ },
]

/** Handles of people who reported something, as the first 16 hex digits of
 *  the SHA-256 of the lower-case handle. Hashed so that this list does not
 *  publish what it keeps out. A new handle: `node scripts/check-silent.mjs
 *  --hash <handle>`. */
export const REPORTER_HASHES = new Set([
  '681d135fffb3ece2', 'f8c69fef3b66d5a3', '82da127a29096753', '9f08b61473ab274f', '2c98b2abc6af07b5',
  '81c952dafde11987',
  '7c4fbe63169f7291', 'fc11ea87f1cd44e3', 'd61cdc38ee89c977',
  '002a111913a0c19b', '013086a8663bfc0d', '0234213acded4f37', '04fd1a6c1ec3e6c1', '08ed01d29f21e353',
  '094d2ce44d5595ab', '0b9759797edda597', '11422a60f1eaeeb2', '115267e766ae87e2', '13800b21ef85d9f3',
  '145909771701d5ad', '14d678439812aa98', '161420c22bd76531', '16fb1c3687d5c5fc', '1745e9f0f921962c',
  '19de873a9a982a67', '19f66f864b0d4648', '1d9c588e52de4782', '1fc2da534f8ae1d1', '2071d4b4a44d1c60',
  '26f539cca242ffa6', '2b4fe4ac323330f1', '2bcde830d7f9b825', '2e33a51e3da9bef9', '305703ab7d14fd13',
  '337b86e7f8f02cdd', '338f7e8c97809b62', '340cec343eba34bf', '34cd865a954bbc0f', '38728f83b1d58da6',
  '3a87508e3aeefa6a', '3ab6e1271e2c53de', '3b11299f497cfb0f', '3c660b305d8f3fe0', '3ecc6765036549ff',
  '472aa3923b00e3d5', '485ff15f646eea2a', '48881bdbb906a479', '49654f9f83b022e7', '4ccc8b1c243204db',
  '4f0345d5c261a73e', '51b14fa7a46e4f18', '5219cee4fd257971', '5479b83797b8ef20', '548683640c229603',
  '5594360d87ab48e1', '56b26f205cb2aad2', '5751cf6667c05ee7', '5950a6cb6e305365', '5b37d4a4dd6673f5',
  '5cb9676dce3f7bed', '5dcf9d99d9227697', '5e5712b7b7932ad3', '5e8f3207b10c5c6c', '6037f923de5e03a3',
  '60e9b6d316654713', '64b1b85dd216dea9', '64d80b180b6a96ff', '693cfe598b090dc0', '6d1f95963fb179a1',
  '6ef19fb9f460e38e', '71a2bf5461991039', '725f88efaca2de54', '73f2e8d8a6a50566', '74af6a1728a38d4e',
  '79eebb1dfa182ee1', '7b2861468073c559', '7ea61ba7b92d073e', '80d7c326bb00335d', '83764ff80be4457f',
  '84a0f742e93e58e3', '87a428b057e782b2', '898eb5ced3919235', '8b6829cdf8e04e7e', '8c12c67565db18cb',
  '906dfd31a811257f', '9357cbed791101bf', '93d0305be01e27e1', '94bf9f21bb461df4', '954f951cace8c65f',
  '96667a714a15a8ce', '9a3226bf04525a71', '9aed5dc2e979399f', '9b6f265abf4837db', '9eaedda91b39df4f',
  'a09a87bccbe0bc87', 'a1d5126bda1117f5', 'a3fa4123953e191c', 'a5794bbaa41dd783', 'a69024c40e5b6892',
  'a710aa938f375888', 'a8210a04af2a96dc', 'a8eab895b8733c28', 'ae0c7f85b43b4821', 'aee082659ce4e03b',
  'afdee4ff1ecc0eb4', 'b1a96b0a73585681', 'b1e7bcea9a1294a6', 'b8e1bb2ffa316f82',
  'c12d2eb986fd1f57', 'c67b95396023be77', 'c90046a33ede31bc', 'cb6e93e273c1b0fd', 'cca49a98a4bf8170',
  'cfad0a4220d7ba22', 'd0bcd4150b810021', 'd4ed97c868ec8e50', 'd502fbde60420911', 'daca2c9cf6748928',
  'e2c7efe49303924b', 'e383f4a7473b2109', 'e3bdf569a53ebe69', 'e6084ec483abdc61', 'e7bd83e3016c9788',
  'eb468ee440564316', 'ee018f961cc24df3', 'ee7f280a4686db80', 'efc245085dcb0c19', 'f0c32b0b7add3591',
  'f0d1d752341fed8e', 'f32d63aec3fa2162', 'f4d93ef81513176c', 'f6e978756fea20e6', 'f956078db9b1b003',
  'feba8d6933780777', 'feffda6651589943',
])

/** Account names that stood in a path of a fixture, hashed like the handles
 *  above. A fixture takes a neutral name instead. */
export const HOME_NAME_HASHES = new Set([
  '9cd16ac9f09614dc', '8e0a1b0ada421728', '07d046d5fac12b3f', '61ea0803f8853523',
  'efee614420c57ddd', '27d784d336d2d55e', '568daa1194031564', '92e4accd3d41d63f',
])

/** Text that may stand although a rule matches it, everywhere. Each entry is
 *  blanked out before the rules run. */
export const ALLOWED_TEXT = [
  // Names of models as the picker shows them. A model is not its host.
  /Venice (Uncensored|Role Play)/g,
]

/** Files the scan does not read at all, with the reason. */
export const NOT_READ = [
  { files: /^docs\//, why: 'The website. It has its own rules and its own guard.' },
  { files: /(^|\/)(package-lock\.json|Cargo\.lock)$/, why: 'Lock files: package names and hashes, written by the package manager.' },
  { files: /^public\/(heygen-avatars|fonts|create-presets)\//, why: 'Images and fonts, nothing to read in them.' },
  { files: /^scripts\/check-silent\.mjs$/, why: 'This list itself has to spell the words.' },
]

/** Areas that are held back from this sweep. They are scanned by `--held`
 *  and reported, and they move out of this list once they are clean. */
export const HELD = [
  { files: /^(\.github\/workflows\/release\.yml|scripts\/signing-config\.sh)$/, why: 'The release lane is frozen for 3.0.6.' },
]

/** A rule that may match in a file, with the reason. `rule` is a rule id,
 *  `files` a path pattern, `text` (optional) limits the entry to lines that
 *  match it. */
export const ALLOWED = [
  // A guard that keeps a word off a surface has to spell the word.
  { rule: 'vendor', files: /(\.test\.tsx?|\.spec\.ts)$/, text: /not\.toMatch\(|\.test\(u\)/, why: 'An assertion that the word is absent.' },
  { rule: 'server-constant', files: /^src\/components\/models\/__tests__\/cloud-model-picker\.test\.tsx$/, text: /not\.toMatch\(/, why: 'An assertion that the name is absent.' },
  // Things a user picks or builds himself, and plain English.
  { rule: 'vendor', files: /^src\/api\/agents\/(project-init\.ts|__tests__\/project-init\.test\.ts)$/, why: 'A scaffold recipe for the user\'s own project, with the payment library he asked for.' },
  { rule: 'vendor', files: /^mobile-client\/(client\.js|styles\.css)$/, text: /stripe/, why: 'A stripe of colour in the layout.' },
  { rule: 'server-path', files: /^src\/api\/agents\/architect\.ts$/, why: 'An example path inside a prompt for the coding agent.' },
  { rule: 'money', files: /^src\/lib\/__tests__\/surgical-edit\.test\.ts$/, why: 'A test value with a dollar sign in it.' },
  // The comparison pages of the website name other services and their public prices.
  { rule: 'vendor', files: /^(src\/lib\/__tests__\/cloud-comparisons\.test\.ts|e2e\/cloud-comparisons\.spec\.ts|scripts\/check-cloud-sales\.mjs)$/, text: /venice/i, why: 'A competitor on a public comparison page.' },
  { rule: 'money', files: /^(src\/lib\/__tests__\/cloud-comparisons\.test\.ts|e2e\/cloud-comparisons\.spec\.ts)$/, why: 'Public prices of competitors, as the comparison pages print them.' },
  { rule: 'money', files: /^scripts\/check-cloud-sales\.mjs$/, text: /tokensForMoney/, why: 'The pattern that keeps "tokens for money" sentences off the site.' },
  // Parity tools: they read a checkout of the web app and need its paths and
  // the names of its tables to do that. Code only; their comments are clean.
  { rule: 'server-path', files: /^scripts\/(check-cloud-sales|create-chat-mirror|create-chat-stack-probe|studio-snapshot)\.mjs$/, text: /['"`]/, why: 'Reads the web checkout by path.' },
  { rule: 'server-constant', files: /^scripts\/check-cloud-sales\.mjs$/, text: /['"`/]/, why: 'Reads the web price tables by name.' },
  { rule: 'server-path', files: /^src\/.*__tests__\/[\w.-]+\.tsx?$/, text: /['"]apps\/web[\w./-]*['"]|web\('lib\/billing/, why: 'A parity test that reads the web checkout by path (skipped without LU_WEB_REPO).' },
  { rule: 'server-constant', files: /^src\/lib\/(create\/__tests__\/web-parity|render\/__tests__\/(katalog-paritaet-web|sota-models))\.test\.ts$/, text: /^(?!\s*(\/\/|\*|\/\*))/, why: 'A parity test that reads the web price table by its names. Code lines only.' },
  { rule: 'money', files: /^src-tauri\/src\/commands\/computer\/desk\/sensitive\.rs$/, text: /"Pay \$12\.00"/, why: 'A made up label of a button in some shop, as test data for the rule that a click on it needs the user. Not a price of ours.' },
]

const BINARY = /\.(png|jpe?g|webp|gif|ico|icns|bmp|woff2?|ttf|otf|mp3|wav|ogg|mp4|webm|pdf|zip|gz|bundle|onnx|bin|gguf|safetensors|dll|exe|dylib|so|node)$/i

export const hashOf = (handle) => createHash('sha256').update(handle.toLowerCase()).digest('hex').slice(0, 16)

/** Every word of a line that is a known handle. */
function reporters(line) {
  const found = []
  for (const raw of line.match(/[A-Za-z0-9_.-]{3,}/g) ?? []) {
    const word = raw.replace(/^[.-]+|[.-]+$/g, '')
    const parts = word.includes('-') ? [word, ...word.split('-')] : [word]
    for (const part of parts) {
      if (part.length >= 3 && REPORTER_HASHES.has(hashOf(part))) { found.push(part); break }
    }
  }
  return found
}

/** Every hit in `text`, which came from `file`. */
export function findHits(text, file) {
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    for (const allowed of ALLOWED_TEXT) line = line.replace(allowed, (found) => ' '.repeat(found.length))
    const add = (rule, word) => {
      if (ALLOWED.some((a) => a.rule === rule && a.files.test(file) && (!a.text || a.text.test(lines[i])))) return
      hits.push({ file, line: i + 1, rule, word, around: lines[i].trim().slice(0, 160) })
    }
    for (const { id, re, among } of RULES) {
      if (among) {
        for (const m of line.matchAll(re)) if (among().has(hashOf(m[1]))) add(id, m[0])
        continue
      }
      const m = re.exec(line)
      if (m) add(id, m[0])
    }
    for (const handle of reporters(line)) add('reporter', handle)
  }
  return hits
}

export function trackedFiles(root = ROOT) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean)
}

const inList = (list, file) => list.some((entry) => entry.files.test(file))

/** Scans the tree (or `only`). `held: true` scans the held-back areas instead
 *  of the rest. */
export function scan({ root = ROOT, only, held = false } = {}) {
  const hits = []
  let read = 0
  for (const file of only ?? trackedFiles(root)) {
    if (BINARY.test(file) || inList(NOT_READ, file)) continue
    if (inList(HELD, file) !== held) continue
    let text
    try {
      text = readFileSync(resolve(root, file), 'utf8')
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') continue
      throw e
    }
    if (text.includes('\0')) continue
    read++
    hits.push(...findHits(text, file))
  }
  return { hits, read }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === '--hash') {
    for (const handle of args.slice(1)) process.stdout.write(`  '${hashOf(handle)}',\n`)
    process.exit(0)
  }
  const held = args.includes('--held')
  const only = args.filter((a) => !a.startsWith('--'))
  const { hits, read } = scan({ held, only: only.length ? only : undefined })
  for (const h of hits) process.stdout.write(`${h.file}:${h.line}: [${h.rule}] ${h.word}  |  ${h.around}\n`)
  const byRule = {}
  for (const h of hits) byRule[h.rule] = (byRule[h.rule] ?? 0) + 1
  process.stderr.write(`${read} files read, ${hits.length} hits ${JSON.stringify(byRule)}\n`)
  process.exit(hits.length && !held ? 1 : 0)
}
