import { useCreateStore } from '../../../stores/createStore'
import {
  useCloudCatalogStore, cloudModelById, defaultCloudModel, opPickerModels, modelCostHint, isEditModel, shortCount,
} from '../../../stores/cloudCatalogStore'
import { intentPickerModels, intentRoles, createStudioCost, isStudioModel } from '../../../lib/render/create-studio'
import { resolveCharacterModel, characterGenerationModels } from '../../../hooks/useCloudCreate'
import type { RenderOp } from '../../../lib/render/cloud-jobs'
import type { PresetModel } from '../../../lib/render/preset-models'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useUIStore } from '../../../stores/uiStore'
import { useContentPolicy } from '../../../hooks/useContentPolicy'
import { Select, type SelectOption } from '../ui/Select'
import { TYPE_BADGE } from './badges'
import { resolveLocalOpPick, videoLaneModels } from '../../../api/comfyui'
import { isMlxImageModel } from '../../../api/mlx-image'
import { intentNeedsComfyGraph } from './intents'

// Portplan P7: lipsync/music/extend/motion reach the Studio track through the
// SAME picker as their classic op-specialized twins, one list, matching what
// useCloudCreate.ts and CreditsMeter.tsx already resolve through.
// intentPickerModels() (create-studio.ts, P2) already merges both worlds;
// this only prices each row, since a PresetModel carries no `credits` field.
function pickerCostHint(m: PresetModel, musicDuration: number): string | undefined {
  const classic = cloudModelById(m.id)
  if (classic) return modelCostHint(classic, m.op as RenderOp, m.op === 'music' ? musicDuration : undefined)
  if (isStudioModel(m.id)) {
    // No options chosen yet (this is the picker row, not the run), so use the
    // model's own baseline preview, same figure studio-contract.ts's
    // studioBaseCredits() would compute, just inlined to avoid a second
    // import for one call site.
    const cr = createStudioCost(m.id, {}, 100)
    return `${shortCount(cr)} cr`
  }
  return undefined
}

const CLOUD_BADGE = { label: 'Cloud', color: 'bg-violet-500/15 text-violet-500 dark:text-violet-200' }
// C2: the "No refusals" mark on models the provider ships with its own
// filter off (CloudModel.adult, web parity: apps/web/components/create/
// experimental/ModelChip.tsx). The mark says what the MODEL can do and
// decides nothing itself: while the account's content policy still filters
// (anything but 'off'), it stays pale, since the account setting is the
// boundary, not the model. No adult vocabulary here, this surface sits on
// the payment domain.
const NO_REFUSALS_COLOR = {
  filtering: 'text-gray-500 dark:text-gray-600',
  open: 'text-purple-600 dark:text-purple-300',
}

// Local-mode discovery (2.5.8): hosted models ride at the bottom of the local
// picker as teaser rows — picking one opens the Cloud sheet instead of
// changing the selection. Value prefix keeps them apart from real checkpoints.
const TEASER_PREFIX = 'lu-cloud-teaser:'
const TEASER_ROWS = 4

// Badge-aware model picker (replaces the raw <select>). Local backend lists
// the installed checkpoints; the cloud backend lists the hosted catalog
// (server-driven via cloudCatalogStore) and writes the cloud model slugs.
export function ModelChip() {
  const backend = useCreateStore((s) => s.backend)
  return backend === 'cloud' ? <CloudModelChip /> : <LocalModelChip />
}

function CloudModelChip() {
  const mode = useCreateStore((s) => s.mode)
  const intent = useCreateStore((s) => s.intent())
  const characterTab = useCreateStore((s) => s.characterTab)
  const selectedCharacter = useCreateStore((s) => s.selectedCharacter)
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const setCloudImageModel = useCreateStore((s) => s.setCloudImageModel)
  const setCloudVideoModel = useCreateStore((s) => s.setCloudVideoModel)
  const setCloudOpModel = useCreateStore((s) => s.setCloudOpModel)
  // Subscribed, not read once: the music sublabel must follow the length
  // slider live so the shown price is the billed price (A3, sockenmonster).
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const models = useCloudCatalogStore((s) => s.models)
  const contentPolicy = useContentPolicy()

  const isVideo = mode === 'video'
  const kind = isVideo ? 'video' : 'image'
  const characterUse = intent === 'character' && characterTab === 'use'
  // The 2.5.8 specialized intents pick from their op's own family (both
  // trainer kinds together for Character-Studio TRAIN) and store into
  // cloudOpModel. Character-Studio USE is its own thing: it picks a
  // GENERATION endpoint compatible with the trained LoRA's family, not a
  // trainer. A picker showing trainers there would be a lie (uselu main
  // 5be5dec3).
  const special =
    (intent === 'character' && !characterUse) || intent === 'lipsync' || intent === 'music' ||
    intent === 'extend' || intent === 'motion'
  // Portplan P7: lipsync/music/extend/motion reach the Studio track through
  // the SAME picker as their classic op-specialized twins.
  // intentPickerModels() (create-studio.ts, P2) already merges both worlds.
  const roleIntent = !characterUse && intentRoles(intent).length > 0
  const roleModels: PresetModel[] = roleIntent ? intentPickerModels(intent) : []
  const characterModels = characterUse ? characterGenerationModels(selectedCharacter?.family ?? '') : []
  // List only the models that can run the current op — otherwise the picker
  // offers checkpoints that useCloudCreate silently swaps out at submit, so the
  // user's choice was a lie. Edit needs masked-img2img (flux-dev); Animate needs
  // i2v; Video needs t2v (absent flag = capable, so today's dual-capable fleet
  // lists in full, and a future t2v-only model that sets i2v:false is excluded).
  const list =
    // R5-58: `m.edit` alone missed the 2.5.8 op-specialized edit endpoints
    // (qwen-image-edit carries `ops: ['edit']`, not `edit: true`), so the
    // picker never offered a model the catalog genuinely served.
    intent === 'edit' ? models.filter((m) => m.kind === 'image' && isEditModel(m))
    : intent === 'animate' ? models.filter((m) => m.kind === 'video' && m.i2v !== false)
    : intent === 'video' ? models.filter((m) => m.kind === 'video' && m.t2v !== false)
    : intent === 'character' && !characterUse ? opPickerModels('lora-train')
    : models.filter((m) => m.kind === kind && !m.ops)
  const current = characterUse
    ? (resolveCharacterModel(selectedCharacter?.family ?? '', cloudOpModel) ?? '')
    : special || roleIntent
      ? cloudOpModel
      : (isVideo ? cloudVideoModel : cloudImageModel) || defaultCloudModel(kind)?.id || ''
  // Reflect the model the run will really use, so a leftover pick the current op
  // can't perform doesn't show as "selected".
  const roleOrCharacterIds = roleIntent ? roleModels : characterModels
  const value = roleIntent || characterUse
    ? (roleOrCharacterIds.some((m) => m.id === current) ? current : (roleOrCharacterIds[0]?.id ?? current))
    : list.some((m) => m.id === current) ? current : (list[0]?.id ?? current)

  // The op this picker's models will run as, so the sublabel prices correctly
  // (a trainer bills a training run, not an image).
  const op: RenderOp =
    characterUse ? 'generate'
    : intent === 'character' ? 'lora-train'
    : intent === 'lipsync' ? 'lipsync'
    : intent === 'music' ? 'music'
    : intent === 'extend' ? 'extend'
    : intent === 'motion' ? 'motion'
    : intent === 'edit' ? 'edit'
    : intent === 'animate' ? 'animate'
    : 'generate'
  const options: SelectOption[] = roleIntent
    ? roleModels.map((m) => ({
        value: m.id,
        label: m.label,
        sublabel: pickerCostHint(m, musicDuration),
        badge: m.adult
          ? { label: 'No refusals', color: contentPolicy === 'off' ? NO_REFUSALS_COLOR.open : NO_REFUSALS_COLOR.filtering }
          : CLOUD_BADGE,
      }))
    : characterUse
      ? characterModels.map((m) => ({
          value: m.id,
          label: m.label,
          sublabel: modelCostHint(m, 'generate', undefined),
          badge: m.adult
            ? { label: 'No refusals', color: contentPolicy === 'off' ? NO_REFUSALS_COLOR.open : NO_REFUSALS_COLOR.filtering }
            : CLOUD_BADGE,
        }))
      : list.map((m) => ({
          value: m.id,
          label: m.label,
          sublabel: modelCostHint(m, op, op === 'music' ? musicDuration : undefined),
          // adult models keep the standard Cloud badge everywhere EXCEPT the row
          // itself, where "No refusals" is strictly more informative, matching web.
          badge: m.adult
            ? { label: 'No refusals', color: contentPolicy === 'off' ? NO_REFUSALS_COLOR.open : NO_REFUSALS_COLOR.filtering }
            : CLOUD_BADGE,
        }))

  return (
    <Select
      size="sm"
      searchable
      align="right"
      className="min-w-[150px] max-w-[230px]"
      options={options}
      value={value}
      onChange={(v) =>
        special || roleIntent || characterUse ? setCloudOpModel(v) : isVideo ? setCloudVideoModel(v) : setCloudImageModel(v)
      }
    />
  )
}

function LocalModelChip() {
  const mode = useCreateStore((s) => s.mode)
  const intent = useCreateStore((s) => s.intent())
  const imageModel = useCreateStore((s) => s.imageModel)
  const videoModel = useCreateStore((s) => s.videoModel)
  const localOpModel = useCreateStore((s) => s.localOpModel)
  const imageModelList = useCreateStore((s) => s.imageModelList)
  const videoModelList = useCreateStore((s) => s.videoModelList)
  const audioModelList = useCreateStore((s) => s.audioModelList)
  const lipsyncModelList = useCreateStore((s) => s.lipsyncModelList)
  const motionModelList = useCreateStore((s) => s.motionModelList)
  const setImageModel = useCreateStore((s) => s.setImageModel)
  const setVideoModel = useCreateStore((s) => s.setVideoModel)
  const setLocalOpModel = useCreateStore((s) => s.setLocalOpModel)
  const teasersEnabled = useSettingsStore((s) => s.settings.cloudTeasersEnabled)
  const setCloudTeaser = useUIStore((s) => s.setCloudTeaser)
  const catalogModels = useCloudCatalogStore((s) => s.models)

  const isVideo = mode === 'video'
  // The 2.5.8 lanes with their own local model families. Extend is NOT here:
  // it rides the regular i2v-capable video list (last-frame continue).
  const laneList =
    intent === 'music' ? audioModelList
    : intent === 'lipsync' ? lipsyncModelList
    : intent === 'motion' ? motionModelList
    : null

  // Mirror the cloud picker's op-gating (David 2026-07-17: "only offer models
  // that can actually do it"): Animate/Extend list i2v-capable local models,
  // Video lists t2v-capable ones (SVD/FramePack are i2v-only and drop there).
  // Shared with Stage's missing-models gate so card and picker cannot drift.
  const rawList = isVideo ? videoModelList : imageModelList
  const laneFiltered = laneList ?? (!isVideo ? rawList : videoLaneModels(rawList, intent))
  // Comfy graphs cannot load an "MLX …" row. Hide those names on every intent
  // that submits a checkpoint, so the chip cannot offer the id that
  // CheckpointLoaderSimple then rejects.
  // Edit/expand of an MLX model stays on the MLX lane, so those rows stay
  // in the chip. Other Comfy intents have no MLX path and must not offer them.
  const list = intentNeedsComfyGraph(intent) && intent !== 'edit'
    ? laneFiltered.filter((m) => !isMlxImageModel(m.name))
    : laneFiltered
  const stored = laneList ? localOpModel : (isVideo ? videoModel : imageModel)
  // Reflect the model the run will really use — a leftover pick the current
  // op can't perform must not show as "selected". Lanes share the submit-side
  // rule (resolveLocalOpPick) so chip, meter and run always agree.
  const value = laneList
    ? resolveLocalOpPick(stored, list)
    : list.some((m) => m.name === stored) ? stored : (list[0]?.name ?? stored)

  const options: SelectOption[] = list.map((m) => ({
    value: m.name,
    label: prettyName(m.name),
    badge: TYPE_BADGE[m.type],
  }))
  // Discovery rows: a few hosted models of this kind at the list's tail.
  // Picking one opens the Cloud sheet; the local selection stays untouched.
  if (teasersEnabled && !laneList) {
    const kind = isVideo ? 'video' : 'image'
    for (const m of catalogModels.filter((c) => c.kind === kind && !c.ops).slice(0, TEASER_ROWS)) {
      options.push({
        value: `${TEASER_PREFIX}${m.id}`,
        label: m.label,
        sublabel: modelCostHint(m, 'generate'),
        badge: CLOUD_BADGE,
      })
    }
  }

  return (
    <Select
      size="sm"
      searchable
      align="right"
      className="min-w-[150px] max-w-[230px]"
      options={options}
      value={value}
      onChange={(v) => {
        if (v.startsWith(TEASER_PREFIX)) {
          setCloudTeaser({
            surface: 'create-model',
            kind: isVideo ? 'video' : 'image',
            modelId: v.slice(TEASER_PREFIX.length),
          })
          return
        }
        if (laneList) setLocalOpModel(v)
        else if (isVideo) setVideoModel(v)
        else {
          const m = list.find((x) => x.name === v)
          setImageModel(v, m?.type ?? 'unknown')
        }
      }}
    />
  )
}

function prettyName(filename: string): string {
  return filename.replace(/\.(safetensors|ckpt|pt|gguf)$/i, '').replace(/[_]+/g, ' ')
}
