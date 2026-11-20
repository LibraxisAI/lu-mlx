// @vitest-environment jsdom
/**
 * The box, 03.10.2026: "Download & install" for the cutout node pack failed,
 * and the reason was gone as soon as the mode changed. The card kept it in its
 * own state, so leaving Cutout threw it away. It now lives with the run
 * (lib/model-install-runs.ts) and stays until the user closes it or tries
 * again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

const installCapability = vi.hoisted(() => vi.fn())

vi.mock('../CreateContext', () => ({
  useCreateExp: () => ({
    generate: vi.fn(), cancel: vi.fn(), makeVoice: vi.fn(), connected: true, modelsLoaded: true,
    cloudAvailable: false, uploadImage: vi.fn(), installCapability,
  }),
}))

import { Stage } from '../Stage'
import { useCreateStore } from '../../../../stores/createStore'
import { resetInstallRuns } from '../../../../lib/model-install-runs'

const REASON = "Failed to install ComfyUI-RMBG: ERROR: Could not install packages due to an OSError: [WinError 5] access is denied: 'cv2.pyd'"

function stage() {
  return render(<Stage displayed={undefined} onOpenMaskEditor={vi.fn()} onEditResult={vi.fn()} onAnimateResult={vi.fn()} onFullscreen={vi.fn()} />)
}

beforeEach(() => {
  resetInstallRuns()
  installCapability.mockReset()
  useCreateStore.setState({
    backend: 'local', isGenerating: false, gallery: [], source: null, mask: null,
    caps: { rmbg: false, 'inpaint-nodes': true, dwpose: true },
    imageModelList: [{ name: 'sd_turbo.safetensors', type: 'sd15' }],
  } as never)
  useCreateStore.getState().setIntent('removebg')
})
afterEach(() => cleanup())

describe('a failed node pack install on the Cutout card', () => {
  it('keeps its reason through a mode switch and back', async () => {
    installCapability.mockRejectedValue(new Error(REASON))
    const first = stage()
    await act(async () => { fireEvent.click(screen.getByText('Download & install')) })
    expect(screen.getByText(REASON)).toBeTruthy()

    // Off to Image and back to Cutout: the card is unmounted in between.
    first.unmount()
    act(() => { useCreateStore.getState().setIntent('image') })
    act(() => { useCreateStore.getState().setIntent('removebg') })
    stage()
    expect(screen.getByText(REASON)).toBeTruthy()
  })

  it('goes away when the user closes it', async () => {
    installCapability.mockRejectedValue(new Error(REASON))
    stage()
    await act(async () => { fireEvent.click(screen.getByText('Download & install')) })
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(screen.queryByText(REASON)).toBeNull()
  })

  it('goes away on the next try', async () => {
    installCapability.mockRejectedValueOnce(new Error(REASON)).mockReturnValue(new Promise(() => undefined))
    stage()
    await act(async () => { fireEvent.click(screen.getByText('Download & install')) })
    expect(screen.getByText(REASON)).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByText('Download & install')) })
    expect(screen.queryByText(REASON)).toBeNull()
    expect(screen.getByText('Setting this up for you')).toBeTruthy()
  })
})
