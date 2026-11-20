// The title of the details dialog of a chat model.
//
// It reads "group: name". A model that is the only one of its group carries
// the group's name, and the dialog was headed "Qwen 3.8 35B MoE Distill:
// Qwen 3.8 35B MoE Distill" (persona walk, 09.10.2026, Fund 22). A name
// stands once in the title, on every platform.

export function modelInfoTitle(model: { name: string; group?: string } | null | undefined): string {
  if (!model) return 'Model'
  if (!model.group) return model.name || 'Model'
  if (model.group.trim().toLowerCase() === model.name.trim().toLowerCase()) return model.name
  return `${model.group}: ${model.name}`
}
