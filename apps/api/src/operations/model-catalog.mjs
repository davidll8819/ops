// Output capabilities matter: image INPUT alone does not mean image generation.
export function classifyModel(model) {
  const id = model.id.toLowerCase()
  const kinds = new Set()
  const values = value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  const output = values(model.output_modalities ?? model.architecture?.output_modalities).map(v => String(v).toLowerCase())
  const capabilities = Array.isArray(model.capabilities) ? model.capabilities : Object.entries(model.capabilities || {}).filter(([,v]) => v === true).map(([k]) => k)
  const hints = [...values(model.type), ...values(model.model_type), ...values(model.task), ...values(model.mode), ...values(model.supported_endpoint_types), ...capabilities].join(' ').toLowerCase()
  const explicit = String(model.type ?? model.model_type ?? '').toLowerCase()
  if (explicit === 'image' || output.includes('image') || /image[-_ ]?(generation|edit)|text[-_ ]to[-_ ]image|images\/generations/.test(hints)) kinds.add('image')
  if (explicit === 'video' || output.includes('video') || /video[-_ ]?generation|text[-_ ]to[-_ ]video|videos\/generations/.test(hints)) kinds.add('video')
  if (['chat','text','llm'].includes(explicit) || output.includes('text') || /chat|completion|language|reasoning/.test(hints)) kinds.add('text')
  if (kinds.size) return { kinds:[...kinds], source:'metadata' }
  if (/grok.*video|happyhorse|sora|veo(?:[-_.\d]|$)|kling|seedance|wan(?!.*t2i)(?:[-_.\d]|$)|hailuo|runway|luma|vidu|hunyuan[-_]?video/.test(id)) return {kinds:['video'],source:'name'}
  if (/wan.*t2i|dall[-_]?e|gpt[-_]?image|imagen|flux|stable[-_]?diffusion|sdxl|seedream|ideogram|recraft|midjourney|nano[-_]?banana|qwen[-_]?image|image[-_]?preview|image[-_]?generation/.test(id)) return {kinds:['image'],source:'name'}
  if (/whisper|tts|embedding|rerank|moderation|transcri|audio|speech/.test(id)) return {kinds:['other'],source:'name'}
  if (/gpt|claude|gemini|deepseek|qwen|llama|mistral|glm|minimax|moonshotai|grok|doubao|kimi|ernie|(?:^|\/)o[134](?:-|$)/.test(id)) return {kinds:['text'],source:'name'}
  return {kinds:['unknown'],source:'unknown'}
}
export function modelCatalog(data) {
  const seen = new Set()
  return (Array.isArray(data?.data) ? data.data : []).filter(m => {
    if (!m || typeof m.id !== 'string' || !m.id.trim() || m.id.length > 150 || seen.has(m.id)) return false
    seen.add(m.id); return true
  }).map(m => ({id:m.id,...classifyModel(m)})).sort((a,b) => a.id.localeCompare(b.id))
}
