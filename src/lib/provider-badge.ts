// The small marks beside a backend in Settings, AI Backends: DEFAULT, LOCAL,
// CLOUD.
//
// They were written for the dark theme: purple 300, green 400 and blue 400 on
// a faint tint. On white that is a contrast of about 1.9, 1.7 and 2.5 to 1,
// and "DEFAULT" beside the LU Engine could hardly be read (persona walk,
// 09.10.2026, Fund 29). In the light theme they are written in the dark step
// of the same colour, on every platform. The dark theme keeps its colours.

export type ProviderBadge = 'default' | 'local' | 'cloud'

const BASE = 'text-[0.5rem] px-1 py-0.5 rounded shrink-0'

/** Readable on white, the first colours in the dark theme. */
const COLOUR: Record<ProviderBadge, string> = {
  default: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  local: 'bg-green-500/10 text-green-800 dark:text-green-400',
  cloud: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
}

export function providerBadgeClass(badge: ProviderBadge): string {
  return `${BASE} ${COLOUR[badge]}`
}
