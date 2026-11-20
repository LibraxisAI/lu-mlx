/**
 * @vitest-environment jsdom
 *
 * 10.10.2026: every picture the app made shows the prompt it was made
 * from. In the chat a local picture stands under its tool call, and the prompt
 * was only readable after opening the call and reading its JSON.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { ToolCallBlock } from '../ToolCallBlock'
import type { AgentToolCall } from '../../../types/agent-mode'

afterEach(() => cleanup())

const call = (extra: Partial<AgentToolCall>): AgentToolCall => ({
  id: 't1', toolName: 'image_generate', args: { prompt: 'a red apple on a plate' }, status: 'completed', timestamp: 1,
  result: 'Image generated: /comfyui/view?filename=apple_00001_.png&subfolder=&type=output',
  ...extra,
} as AgentToolCall)

describe('a picture made in the chat shows its prompt', () => {
  it('under the picture, without opening the call, with a button that copies it', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(createElement(ToolCallBlock, { toolCall: call({}) }))
    expect(screen.getByAltText('Generated image')).toBeTruthy()
    expect(screen.getByTestId('tool-media-prompt').textContent).toContain('a red apple on a plate')
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    expect(writeText).toHaveBeenCalledWith('a red apple on a plate')
  })

  it('a clip shows its prompt the same way', () => {
    render(createElement(ToolCallBlock, {
      toolCall: call({ toolName: 'video_generate', args: { prompt: 'a wave breaking on rocks' }, result: 'Video generated: /comfyui/view?filename=wave_00001_.mp4&subfolder=&type=output' }),
    }))
    expect(screen.getByTestId('tool-media-prompt').textContent).toContain('a wave breaking on rocks')
  })

  it('no picture yet, no prompt line', () => {
    render(createElement(ToolCallBlock, { toolCall: call({ status: 'running', result: undefined }) }))
    expect(screen.queryByTestId('tool-media-prompt')).toBeNull()
  })

  it('a call without a prompt shows the picture and no line', () => {
    render(createElement(ToolCallBlock, { toolCall: call({ args: {} }) }))
    expect(screen.getByAltText('Generated image')).toBeTruthy()
    expect(screen.queryByTestId('tool-media-prompt')).toBeNull()
  })

  it('NEGATIVE CONTROL: another tool that shows a picture gets no prompt line', () => {
    render(createElement(ToolCallBlock, { toolCall: call({ toolName: 'screenshot', args: { prompt: 'not a render' } }) }))
    expect(screen.queryByTestId('tool-media-prompt')).toBeNull()
  })
})
