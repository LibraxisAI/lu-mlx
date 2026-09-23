import {
  Image as ImageIcon, Wand2, Scissors, Video, Film, Maximize2, Eraser,
  UserRound, Mic, Music, FastForward, PersonStanding,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CreateBackend, CreateIntent } from '../../../stores/createStore'

export interface IntentMeta {
  id: CreateIntent
  label: string
  short: string
  icon: LucideIcon
  placeholder: string
  needsSource: boolean
  needsPrompt: boolean
  allowsMask: boolean
  isVideo: boolean
  /** Capability id (node probe) this intent depends on, if any. */
  capability?: 'rmbg' | 'inpaint-nodes' | 'dwpose'
  /** Categories with a hosted endpoint (cloud clip/teaser exists). */
  cloudOnly?: true
  /** 2.5.8: cloudOnly categories that ALSO run on the local ComfyUI backend
   *  (mirrors createStore's LOCAL_LANE_OPS). The IntentBar unlocks these in
   *  local mode; the cloud glyph becomes a "Try cloud" affordance. */
  hasLocalLane?: true
  /** The local lane exists only in the Mac fork (a ComfyUI the user already
   *  runs, connected on its port). Windows/Linux keep the LU Cloud teaser: their
   *  local version is a plain resize / checkpoint inpaint, weaker than the
   *  hosted tool, so it must not replace it there. */
  localLaneMacOnly?: true
  /** Local model files this intent needs (gates the Download & install card). */
  requiresModels?: 'image' | 'video' | 'audio' | 'lipsync' | 'motion'
  examples: string[]
}

export const INTENTS: IntentMeta[] = [
  {
    id: 'image', label: 'Image', short: 'Image', icon: ImageIcon,
    placeholder: 'Describe your image…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    requiresModels: 'image',
    examples: [
      'a lighthouse at dusk, dramatic storm clouds, cinematic',
      'a neon alley in the rain, reflections, moody',
      'a cozy reading nook by a window, warm morning light',
    ],
  },
  {
    // This IS the image-to-image tab. Source + empty mask restyles the WHOLE
    // image (VAEEncode at denoise 0.7, dynamic-workflow isI2I); painting a mask
    // switches to inpaint (VAEEncodeForInpaint / InpaintModelConditioning) on
    // the SDXL/SD1.5 checkpoint path. Cloud keeps its hosted edit endpoint; both
    // share the MaskEditor. Renamed 2.5.9: "Edit" alone hid the i2i entry for
    // the r/SD crowd who search for "image to image" (GH D#86 jendrelele /
    // the_mr_pickles / pnwpdr4519; David committed to making it clearer).
    id: 'edit', label: 'Edit / Image to Image', short: 'Edit', icon: Wand2,
    placeholder: 'Describe the new look. Leave the mask empty to restyle the whole image, or paint an area to change just that…',
    needsSource: true, needsPrompt: true, allowsMask: true, isVideo: false,
    capability: 'inpaint-nodes', requiresModels: 'image',
    examples: ['turn this photo into a watercolor painting', 'make it a snowy winter scene', 'repaint it in a neon cyberpunk style'],
  },
  {
    id: 'removebg', label: 'Remove Background', short: 'Cutout', icon: Scissors,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    capability: 'rmbg',
    examples: [],
  },
  {
    // R5-67: label/short renamed to match apps/web/components/create/
    // experimental/intents.ts ("Enhance Image" / "Enhance"). The id stays
    // 'upscale' on purpose, a saved gallery result or a stored createStore
    // state references intents by id, and renaming that too would strand
    // them. Web's separate 'video_upscale' intent is a feature decision for
    // David (does the Desktop get video upscaling at all), not a text fix,
    // and is out of scope here.
    id: 'upscale', label: 'Enhance Image', short: 'Enhance', icon: Maximize2,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true, localLaneMacOnly: true,
    examples: [],
  },
  {
    id: 'eraser', label: 'Erase Object', short: 'Erase', icon: Eraser,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: true, isVideo: false,
    cloudOnly: true, hasLocalLane: true, localLaneMacOnly: true, requiresModels: 'image',
    examples: [],
  },
  {
    id: 'video', label: 'Video', short: 'Video', icon: Video,
    placeholder: 'Describe the motion and the scene…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    requiresModels: 'video',
    examples: ['a wave breaking on rocks in slow motion, cinematic', 'timelapse of clouds over a mountain range'],
  },
  {
    // Local lane restored 2026-07-17 (David): the lu-labs port had marked
    // animate cloudOnly, which silently dropped the local I2V the old Create
    // tab always had. Local builds route through buildDynamicWorkflow's
    // family-specific I2V wiring (WAN/WAN2.2/Hunyuan/LTX/Cosmos/SVD/FramePack);
    // the model picker only offers i2v-capable models here.
    id: 'animate', label: 'Animate Image', short: 'Animate', icon: Film,
    placeholder: 'Describe how the image should move…',
    needsSource: true, needsPrompt: true, allowsMask: false, isVideo: true,
    requiresModels: 'video',
    examples: ['slow zoom in, subtle parallax', 'hair and clothes moving in the wind'],
  },

  // ── 2.5.8 specialized categories (2026-07-17 David). All have hosted
  // endpoints (cloudOnly = cloud clip/teaser exists); music, lipsync, extend
  // and motion ALSO run locally (hasLocalLane) on core ComfyUI node families
  // (ACE audio, Wan S2V, I2V last-frame chain, Wan VACE/Animate). Their
  // composer surfaces own the extra inputs (training set, audio, driving
  // video, extend pick), so needsSource / needsPrompt describe only the
  // shared composer scaffolding. ──
  {
    // 2.6.0 ships the local trainer runtime (trainer.rs installs the pinned
    // musubi-tuner venv, the Z-Image bases ride the regular download
    // pipeline), so the local lane is real now. Without hasLocalLane the bar
    // rendered the finished feature as a locked cloud teaser and a local
    // user could never reach LocalTrainControls at all (found 2026-08-01 on
    // the real Windows bundle). No requiresModels here: the lane runs its
    // own three gates (trainer env, base files, photos).
    id: 'character', label: 'Character Studio', short: 'Character', icon: UserRound,
    placeholder: 'Describe the scene for your character…',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true,
    examples: [],
  },
  {
    // Inputs (portrait or base clip + speech audio) are composer chips, not
    // the Stage source slot — which input the model needs depends on the
    // picked endpoint (photo-avatar vs re-sync).
    id: 'lipsync', label: 'Talking Character', short: 'Lipsync', icon: Mic,
    placeholder: '',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'lipsync',
    examples: [],
  },
  {
    id: 'music', label: 'Music', short: 'Music', icon: Music,
    placeholder: 'Describe the track. Genre, mood, tempo, instruments…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'audio',
    examples: [
      'dreamy lofi hip hop, vinyl crackle, mellow keys',
      'epic orchestral trailer, driving percussion',
      'upbeat synthwave, retro 80s arps',
    ],
  },
  {
    // Local lane: the picked clip's LAST FRAME becomes the I2V start image,
    // so it gates on the regular video models like animate does.
    id: 'extend', label: 'Extend Video', short: 'Extend', icon: FastForward,
    placeholder: 'Describe how the clip should continue…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'video',
    examples: [],
  },
  {
    // Local lane on Wan VACE/Animate + DWPose (comfyui_controlnet_aux).
    // DWPose imports fine on Windows (falls back to OpenCV on CPU when
    // onnxruntime-gpu is absent — slower, not broken); the pack only shows
    // up after a ComfyUI restart, which installCapability performs.
    id: 'motion', label: 'Motion Control', short: 'Motion', icon: PersonStanding,
    placeholder: 'Optional: extra style/scene hints…',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: true,
    capability: 'dwpose',
    cloudOnly: true, hasLocalLane: true, requiresModels: 'motion',
    examples: [],
  },
]

export const INTENT_MAP: Record<CreateIntent, IntentMeta> =
  Object.fromEntries(INTENTS.map((i) => [i.id, i])) as Record<CreateIntent, IntentMeta>

/**
 * Intents that have a REAL local pipeline on an MLX-only Mac (no ComfyUI
 * connected). Text-to-image and text-to-video run in-process (api/mlx-image.ts,
 * api/mlx-video.ts). Character Studio trains through the musubi runtime
 * (trainer.rs) — that is not a ComfyUI graph. Everything else on this host is
 * a ComfyUI graph or a ComfyUI-staged source, so it stays locked until the
 * user's already-running ComfyUI answers (connect-only).
 */
const MLX_LOCAL_INTENTS: ReadonlySet<CreateIntent> = new Set<CreateIntent>(['image', 'video', 'character'])

/**
 * True when this Apple Silicon Mac has no ComfyUI connected, so local Create
 * is the MLX + trainer subset. A connected ComfyUI is a real local backend —
 * edit / cutout / upscale / eraser / animate and the 2.5.8 lanes run there.
 * Pure so IntentBar, teasers, Expert knobs and tests share one switch.
 */
export function mlxOnlyCreateHost(isMlx: boolean, comfyRunning: boolean): boolean {
  return isMlx && !comfyRunning
}

/** Intents whose local run is a ComfyUI graph (or needs a Comfy checkpoint). */
export function intentNeedsComfyGraph(id: CreateIntent): boolean {
  return id === 'edit' || id === 'removebg' || id === 'upscale' || id === 'eraser'
    || id === 'animate' || id === 'extend' || id === 'lipsync' || id === 'music' || id === 'motion'
}

/**
 * The intents to surface for a given backend + host. Pure so the rule is unit
 * tested instead of buried in the IntentBar's JSX.
 *
 * Cloud shows everything. Local ComfyUI hosts (Windows/Linux, and a Mac with
 * ComfyUI connected) also show everything — hosted-only tools with no
 * local lane would render as locked teasers, but every Create intent now has a
 * local lane when that backend exists. An MLX-only Mac hides the intents that
 * have neither an MLX/trainer path nor a hosted teaser sheet (edit, removebg,
 * animate): they need a ComfyUI node or a ComfyUI-staged source, so leaving
 * them selectable is a dead affordance (MLX generate silently drops source +
 * mask and returns an unrelated fresh image).
 */
export function visibleIntents(backend: CreateBackend, mlxHost: boolean): IntentMeta[] {
  if (backend === 'cloud' || !mlxHost) return INTENTS
  return INTENTS.filter((m) => MLX_LOCAL_INTENTS.has(m.id) || m.cloudOnly === true)
}

/**
 * Whether an intent renders as a locked cloud teaser instead of a selectable
 * local tab. Cloud never locks. On local ComfyUI hosts only the genuinely
 * hosted-only tools lock (the 2.5.8 lanes with hasLocalLane are real local
 * tabs). On an MLX Mac every non-MLX intent that survives visibleIntents locks
 * — those lanes' "local" implementation is a ComfyUI graph this host does not
 * have, so the honest state is the cloud teaser, not a working-looking pill.
 */
export function isIntentLocked(
  meta: IntentMeta,
  backend: CreateBackend,
  mlxHost: boolean,
  macHost = false,
): boolean {
  if (backend === 'cloud') return false
  if (mlxHost) return !MLX_LOCAL_INTENTS.has(meta.id)
  if (meta.localLaneMacOnly && !macHost) return meta.cloudOnly === true
  return meta.cloudOnly === true && !meta.hasLocalLane
}

/**
 * Whether an intent is reachable as a working tab (shown AND not a locked
 * teaser) for this backend + host. Same rule as the IntentBar, exposed for the
 * result actions that FORCE-switch to an intent — "Edit with mask" on a
 * finished image used to set 'edit' even where that lane cannot run.
 */
export function isIntentAvailable(
  id: CreateIntent,
  backend: CreateBackend,
  mlxHost: boolean,
  macHost = false,
): boolean {
  const meta = INTENT_MAP[id]
  return visibleIntents(backend, mlxHost).includes(meta) && !isIntentLocked(meta, backend, mlxHost, macHost)
}
