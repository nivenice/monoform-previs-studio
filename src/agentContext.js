import { RIG_PRESETS, normalizePoseId } from './rig.js'
import { normalizeBodyType } from './personBodyType.js'

const round = value => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const rounded = Math.round(number * 100) / 100
  return Object.is(rounded, -0) ? 0 : rounded
}

const vector = value => Array.isArray(value) && value.length === 3 ? value.map(round) : []

const shortText = (value, length = 80) => String(value || '').slice(0, length)

const degrees = value => round((Number(value) || 0) * 180 / Math.PI)

const degreesVector = value => Array.isArray(value) && value.length === 3 ? value.map(degrees) : []

const poseLabel = pose => RIG_PRESETS[normalizePoseId(pose)]?.label || ''

const frameList = frames => {
  const sorted = (Array.isArray(frames) ? frames : []).map(value => Number(value)).filter(Number.isFinite).sort((a, b) => a - b)
  return sorted.length > 12 ? [...sorted.slice(0, 12), '…'] : sorted
}

// The model gets a compact, read-only snapshot; full object/keyframe data stays in
// the renderer so a long project cannot blow up the prompt. Detail is available
// on demand through the get_scene_info tool.
export function buildSceneContext(source = {}) {
  const objects = Array.isArray(source.objects) ? source.objects : []
  const maxObjects = 40
  const listed = objects.slice(0, maxObjects).map(object => {
    const track = Array.isArray(source.objectKeyframes?.[object.id]) ? source.objectKeyframes[object.id] : []
    const entry = {
      id: shortText(object.id, 80),
      name: shortText(object.name, 80),
      type: shortText(object.type, 40),
      position: vector(object.position),
      rotationDegrees: degreesVector(object.rotation),
      scale: vector(object.scale),
      keyframeCount: track.length,
      ...(track.length ? { keyframeFrames: frameList(track.map(key => key.frame)) } : {}),
      ...(source.routeTracks?.[object.id] ? { hasRoute: true } : {}),
      ...(object.locked ? { locked: true } : {}),
      ...(object.visible === false ? { hidden: true } : {}),
    }
    if (object.type === 'person') {
      entry.bodyType = normalizeBodyType(object.bodyType)
      entry.pose = normalizePoseId(object.pose)
      entry.poseLabel = poseLabel(object.pose)
      entry.continuousMotion = Boolean(object.continuousMotion)
    }
    return entry
  })
  const shots = Array.isArray(source.shots)
    ? source.shots.map(shot => ({
        name: shortText(shot.name, 60),
        fps: Number(shot.fps) || 0,
        durationSeconds: Number(shot.durationSeconds) || 0,
      }))
    : []
  const camera = source.camera && typeof source.camera === 'object' ? source.camera : {}
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : {}
  const fps = Number(source.fps) || Number(settings.fps) || 0
  const durationSeconds = Number(settings.durationSeconds) || 0
  const cameraKeyframes = Array.isArray(source.keyframes) ? source.keyframes : []
  return {
    project: shortText(settings.name, 60),
    activeShot: shortText(source.activeShotName, 60),
    shots,
    objects: listed,
    objectCount: objects.length,
    truncated: objects.length > maxObjects,
    camera: {
      position: vector(camera.position),
      rotationDegrees: degreesVector(camera.rotation),
      focalLength: round(camera.focalLength),
      aspectRatio: shortText(camera.aspectRatio, 20),
      keyframeCount: cameraKeyframes.length,
      ...(cameraKeyframes.length ? { keyframeFrames: frameList(cameraKeyframes.map(key => key.frame)) } : {}),
      ...(Array.isArray(camera.target) ? { target: vector(camera.target) } : {}),
    },
    timeline: {
      currentFrame: Math.round(Number(source.currentFrame) || 0),
      fps,
      durationSeconds,
      totalFrames: Math.round(fps * durationSeconds),
    },
    selectedId: shortText(source.selectedId, 80),
    tools: ['get_scene_info', 'transform_objects', 'set_pose', 'delegate_character_pose', 'manage_keyframes', 'set_timeline'],
  }
}

export function stringifySceneContext(source = {}) {
  return JSON.stringify(buildSceneContext(source))
}
