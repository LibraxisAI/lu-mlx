// ─── Fix what a render is missing, then run it ───
//
// Discord 2026-09-26..28 (the owner: "not just say what is wrong, make it work"):
// a model whose text encoder or VAE is not on disk, or a ComfyUI too old for
// the model's loader, used to end the run with a sentence that sent people to
// the Model Manager or to Settings. The builder now says exactly what is
// missing (WorkflowUnavailableError.missing / .needsComfyUpdate), and this
// module asks once, fetches or updates, and hands the build back for one more
// try. Pure orchestration: every side effect comes in through `deps`, so the
// tests drive it without Tauri or ComfyUI.

import type { ComponentSpec } from '../api/component-registry'

export interface FixupPrompt {
  title: string
  detail: string
  confirm: string
}

export interface FixupDeps {
  /** Ask the user; true means go. */
  ask: (prompt: FixupPrompt) => Promise<boolean>
  /** Download these files and wait until ComfyUI lists them. */
  download: (files: Array<ComponentSpec & { downloadUrl: string; subfolder: string }>) => Promise<void>
  /** Update ComfyUI (the update starts it again) and wait until it answers. */
  updateComfy: () => Promise<void>
  /** Drop the cached node catalogue so the next build reads the new state. */
  refresh: () => Promise<void>
  /** GH #143: the ComfyUI on another machine, when it is one. Files then land
   *  in `root` on this machine and have to be copied over before a render can
   *  find them, and its ComfyUI is not LU's to update. */
  remote?: () => Promise<RemoteComfy | null>
}

export interface RemoteComfy {
  host: string
  root: string
}

interface FixableError {
  name: string
  message: string
  missing?: ComponentSpec[]
  needsComfyUpdate?: boolean
}

function fixable(err: unknown): FixableError | null {
  if (!(err instanceof Error) || err.name !== 'WorkflowUnavailableError') return null
  const e = err as FixableError
  const downloadable = (e.missing ?? []).filter((m) => m.downloadUrl && m.subfolder)
  if (downloadable.length > 0 || e.needsComfyUpdate) return e
  return null
}

const gb = (n: number) => (n >= 1 ? `${n.toFixed(1)} GB` : `${Math.max(1, Math.round(n * 1024))} MB`)

export function downloadPrompt(files: ComponentSpec[]): FixupPrompt {
  const total = files.reduce((sum, f) => sum + (f.sizeGB ?? 0), 0)
  const names = files.map((f) => f.downloadFilename).join(', ')
  return {
    title: files.length === 1 ? 'One more file is needed' : `${files.length} more files are needed`,
    detail: `This model needs ${names}${total > 0 ? ` (${gb(total)})` : ''}. LU downloads ${files.length === 1 ? 'it' : 'them'} into your ComfyUI models folder, then starts the render.`,
    confirm: total > 0 ? `Download ${gb(total)} and render` : 'Download and render',
  }
}

export function remoteDownloadPrompt(files: ComponentSpec[], remote: RemoteComfy): FixupPrompt {
  const local = downloadPrompt(files)
  const names = files.map((f) => f.downloadFilename).join(', ')
  const total = files.reduce((sum, f) => sum + (f.sizeGB ? f.sizeGB : 0), 0)
  const it = files.length === 1 ? 'it' : 'them'
  return {
    title: local.title,
    detail: `This model needs ${names}${total > 0 ? ` (${gb(total)})` : ''}. Your ComfyUI runs on ${remote.host}, so LU downloads ${it} to this computer, into ${remote.root}, in ComfyUI's folder layout. Copy ${it} over to that machine afterwards.`,
    confirm: total > 0 ? `Download ${gb(total)}` : 'Download',
  }
}

export function remoteCopyMessage(files: ComponentSpec[], remote: RemoteComfy): string {
  const paths = files.map((f) => `${f.subfolder}/${f.downloadFilename}`).join(', ')
  return `Downloaded to ${remote.root}. Your ComfyUI runs on ${remote.host}: copy ${paths} into the models folder of ComfyUI on that machine, then hit Create again.`
}

export function remoteUpdateMessage(remote: RemoteComfy): string {
  return `This model needs a newer ComfyUI than the one on ${remote.host}. Update ComfyUI on that machine, restart it, then hit Create again.`
}

/** What the stage says while a dialog waits for the user. The box,
 *  03.10.2026: "Building workflow..." stood there for ten minutes while the
 *  MP4 question was open, and it read as a hang. */
export const WAITING_FOR_ANSWER = 'Waiting for your answer in the dialog…'

export const UPDATE_PROMPT: FixupPrompt = {
  title: 'ComfyUI needs an update',
  detail: 'This model needs a newer ComfyUI than the one installed. LU updates it (git pull plus its Python packages), restarts it, then starts the render. Takes a few minutes.',
  confirm: 'Update ComfyUI and render',
}

/** The original reason, marked as the user's own no, so Create can say
 *  "Not started" instead of "Generation failed" (3.0.4 Gegenprobe 8: a
 *  deliberate Cancel in the download question read as a failure). */
function declined(err: unknown): unknown {
  if (err instanceof Error) Object.assign(err, { declined: true })
  return err
}

export function wasDeclined(err: unknown): boolean {
  return err instanceof Error && (err as { declined?: boolean }).declined === true
}

/** A build that can be retried after its missing pieces are fixed. The same
 *  fix is never offered twice: a second identical failure is reported. */
export async function buildWithFixups<T>(build: () => Promise<T>, deps: FixupDeps, maxRounds = 3): Promise<T> {
  const done = new Set<string>()
  for (let round = 0; ; round++) {
    try {
      return await build()
    } catch (err) {
      const e = fixable(err)
      if (!e || round >= maxRounds) throw err
      const remote = (await deps.remote?.()) ?? null
      if (e.needsComfyUpdate) {
        if (remote) throw new Error(remoteUpdateMessage(remote))
        if (done.has('update')) throw err
        done.add('update')
        if (!(await deps.ask(UPDATE_PROMPT))) throw declined(err)
        await deps.updateComfy()
      } else {
        const files = (e.missing ?? []).filter(
          (m): m is ComponentSpec & { downloadUrl: string; subfolder: string } => !!m.downloadUrl && !!m.subfolder,
        )
        const key = files.map((f) => f.downloadFilename).sort().join('|')
        if (done.has(key)) throw err
        done.add(key)
        if (!(await deps.ask(remote ? remoteDownloadPrompt(files, remote) : downloadPrompt(files)))) throw declined(err)
        await deps.download(files)
        // On another machine nothing can render with them until they are
        // copied over, so the run ends here and says what to copy where.
        if (remote) throw new Error(remoteCopyMessage(files, remote))
      }
      await deps.refresh()
    }
  }
}
