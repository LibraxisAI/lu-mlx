import { useCreateStore } from '../../../stores/createStore'
import { MAX_IMAGE_COUNT, imageCountApplies } from '../../../lib/render/image-count'
import { useRunCredits } from './useRunCredits'
import { Slider } from '../ui/Slider'

// Images per cloud run, each one its own job with its own price. The slider
// sits in the advanced settings above the model's own controls, so it is there
// for every model an Image or Edit run can use: the start reads the number
// under the same rule (runImageCount), and a number nobody can reach would
// multiply a run unseen. Above one image the slider names what the run binds.
// Local keeps the ComfyUI queue's batch size (ParamGroups).
export function ImageCount() {
  const intent = useCreateStore((s) => s.intent())
  const cloud = useCreateStore((s) => s.backend === 'cloud')
  const count = useCreateStore((s) => s.cloudImageCount)
  const setCount = useCreateStore((s) => s.setCloudImageCount)
  const run = useRunCredits()
  if (!cloud || !imageCountApplies(intent)) return null
  return (
    <div className="pb-3">
      <Slider
        label="Images" min={1} max={MAX_IMAGE_COUNT} step={1} value={count} onChange={setCount}
        format={(v) => (v > 1 && run ? `${v}, ${run.cost} credits in all` : String(v))}
      />
    </div>
  )
}
