// Keyframe creation and evaluation helpers shared by the editor and the agent
// scene commands. Keeping the evaluation rules here means the AI tools write
// into the same animation path the timeline plays back.
import { cloneJointPose, interpolateJointPose, normalizePoseId, poseCanLoop, poseForObject, presetDefinition, presetPhase } from './rig.js'

export const DEFAULT_KEYFRAME_FPS = 24

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const lerp = (a, b, t) => a + (b - a) * t
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t
const ease = t => t * t * (3 - 2 * t)

export const normalizeInterpolation = value => ['smooth', 'linear', 'hold'].includes(value) ? value : 'smooth'
export const segmentAmount = (key, amount) => key?.interpolation === 'hold' ? 0 : key?.interpolation === 'linear' ? amount : ease(amount)

export const normalizeFrameNumber = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0
}

export function uniqueSortedKeyframes(keys) {
  const byFrame = new Map()
  keys.forEach(key => byFrame.set(key.frame, key))
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame)
}

export function clampKeyframeFrames(keys, maxFrame) {
  return uniqueSortedKeyframes((Array.isArray(keys) ? keys : []).map(key => ({
    ...key,
    frame: clamp(normalizeFrameNumber(key?.frame), 0, maxFrame),
  })))
}

export function keyframeMaxFrame(cameraKeys = [], objectTracks = {}) {
  const cameraFrames = Array.isArray(cameraKeys) ? cameraKeys.map(key => normalizeFrameNumber(key?.frame)) : []
  const objectFrames = Object.values(objectTracks || {})
    .flatMap(track => Array.isArray(track) ? track.map(key => normalizeFrameNumber(key?.frame)) : [])
  return Math.max(0, ...cameraFrames, ...objectFrames)
}

export function rotateVectorXYZ(vector, rotation = [0, 0, 0]) {
  let [x, y, z] = vector
  const [rx, ry, rz] = rotation
  const cosX = Math.cos(rx); const sinX = Math.sin(rx)
  const cosY = Math.cos(ry); const sinY = Math.sin(ry)
  const cosZ = Math.cos(rz); const sinZ = Math.sin(rz)
  ;[y, z] = [y * cosX - z * sinX, y * sinX + z * cosX]
  ;[x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY]
  ;[x, y] = [x * cosZ - y * sinZ, x * sinZ + y * cosZ]
  return [x, y, z]
}

export function cameraKeyframeFromCamera(camera = {}, frame = 0, interpolation = 'smooth') {
  const follow = camera.follow && typeof camera.follow === 'object' ? camera.follow : null
  return {
    frame,
    interpolation: normalizeInterpolation(interpolation),
    position: Array.isArray(camera.position) ? [...camera.position] : [0, 0, 0],
    rotation: Array.isArray(camera.rotation) ? [...camera.rotation] : [0, 0, 0],
    focalLength: Number(camera.focalLength) || 42,
    shot: follow?.enabled ? follow.shot : (camera.shot || null),
    followEnabled: follow?.enabled === true,
    followTargetId: follow?.targetId || '',
    followShot: follow?.shot || null,
    followDistance: follow?.distance ?? null,
    followHeight: follow?.height ?? null,
    followLookHeight: follow?.lookHeight ?? null,
    followOffset: follow?.offset ? [...follow.offset] : null,
    followOrbitDegrees: follow?.orbitDegrees ?? 0,
    followSideOffset: follow?.sideOffset ?? 0,
  }
}

export function objectKeyframeFromObject(object, frame) {
  const rig = poseForObject(object)
  return {
    frame,
    interpolation: 'smooth',
    position: [...object.position],
    rotation: [...object.rotation],
    scale: [...object.scale],
    pose: normalizePoseId(object.pose),
    poseTime: Number.isFinite(object.poseTime) ? object.poseTime : presetPhase(object.pose),
    continuousMotion: poseCanLoop(object.pose) && Boolean(object.continuousMotion),
    rigRoot: [...rig.root],
    joints: cloneJointPose(rig.joints),
  }
}

export function objectAtFrame(object, keyframes = [], frame, fps = DEFAULT_KEYFRAME_FPS) {
  if (!object) return object
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame)
  if (!sorted.length) return object
  const motionEnabled = key => poseCanLoop(key.pose || object.pose) && (key.continuousMotion === undefined ? Boolean(object.continuousMotion) : Boolean(key.continuousMotion))
  // Poses can blend when they share the same baked clip sampled at the same
  // phase (e.g. `idle` and `aim_pistol` both read the idle clip at 0.08), which
  // lets the arm offsets interpolate into a draw instead of snapping.
  const stateSignature = key => {
    const pose = normalizePoseId(key.pose || object.pose)
    const poseTime = Number.isFinite(key.poseTime) ? key.poseTime : presetPhase(pose)
    return `${presetDefinition(pose).clip || 'bind'}|${poseTime.toFixed(6)}`
  }
  const sameState = (leftKey, rightKey) => stateSignature(leftKey) === stateSignature(rightKey) && motionEnabled(leftKey) === motionEnabled(rightKey)
  const stateStartFrame = key => {
    let index = sorted.indexOf(key)
    while (index > 0 && sameState(sorted[index - 1], sorted[index])) index -= 1
    return sorted[index]?.frame ?? key.frame
  }
  const applyKey = key => ({
    ...object,
    position: [...key.position],
    rotation: [...key.rotation],
    scale: [...key.scale],
    pose: normalizePoseId(key.pose || object.pose),
    poseTime: Number.isFinite(key.poseTime) ? key.poseTime : presetPhase(key.pose || object.pose),
    continuousMotion: motionEnabled(key),
    motionStartTime: stateStartFrame(key) / fps,
    rigRoot: [...(key.rigRoot || poseForObject({ ...object, pose: key.pose || object.pose }).root)],
    joints: cloneJointPose(key.joints || poseForObject({ ...object, pose: key.pose || object.pose }).joints),
  })
  const exact = sorted.find(key => key.frame === frame)
  if (exact) return applyKey(exact)
  if (frame <= sorted[0].frame) return applyKey(sorted[0])
  if (frame >= sorted.at(-1).frame) return applyKey(sorted.at(-1))
  const rightIndex = sorted.findIndex(key => key.frame >= frame)
  const left = sorted[rightIndex - 1]
  const right = sorted[rightIndex]
  const t = segmentAmount(left, (frame - left.frame) / Math.max(1, right.frame - left.frame))
  const leftRoot = left.rigRoot || poseForObject({ ...object, pose: left.pose || object.pose }).root
  const rightRoot = right.rigRoot || poseForObject({ ...object, pose: right.pose || object.pose }).root
  const leftPoseTime = Number.isFinite(left.poseTime) ? left.poseTime : presetPhase(left.pose || object.pose)
  const rightPoseTime = Number.isFinite(right.poseTime) ? right.poseTime : presetPhase(right.pose || object.pose)
  const interpolateState = sameState(left, right)
  return {
    ...object,
    position: left.position.map((value, index) => lerp(value, right.position[index], t)),
    rotation: left.rotation.map((value, index) => lerp(value, right.rotation[index], t)),
    scale: left.scale.map((value, index) => lerp(value, right.scale[index], t)),
    pose: normalizePoseId(left.pose || object.pose),
    poseTime: interpolateState ? lerp(leftPoseTime, rightPoseTime, t) : leftPoseTime,
    continuousMotion: motionEnabled(left),
    motionStartTime: stateStartFrame(left) / fps,
    rigRoot: interpolateState ? leftRoot.map((value, index) => lerp(value, rightRoot[index], t)) : [...leftRoot],
    joints: interpolateState ? interpolateJointPose(
      left.joints || poseForObject({ ...object, pose: left.pose || object.pose }).joints,
      right.joints || poseForObject({ ...object, pose: right.pose || object.pose }).joints,
      t,
    ) : cloneJointPose(left.joints || poseForObject({ ...object, pose: left.pose || object.pose }).joints),
  }
}

export function objectsAtFrame(objects, objectKeyframes, frame, fps = DEFAULT_KEYFRAME_FPS) {
  return objects.map(object => objectAtFrame(object, objectKeyframes?.[object.id], frame, fps))
}

// Camera tracks interpolate position/focal smoothly and angles on the shortest arc.
// `baseCamera` is returned unchanged for an empty track so callers can pass the
// live camera instead of a baked default.
export function resolveCameraAtFrame(keyframes, frame, aspectRatio = '16:9', baseCamera = null) {
  const fallback = baseCamera ? { ...baseCamera, aspectRatio } : { aspectRatio }
  const sorted = [...(Array.isArray(keyframes) ? keyframes : [])].sort((a, b) => a.frame - b.frame)
  if (!sorted.length) return fallback
  const exact = sorted.find(key => key.frame === frame)
  if (exact) return { ...exact, aspectRatio }
  if (frame <= sorted[0].frame) return { ...sorted[0], aspectRatio }
  if (frame >= sorted.at(-1).frame) return { ...sorted.at(-1), aspectRatio }
  const rightIndex = sorted.findIndex(key => key.frame >= frame)
  const left = sorted[rightIndex - 1]
  const right = sorted[rightIndex]
  const t = segmentAmount(left, (frame - left.frame) / Math.max(1, right.frame - left.frame))
  const followOffset = left.followOffset && right.followOffset
    ? left.followOffset.map((value, index) => lerp(value, right.followOffset[index], t))
    : (t < 0.5 ? left.followOffset : right.followOffset)
  return {
    position: left.position.map((value, index) => lerp(value, right.position[index], t)),
    rotation: left.rotation.map((value, index) => lerpAngle(value, right.rotation[index], t)),
    focalLength: lerp(left.focalLength, right.focalLength, t),
    aspectRatio,
    shot: t < 0.5 ? left.shot : right.shot,
    followEnabled: t < 0.5 ? left.followEnabled : right.followEnabled,
    followTargetId: t < 0.5 ? left.followTargetId : right.followTargetId,
    followShot: t < 0.5 ? left.followShot : right.followShot,
    followDistance: left.followDistance != null && right.followDistance != null ? lerp(left.followDistance, right.followDistance, t) : (t < 0.5 ? left.followDistance : right.followDistance),
    followHeight: left.followHeight != null && right.followHeight != null ? lerp(left.followHeight, right.followHeight, t) : (t < 0.5 ? left.followHeight : right.followHeight),
    followLookHeight: left.followLookHeight != null && right.followLookHeight != null ? lerp(left.followLookHeight, right.followLookHeight, t) : (t < 0.5 ? left.followLookHeight : right.followLookHeight),
    followOffset,
    followOrbitDegrees: left.followOrbitDegrees != null && right.followOrbitDegrees != null ? lerpAngle(left.followOrbitDegrees * Math.PI / 180, right.followOrbitDegrees * Math.PI / 180, t) * 180 / Math.PI : (t < 0.5 ? left.followOrbitDegrees : right.followOrbitDegrees),
    followSideOffset: left.followSideOffset != null && right.followSideOffset != null ? lerp(left.followSideOffset, right.followSideOffset, t) : (t < 0.5 ? left.followSideOffset : right.followSideOffset),
  }
}
