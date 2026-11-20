// Settings, General, Hardware on a Mac.
//
// The PC version of this section is a GPU picker: vendor, device index and the
// CUDA / HIP / ONEAPI variables it forwards to Ollama and ComfyUI. None of that
// exists on Apple Silicon. There is one chip, one memory pool shared by
// processor and graphics, and Metal picks nothing because there is nothing to
// pick. Showing the picker with the chip listed as a "GPU" let a Mac user save
// a CUDA setting that does nothing, and hiding the section left Settings
// silent about the hardware altogether. This says what is there, and offers
// no control.

import { useEffect, useState } from 'react'
import { Cpu } from 'lucide-react'
import { backendCall } from '../../api/backend'
import { getSharedMemoryGb } from '../../lib/hardware'
import { Hinweis } from '../ui/Hinweis'

interface DetectedChip {
  vendor: string
  name: string
}

export interface AppleHardware {
  chip: string | null
  memoryGb: number | null
}

/**
 * The two readings as one answer. The chip name is the Apple entry of
 * `detect_gpus`; the memory is `getSharedMemoryGb` (that entry's
 * `shared_memory_mib`, with `system_info` behind it). Both fail soft: an
 * unknown value is shown as unknown, not as zero.
 */
export async function readAppleHardware(): Promise<AppleHardware> {
  const [gpus, pool] = await Promise.all([
    backendCall<DetectedChip[]>('detect_gpus').catch(() => [] as DetectedChip[]),
    getSharedMemoryGb(),
  ])
  const list = Array.isArray(gpus) ? gpus : []
  const entry = list.find((g) => g.vendor === 'apple') ?? list[0]
  return {
    chip: entry?.name?.trim() || null,
    memoryGb: pool > 0 ? Math.round(pool) : null,
  }
}

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-3 t-micro">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-700 dark:text-gray-300 text-right" data-testid={testId}>{value}</span>
    </div>
  )
}

export function AppleHardwareInfo() {
  const [hw, setHw] = useState<AppleHardware | null>(null)

  useEffect(() => {
    let alive = true
    readAppleHardware()
      .then((r) => { if (alive) setHw(r) })
      .catch(() => { if (alive) setHw({ chip: null, memoryGb: null }) })
    return () => { alive = false }
  }, [])

  return (
    <div className="space-y-2" data-testid="apple-hardware">
      <Hinweis icon={<Cpu size={11} className="shrink-0 mt-[3px]" />}>
        A Mac has one chip and one pool of memory that processor and graphics share, so there is no graphics card to pick. Models run on Metal.
      </Hinweis>
      <div className="rounded-lg border border-gray-200 dark:border-white/[0.06] p-2.5 space-y-1.5">
        <Row label="Chip" value={hw === null ? 'Detecting' : hw.chip ?? 'Apple Silicon'} testId="apple-hardware-chip" />
        <Row
          label="Memory"
          value={hw === null ? 'Detecting' : hw.memoryGb !== null ? `${hw.memoryGb} GB, shared by processor and graphics` : 'Not detected'}
          testId="apple-hardware-memory"
        />
        <Row label="Graphics" value="Metal" testId="apple-hardware-graphics" />
      </div>
    </div>
  )
}
