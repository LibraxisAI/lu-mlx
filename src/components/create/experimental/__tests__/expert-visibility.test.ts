// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCreateStore } from '../../../../stores/createStore'
import { ParamGroups } from '../ParamGroups'

const host = vi.hoisted(() => ({ mlx: false }))
vi.mock('../../../../api/mlx-image', () => ({ isMlxImageHost: () => host.mlx }))
vi.mock('../../../../api/comfyui', () => ({ classifyModel: () => 'sdxl' }))
vi.mock('../CreateContext', () => ({ useCreateExp: () => ({
  samplerList: [], schedulerList: [], loraList: [], vaeList: [], refreshModelLists: vi.fn(),
}) }))

afterEach(() => { cleanup(); host.mlx = false })

describe('Expert controls match the desktop backend', () => {
  it('hides the empty cloud image section', () => {
    useCreateStore.setState({ backend: 'cloud', mode: 'image' })
    useCreateStore.getState().setIntent('image')
    render(createElement(ParamGroups))
    expect(screen.queryByText('Expert')).toBeNull()
  })

  it('keeps working ComfyUI controls visible when expanded', () => {
    useCreateStore.setState({ backend: 'local', mode: 'image' })
    useCreateStore.getState().setIntent('image')
    render(createElement(ParamGroups))
    fireEvent.click(screen.getByText('Expert'))
    expect(screen.getByText('Sampler')).toBeTruthy()
    expect(screen.getByText('Scheduler')).toBeTruthy()
  })

  it('does not offer unsupported controls on MLX-only', () => {
    host.mlx = true
    useCreateStore.setState({ backend: 'local', mode: 'image', comfyRunning: false })
    useCreateStore.getState().setIntent('image')
    render(createElement(ParamGroups))
    expect(screen.queryByText('Expert')).toBeNull()
  })

  it('offers Expert on a Mac once ComfyUI is connected', () => {
    host.mlx = true
    useCreateStore.setState({ backend: 'local', mode: 'image', comfyRunning: true })
    useCreateStore.getState().setIntent('image')
    render(createElement(ParamGroups))
    fireEvent.click(screen.getByText('Expert'))
    expect(screen.getByText('Sampler')).toBeTruthy()
  })

  it('hides the five dead knobs on the local music lane', () => {
    // R2-28: Sampler, Scheduler, LoRA, VAE und Skip CLIP standen auf der
    // lokalen Musikbahn und keiner davon wurde je gesendet. Der Abschnitt
    // traegt dort nichts mehr, also faellt er ganz weg.
    useCreateStore.setState({ backend: 'local', mode: 'video' })
    useCreateStore.getState().setIntent('music')
    render(createElement(ParamGroups))
    expect(screen.queryByText('Expert')).toBeNull()
    for (const knopf of ['Sampler', 'Scheduler', 'LoRA stack', 'VAE', 'Skip CLIP layers']) {
      expect(screen.queryByText(knopf), `${knopf} is still on the local music lane`).toBeNull()
    }
  })

  it('leaves the lanes whose builder really reads sampler and scheduler alone', () => {
    // Negativkontrolle: Lipsync und Motion lesen `params.sampler` und
    // `params.scheduler` wirklich. Ein zu breiter Schnitt haette sie
    // mitgenommen.
    for (const intent of ['lipsync', 'motion'] as const) {
      cleanup()
      useCreateStore.setState({ backend: 'local', mode: 'video' })
      useCreateStore.getState().setIntent(intent)
      render(createElement(ParamGroups))
      fireEvent.click(screen.getByText('Expert'))
      expect(screen.getByText('Sampler'), `${intent} lost its sampler`).toBeTruthy()
      expect(screen.getByText('Scheduler'), `${intent} lost its scheduler`).toBeTruthy()
    }
  })

  it('keeps cloud edit denoise while hiding local mask controls', () => {
    useCreateStore.setState({ backend: 'cloud', mode: 'image' })
    useCreateStore.getState().setIntent('edit')
    render(createElement(ParamGroups))
    fireEvent.click(screen.getByText('Expert'))
    expect(screen.getByText('Denoise (raw)')).toBeTruthy()
    expect(screen.queryByText('Mask edge feather')).toBeNull()
    expect(screen.queryByText('Sampler')).toBeNull()
  })
})
