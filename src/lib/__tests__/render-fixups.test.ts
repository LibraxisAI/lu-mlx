import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildWithFixups, wasDeclined, downloadPrompt, remoteDownloadPrompt, UPDATE_PROMPT, type FixupDeps } from '../render-fixups'

const unavailable = (extra: Record<string, unknown>) => Object.assign(new Error('needs files'), { name: 'WorkflowUnavailableError', ...extra })
const T5 = { downloadFilename: 't5.safetensors', downloadUrl: 'https://huggingface.co/x/t5.safetensors', subfolder: 'text_encoders', sizeGB: 5.16, matchPatterns: [] }
const deps = (go = true): FixupDeps & Record<string, ReturnType<typeof vi.fn>> => ({
  ask: vi.fn(async () => go), download: vi.fn(async () => {}), updateComfy: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
}) as never

describe('buildWithFixups', () => {
  it('asks once, downloads what is missing, and runs the build again', async () => {
    const build = vi.fn().mockRejectedValueOnce(unavailable({ missing: [T5] })).mockResolvedValueOnce('graph')
    const d = deps()
    await expect(buildWithFixups(build, d)).resolves.toBe('graph')
    expect(d.ask).toHaveBeenCalledWith(downloadPrompt([T5]))
    expect(d.download).toHaveBeenCalledWith([T5])
    expect(d.refresh).toHaveBeenCalledOnce()
    expect(build).toHaveBeenCalledTimes(2)
  })

  it('updates ComfyUI when the graph needs a newer one', async () => {
    const build = vi.fn().mockRejectedValueOnce(unavailable({ needsComfyUpdate: true })).mockResolvedValueOnce('graph')
    const d = deps()
    await buildWithFixups(build, d)
    expect(d.ask).toHaveBeenCalledWith(UPDATE_PROMPT)
    expect(d.updateComfy).toHaveBeenCalledOnce()
  })

  it('a no leaves everything as it was and reports the original reason', async () => {
    const err = unavailable({ missing: [T5] })
    const d = deps(false)
    await expect(buildWithFixups(vi.fn().mockRejectedValue(err), d)).rejects.toBe(err)
    expect(d.download).not.toHaveBeenCalled()
    // Gegenprobe 8: Create says "Not started", not "Generation failed".
    expect(wasDeclined(err)).toBe(true)
  })

  it('an error nobody was asked about is not a no', async () => {
    const plain = new Error('boom')
    await expect(buildWithFixups(vi.fn().mockRejectedValue(plain), deps())).rejects.toBe(plain)
    expect(wasDeclined(plain)).toBe(false)
    const update = unavailable({ needsComfyUpdate: true })
    await expect(buildWithFixups(vi.fn().mockRejectedValue(update), deps(false))).rejects.toBe(update)
    expect(wasDeclined(update)).toBe(true)
  })

  it('never offers the same fix twice, and never touches errors it cannot fix', async () => {
    const err = unavailable({ missing: [T5] })
    const d = deps()
    await expect(buildWithFixups(vi.fn().mockRejectedValue(err), d)).rejects.toBe(err)
    expect(d.download).toHaveBeenCalledOnce()
    const plain = new Error('boom')
    await expect(buildWithFixups(vi.fn().mockRejectedValue(plain), deps())).rejects.toBe(plain)
    const noUrl = unavailable({ missing: [{ ...T5, downloadUrl: undefined }] })
    await expect(buildWithFixups(vi.fn().mockRejectedValue(noUrl), deps())).rejects.toBe(noUrl)
  })

  it('the question says what, how much, and where', () => {
    const p = downloadPrompt([T5, { ...T5, downloadFilename: 'ae.safetensors', sizeGB: 0.34 }])
    expect(p.title).toBe('2 more files are needed')
    expect(p.detail).toContain('t5.safetensors, ae.safetensors (5.5 GB)')
    expect(p.confirm).toBe('Download 5.5 GB and render')
  })

  // GH #143: ComfyUI as a service on another machine. Its models folder is
  // over there, so the files land here and the user copies them; LU cannot
  // update that ComfyUI either.
  describe('a ComfyUI on another machine', () => {
    const REMOTE = { host: '192.168.1.20', root: 'D:\\LU models' }
    const remoteDeps = (go = true) => ({ ...deps(go), remote: vi.fn(async () => REMOTE) })

    it('downloads to this computer after saying so, then says what to copy where', async () => {
      const build = vi.fn().mockRejectedValue(unavailable({ missing: [T5] }))
      const d = remoteDeps()
      await expect(buildWithFixups(build, d)).rejects.toThrow(
        'Downloaded to D:\\LU models. Your ComfyUI runs on 192.168.1.20: copy text_encoders/t5.safetensors into the models folder of ComfyUI on that machine, then hit Create again.',
      )
      expect(d.ask).toHaveBeenCalledWith(remoteDownloadPrompt([T5], REMOTE))
      expect(d.download).toHaveBeenCalledWith([T5])
      // No second build: nothing on that machine can see the file yet.
      expect(build).toHaveBeenCalledTimes(1)
    })

    it('the question names the machine and the folder, and promises no render', () => {
      const p = remoteDownloadPrompt([T5], REMOTE)
      expect(p.detail).toContain('Your ComfyUI runs on 192.168.1.20')
      expect(p.detail).toContain('D:\\LU models')
      expect(p.confirm).toBe('Download 5.2 GB')
    })

    it('never offers to update a ComfyUI that is not on this machine', async () => {
      const build = vi.fn().mockRejectedValue(unavailable({ needsComfyUpdate: true }))
      const d = remoteDeps()
      await expect(buildWithFixups(build, d)).rejects.toThrow('This model needs a newer ComfyUI than the one on 192.168.1.20.')
      expect(d.ask).not.toHaveBeenCalled()
      expect(d.updateComfy).not.toHaveBeenCalled()
    })
  })
})

describe('Create after a no (Gegenprobe 8, 02.10.)', () => {
  it('says Not started with the reason, not Generation failed', () => {
    const src = readFileSync('src/hooks/useCreate.ts', 'utf8')
    const branch = src.slice(src.indexOf('} else if (err instanceof Error && wasDeclined(err)) {'))
    expect(branch.slice(0, 400)).toContain('setError(`Not started. ${err.message}`)')
    expect(branch.indexOf('Not started.')).toBeLessThan(branch.indexOf('Generation failed'))
  })
})
