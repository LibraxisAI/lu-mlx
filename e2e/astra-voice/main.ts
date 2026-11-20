// Page side of scripts/astra-voice-browser-e2e.mjs. Runs the real
// @pipecat-ai/client-js with the real WebSocket transport against a running
// voice loop sidecar, the way the Astra surface will. Not part of the app.
import { PipecatClient, RTVIEvent, RTVIMessage, RTVIMessageType } from '@pipecat-ai/client-js'
import type { APIRequest, LLMFunctionCallInProgressData } from '@pipecat-ai/client-js'
import { WebSocketTransport, WavMediaManager } from '@pipecat-ai/websocket-transport'

interface ProofOptions {
  endpoint: string
  token: string
  config: APIRequest['requestData']
  timeoutMs: number
}
interface ProofEvent { t: number; name: string; detail?: unknown }

// What the runner reads back. proofTrace is there while a run is still going.
const proof = window as unknown as { proofOptions?: ProofOptions; proofResult?: unknown; proofTrace?: ProofEvent[] }

async function runVoiceProof(options: ProofOptions) {
  const t0 = performance.now()
  const events: ProofEvent[] = []
  proof.proofTrace = events
  const mark = (name: string, detail?: unknown) => { events.push({ t: Math.round(performance.now() - t0), name, detail }) }
  let botAudioChunks = 0
  let toolCalls = 0

  // The plain getUserMedia recorder. The transport's default media manager
  // loads Daily's call bundle from the network, which a local app must not do.
  const media = new WavMediaManager(512, 16_000)
  const buffer = media.bufferBotAudio.bind(media)
  media.bufferBotAudio = (data: ArrayBuffer | Int16Array, id?: string) => {
    if (botAudioChunks++ === 0) mark('first-bot-audio')
    return buffer(data, id)
  }
  const transport = new WebSocketTransport({ mediaManager: media, recorderSampleRate: 16_000 })
  const client = new PipecatClient({ transport, enableMic: true, enableCam: false })

  const finished = new Promise<string>((resolve) => {
    let answered = false
    client.on(RTVIEvent.BotReady, (data) => mark('bot-ready', data))
    client.on(RTVIEvent.UserStartedSpeaking, () => mark('user-started-speaking'))
    client.on(RTVIEvent.UserStoppedSpeaking, () => mark('user-stopped-speaking'))
    client.on(RTVIEvent.UserTranscript, (data) => mark('user-transcript', { final: data.final, chars: data.text.length }))
    client.on(RTVIEvent.BotLlmStarted, () => mark('bot-llm-started'))
    client.on(RTVIEvent.BotTtsStarted, () => mark('bot-tts-started'))
    client.on(RTVIEvent.BotStartedSpeaking, () => mark('bot-started-speaking'))
    client.on(RTVIEvent.Error, (message) => mark('error', message.data))
    client.on(RTVIEvent.Disconnected, () => resolve('disconnected'))
    client.on(RTVIEvent.LLMFunctionCallInProgress, (data: LLMFunctionCallInProgressData) => {
      toolCalls++
      mark('tool-call', { name: data.function_name, arguments: data.arguments })
      // The message the app's VoiceToolBridge sends after running the tool.
      client.transport.sendMessage(new RTVIMessage(RTVIMessageType.LLM_FUNCTION_CALL_RESULT, {
        function_name: data.function_name, tool_call_id: data.tool_call_id, arguments: data.arguments ?? {},
        result: { status: 'completed', text: 'It is 14:32 on Tuesday.', truncated: false },
      }))
      answered = true
    })
    client.on(RTVIEvent.LLMFunctionCallStopped, (data) => mark('tool-call-stopped', { cancelled: data.cancelled }))
    client.on(RTVIEvent.BotStoppedSpeaking, () => {
      mark('bot-stopped-speaking')
      if (answered) resolve('answered')
    })
    setTimeout(() => resolve('timeout'), options.timeoutMs)
  })

  // Devices first, straight from the click: WebKit only starts an
  // AudioContext while the user gesture is still fresh, and the session
  // request below would use it up.
  await client.initDevices()
  mark('devices-ready')
  await client.startBotAndConnect({
    endpoint: options.endpoint,
    headers: new Headers({ Authorization: `Bearer ${options.token}` }),
    requestData: options.config,
  })
  mark('connected')
  const outcome = await finished
  await client.disconnect()
  return { outcome, events, botAudioChunks, toolCalls }
}

// Started by a real click: WebKit only lets an AudioContext run after a user
// gesture, exactly as it will inside the app.
const state = document.getElementById('state')!
document.getElementById('start')!.addEventListener('click', () => {
  state.textContent = 'running'
  runVoiceProof(proof.proofOptions!)
    .then((result) => { proof.proofResult = result })
    .catch((error) => { proof.proofResult = { outcome: `threw: ${String(error)}`, events: [], botAudioChunks: 0, toolCalls: 0 } })
    .finally(() => { state.textContent = 'done' })
})
state.textContent = 'ready'
