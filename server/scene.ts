import type { Scene } from './types'

export const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []

const num = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function unwrapScene(value: unknown): unknown {
  if (isObject(value) && isObject(value.workflow) && isObject(value.workflow.scene)) return value.workflow.scene
  if (isObject(value) && isObject(value.scene)) return value.scene
  return value
}

export function normalizeScene(value: unknown): Scene {
  const candidate = unwrapScene(value)
  if (!isObject(candidate)) throw new Error('模型返回的不是场景对象')
  const scene: Scene = {
    version: 2,
    title: String(candidate.title ?? 'AI白模场景').slice(0, 80),
    walls: asArray(candidate.walls),
    rooms: asArray(candidate.rooms),
    creations: asArray(candidate.creations),
    actors: asArray(candidate.actors),
    props: asArray(candidate.props),
    lights: asArray(candidate.lights),
    sun: isObject(candidate.sun) ? candidate.sun : { enabled: true, visible: false, azimuth: 308, elevation: 53 },
    groundColor: typeof candidate.groundColor === 'string' ? candidate.groundColor : '#e5e5e5',
    roofEnabled: Boolean(candidate.roofEnabled ?? false),
  }
  // Keep the perspective calibration and evidence: the viewer needs the same
  // camera that the model used, and QA needs an auditable structure map.
  if (isObject(candidate.previs)) scene.previs = candidate.previs
  return scene
}

export function validateSceneStructure(scene: Scene): string[] {
  const warnings: string[] = []
  const ids: string[] = []
  for (const group of ['walls', 'rooms', 'creations', 'actors', 'props', 'lights'] as const) {
    for (const item of asArray(scene[group])) {
      if (isObject(item) && item.id) ids.push(String(item.id))
    }
  }
  const counts = new Map<string, number>()
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1)
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort()
  if (duplicates.length) warnings.push('ID重复: ' + duplicates.slice(0, 8).join(', '))

  for (const item of scene.creations) {
    if (!isObject(item)) {
      warnings.push('creations 中存在非对象项')
      continue
    }
    const a = isObject(item.a) ? item.a : {}
    const b = isObject(item.b) ? item.b : {}
    if (!(num(b.x) > num(a.x) && num(b.y) > num(a.y))) {
      warnings.push(`体块 ${item.id ?? '?'} 的 a/b 不是有效矩形`)
    }
    const height = item.height
    if (typeof height !== 'number' || height <= 0 || height > 40) {
      warnings.push(`体块 ${item.id ?? '?'} 高度必须 >0 且 ≤40 格`)
    }
  }

  const previs = scene.previs
  const camera = isObject(previs?.camera) ? previs.camera : null
  if (!camera || !['position', 'target'].every(key => Array.isArray(camera[key]) && camera[key].length === 3)) {
    warnings.push('缺少可用于同机位回放的 previs.camera')
  }
  if (!isObject(previs?.imageComposition)) {
    warnings.push('缺少 imageComposition，无法审计主体在画面中的相对大小')
  }

  const evidence = asArray(previs?.evidence)
  const known = new Set(ids)
  const referenced = new Set<string>()
  for (const entry of evidence) {
    if (!isObject(entry)) continue
    for (const ref of asArray(entry.parts)) referenced.add(String(ref))
  }

  for (const item of scene.creations) {
    if (!isObject(item)) continue
    if (num(item.baseZ) > 0 && !item.support && !referenced.has(String(item.id))) {
      warnings.push(`体块 ${item.id ?? '?'} 悬空且未被结构证据引用`)
    }
  }

  for (const entry of evidence) {
    if (!isObject(entry)) continue
    const missing = asArray(entry.parts).map(ref => String(ref)).filter(ref => !known.has(ref))
    if (missing.length) {
      warnings.push(`结构证据 ${entry.name ?? '?'} 引用了不存在的部件: ${missing.slice(0, 5).join(', ')}`)
    }
    const screen = isObject(entry.screen) ? entry.screen : null
    if (!screen || !Array.isArray(screen.bbox) || screen.bbox.length !== 4) {
      warnings.push(`结构证据 ${entry.name ?? '?'} 缺少 screen.bbox`)
    }
  }
  if (!evidence.length) warnings.push('缺少主要结构 evidence，不能审计主物体是否被遗漏')
  return [...new Set(warnings)]
}

export function repairSceneGeometry(scene: Scene): string[] {
  // Make thin structural proxies renderable without inventing detail. Repairs
  // are recorded because a zero-width column is a model/schema error, not
  // evidence that the source had no width.
  const corrections: string[] = []
  for (const item of scene.creations) {
    if (!isObject(item)) continue
    const a = isObject(item.a) ? item.a : (item.a = {})
    const b = isObject(item.b) ? item.b : (item.b = {})
    if (num(b.x) <= num(a.x)) {
      b.x = num(a.x) + 0.5
      corrections.push(`${item.id ?? '?'}.b.x: zero-width proxy widened to 0.5`)
    }
    if (num(b.y) <= num(a.y)) {
      b.y = num(a.y) + 0.5
      corrections.push(`${item.id ?? '?'}.b.y: zero-depth proxy widened to 0.5`)
    }
    const height = item.height
    if (typeof height === 'number' && height <= 0) {
      item.height = 0.5
      corrections.push(`${item.id ?? '?'}.height: non-positive proxy raised to 0.5`)
    }
  }
  if (corrections.length) {
    if (!isObject(scene.previs)) scene.previs = {}
    const previs = scene.previs
    if (!Array.isArray(previs.corrections)) previs.corrections = []
    previs.corrections.push(...corrections)
  }
  return corrections
}

export function normalizePerspectiveResponse(value: unknown): { scene: Scene; warnings: string[] } {
  const scene = normalizeScene(value)
  repairSceneGeometry(scene)
  const warnings = validateSceneStructure(scene)
  // Output counts are diagnostics, not fidelity gates. A simple white model is
  // allowed as long as its camera and structure evidence are auditable.
  if (warnings.some(warning => warning.includes('缺少可用于同机位') || warning.includes('缺少主要结构'))) {
    throw new Error('模型结果缺少相机或主体结构证据；原工程保持不变')
  }
  // Screen boxes are useful for later QA, but not required to edit the spatial
  // proxies in MONOFORM. Keep the warning; do not throw away usable geometry.
  return { scene, warnings }
}
