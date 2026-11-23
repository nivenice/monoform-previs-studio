const round = value => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const rounded = Math.round(number * 100) / 100
  return Object.is(rounded, -0) ? 0 : rounded
}

const vector = value => Array.isArray(value) && value.length === 3 ? value.map(round) : []

const shortText = (value, length = 80) => String(value || '').slice(0, length)

// The model gets a compact, read-only snapshot; full object/keyframe data stays in
// the renderer so a long project cannot blow up the prompt.
export function buildSceneContext(source = {}) {
  const objects = Array.isArray(source.objects) ? source.objects : []
  const maxObjects = 40
  const listed = objects.slice(0, maxObjects).map(object => ({
    id: shortText(object.id, 80),
    name: shortText(object.name, 80),
    type: shortText(object.type, 40),
    position: vector(object.position),
    scale: vector(object.scale),
    ...(object.locked ? { locked: true } : {}),
    ...(object.visible === false ? { hidden: true } : {}),
  }))
  const shots = Array.isArray(source.shots)
    ? source.shots.map(shot => ({
        name: shortText(shot.name, 60),
        fps: Number(shot.fps) || 0,
        durationSeconds: Number(shot.durationSeconds) || 0,
      }))
    : []
  const camera = source.camera && typeof source.camera === 'object' ? source.camera : {}
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {}
  return {
    project: shortText(settings.name, 60),
    activeShot: shortText(source.activeShotName, 60),
    shots,
    objects: listed,
    objectCount: objects.length,
    truncated: objects.length > maxObjects,
    camera: {
      position: vector(camera.position),
      focalLength: round(camera.focalLength),
      aspectRatio: shortText(camera.aspectRatio, 20),
      ...(Array.isArray(camera.target) ? { target: vector(camera.target) } : {}),
    },
    timeline: {
      currentFrame: Math.round(Number(source.currentFrame) || 0),
      fps: Number(source.fps) || 0,
      durationSeconds: Number(settings.durationSeconds) || 0,
    },
    selectedId: shortText(source.selectedId, 80),
  }
}

export function stringifySceneContext(source = {}) {
  return JSON.stringify(buildSceneContext(source))
}
