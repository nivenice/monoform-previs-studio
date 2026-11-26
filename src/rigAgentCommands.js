// Pure commands behind the rig-animator subagent. The subagent never touches
// the object transform, camera or timeline: it only writes joint rotations on
// one standard person, through the same set_pose/manage_keyframes path the
// main editor uses. Keeping this module React-free makes every rule testable.
import { JOINT_DEFINITIONS, normalizePoseId, presetPhase } from './rig.js'
import { isRiggedPerson, normalizeBodyType } from './personBodyType.js'
import {
  SceneCommandError,
  camelizeKeys,
  manageKeyframes,
  resolveObjects,
  setPose,
} from './agentSceneCommands.js'
import { objectAtFrame } from './keyframeOps.js'

export const GET_CHARACTER_STATE = 'get_character_state'
export const GET_CHARACTER_KEYFRAMES = 'get_character_keyframes'
export const SET_CHARACTER_JOINTS = 'set_character_joints'
export const WRITE_POSE_KEYFRAMES = 'write_pose_keyframes'

export const RIG_TOOL_NAMES = [GET_CHARACTER_STATE, GET_CHARACTER_KEYFRAMES, SET_CHARACTER_JOINTS, WRITE_POSE_KEYFRAMES]

const FPS_OPTIONS = [24, 25, 30]
const DURATION_RANGE = [1, 60]
const MAX_FRAMES_PER_CALL = 24
const MAX_KEYFRAMES_READ = 40
const ALLOWED_KEYFRAME_FIELDS = new Set([
  'frame', 'preset', 'pose', 'poseTime', 'jointsPreset', 'jointsDegrees', 'interpolation', 'continuousMotion',
])

const hasValue = value => value !== undefined && value !== null && value !== ''
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, digits = 1) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  const rounded = Math.round(number * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}
export const toDegrees = joints => Object.fromEntries(JOINT_DEFINITIONS
  .map(({ id }) => {
    const value = joints?.[id]
    if (!Array.isArray(value) || value.length < 3) return null
    const degrees = value.slice(0, 3).map(item => round((Number(item) || 0) * 180 / Math.PI))
    return degrees.some(item => Math.abs(item) > 0.1) ? [id, degrees] : null
  })
  .filter(Boolean))

function timelineOf(state) {
  const fps = FPS_OPTIONS.includes(Number(state.settings?.fps)) ? Number(state.settings.fps) : (Number(state.fps) || 24)
  const durationSeconds = clamp(Math.round(Number(state.settings?.durationSeconds) || 15), DURATION_RANGE[0], DURATION_RANGE[1])
  return { fps, durationSeconds, totalFrames: fps * durationSeconds }
}

function resolveRange(state, startFrame, endFrame) {
  const { totalFrames } = timelineOf(state)
  const start = hasValue(startFrame) ? Math.round(Number(startFrame)) : 0
  const end = hasValue(endFrame) ? Math.round(Number(endFrame)) : totalFrames
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new SceneCommandError('帧范围必须是数字')
  if (start < 0 || end > totalFrames || start > end) {
    throw new SceneCommandError(`帧范围必须在 0–${totalFrames} 内，且起始帧不大于结束帧；收到 ${start}–${end}`)
  }
  return { start, end, totalFrames }
}

function requireRigPerson(state, targetId, { allowLocked = false } = {}) {
  const person = (Array.isArray(state.objects) ? state.objects : []).find(object => object.id === targetId)
  if (!person) throw new SceneCommandError('骨骼动画师的目标人物已不存在')
  if (!isRiggedPerson(person)) throw new SceneCommandError('极简模型是静态占位，不支持骨骼表演；请改用标准人物')
  if (person.locked && !allowLocked) throw new SceneCommandError('目标人物已锁定，无法调整骨骼')
  return person
}

export function resolveRigTarget(state, target) {
  if (Array.isArray(target)) throw new SceneCommandError('骨骼动画师一次只能处理一个人物，请给出单个对象 id')
  const token = String(target ?? '').trim()
  if (!token) throw new SceneCommandError('请指定要做动作的人物（对象 id 或 "selected"）')
  if (token === 'persons' || token === 'all') {
    throw new SceneCommandError('骨骼动画师一次只能处理一个人物；请指定对象 id')
  }
  const matches = resolveObjects(state, [token], { personsOnly: true })
  if (matches.length !== 1) throw new SceneCommandError('骨骼动画师一次只能处理一个人物；请给出对象 id')
  const person = matches[0]
  if (!isRiggedPerson(person)) {
    throw new SceneCommandError(`“${person.name || person.id}”是极简模型：静态占位不支持骨骼表演；请改用标准人物`)
  }
  if (person.locked) throw new SceneCommandError(`“${person.name || person.id}”已锁定，无法调整骨骼`)
  return { ...person, bodyType: normalizeBodyType(person.bodyType) }
}

export function readCharacterState(state, targetId) {
  const person = requireRigPerson(state, targetId, { allowLocked: true })
  const { fps, durationSeconds, totalFrames } = timelineOf(state)
  const track = Array.isArray(state.objectKeyframes?.[targetId]) ? state.objectKeyframes[targetId] : []
  const currentFrame = clamp(Math.round(Number(state.currentFrame) || 0), 0, totalFrames)
  const current = objectAtFrame(person, track, currentFrame, fps)
  return {
    target: {
      id: person.id,
      name: person.name || person.id,
      bodyType: normalizeBodyType(person.bodyType),
      locked: Boolean(person.locked),
      routeDriven: Boolean(state.routeTracks?.[targetId]),
      position: person.position,
      rotationDegrees: (Array.isArray(person.rotation) ? person.rotation.slice(0, 3) : [0, 0, 0]).map(value => round(Number(value) * 180 / Math.PI)),
      scale: person.scale,
      rigRoot: person.rigRoot || [0, 0, 0],
    },
    timeline: { fps, durationSeconds, totalFrames, currentFrame },
    base: {
      pose: normalizePoseId(person.pose),
      poseTime: Number.isFinite(person.poseTime) ? person.poseTime : presetPhase(person.pose),
      continuousMotion: Boolean(person.continuousMotion),
      jointsDegrees: toDegrees(person.joints),
    },
    current: {
      frame: currentFrame,
      pose: normalizePoseId(current.pose),
      poseTime: Number.isFinite(current.poseTime) ? current.poseTime : presetPhase(current.pose),
      jointsDegrees: toDegrees(current.joints),
    },
    keyframes: [...track]
      .sort((a, b) => Number(a.frame) - Number(b.frame))
      .map(key => ({
        frame: Number(key.frame),
        interpolation: key.interpolation || 'smooth',
        pose: normalizePoseId(key.pose),
        poseTime: Number.isFinite(key.poseTime) ? key.poseTime : presetPhase(key.pose),
        continuousMotion: Boolean(key.continuousMotion),
        jointsDegrees: toDegrees(key.joints),
      })),
  }
}

export function readCharacterKeyframes(state, targetId, rawArgs = {}) {
  const args = camelizeKeys(rawArgs || {})
  const person = requireRigPerson(state, targetId, { allowLocked: true })
  const { fps, durationSeconds } = timelineOf(state)
  const range = resolveRange(state, args.startFrame, args.endFrame)
  const includeJoints = args.includeJoints !== false
  const track = Array.isArray(state.objectKeyframes?.[targetId]) ? state.objectKeyframes[targetId] : []
  const inRange = [...track]
    .filter(key => Number(key.frame) >= range.start && Number(key.frame) <= range.end)
    .sort((a, b) => Number(a.frame) - Number(b.frame))
  const selected = inRange.slice(0, MAX_KEYFRAMES_READ)
  return {
    target: {
      id: person.id,
      name: person.name || person.id,
      locked: Boolean(person.locked),
      routeDriven: Boolean(state.routeTracks?.[targetId]),
    },
    timeline: { fps, durationSeconds, totalFrames: range.totalFrames, currentFrame: clamp(Math.round(Number(state.currentFrame) || 0), 0, range.totalFrames) },
    range: { startFrame: range.start, endFrame: range.end },
    frameCount: inRange.length,
    returned: selected.length,
    truncated: inRange.length > selected.length,
    ...(inRange.length > selected.length ? { frameNumbers: inRange.map(key => Number(key.frame)) } : {}),
    frames: selected.map(key => ({
      frame: Number(key.frame),
      interpolation: key.interpolation || 'smooth',
      pose: normalizePoseId(key.pose),
      poseTime: Number.isFinite(key.poseTime) ? key.poseTime : presetPhase(key.pose),
      continuousMotion: Boolean(key.continuousMotion),
      position: Array.isArray(key.position) ? key.position : [0, 0, 0],
      rotationDegrees: (Array.isArray(key.rotation) ? key.rotation.slice(0, 3) : [0, 0, 0]).map(value => round(Number(value) * 180 / Math.PI)),
      ...(includeJoints ? { jointsDegrees: toDegrees(key.joints) } : {}),
    })),
  }
}

function assertJointDegrees(jointsDegrees) {
  if (!jointsDegrees || typeof jointsDegrees !== 'object' || Array.isArray(jointsDegrees)) {
    throw new SceneCommandError('jointsDegrees 必须是 { 骨骼 id: [x, y, z] } 对象')
  }
}

export function setCharacterJoints(state, targetId, rawArgs = {}) {
  const args = camelizeKeys(rawArgs || {})
  const person = requireRigPerson(state, targetId)
  if (hasValue(args.jointsDegrees)) assertJointDegrees(args.jointsDegrees)
  const payload = {
    targets: [person.id],
    resetJoints: args.resetJoints === true,
  }
  if (hasValue(args.preset)) {
    payload.preset = args.preset
    payload.resetJoints = true
  }
  if (hasValue(args.poseTime)) payload.poseTime = args.poseTime
  if (hasValue(args.continuousMotion)) payload.continuousMotion = args.continuousMotion
  if (hasValue(args.jointsDegrees)) payload.jointsDegrees = args.jointsDegrees
  const actionable = hasValue(args.jointsDegrees) || hasValue(args.preset) || hasValue(args.poseTime) || hasValue(args.continuousMotion) || args.resetJoints === true
  if (!actionable) throw new SceneCommandError('请提供 jointsDegrees、preset、poseTime、continuousMotion 或 resetJoints')
  const result = setPose(state, payload)
  const joints = hasValue(args.jointsDegrees) ? Object.keys(args.jointsDegrees) : []
  const next = result.summary.updated[0]
  return {
    patch: result.patch,
    summary: {
      ...result.summary,
      joints,
      message: `骨骼动画师已调整“${next.name}”的基础姿势（${joints.length || next.jointOverrides || 0} 根骨骼）`,
    },
  }
}

function normalizeKeyframeEntry(entry, range, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new SceneCommandError(`第 ${index + 1} 个姿态关键帧必须是对象`)
  }
  const source = camelizeKeys(entry)
  const unknown = Object.keys(source).filter(key => !ALLOWED_KEYFRAME_FIELDS.has(key))
  if (unknown.length) {
    throw new SceneCommandError(`第 ${index + 1} 个姿态关键帧含不支持字段：${unknown.join('、')}；骨骼动画师只改 frame / pose / jointsDegrees / interpolation / continuousMotion`)
  }
  const frame = Math.round(Number(source.frame))
  if (!Number.isFinite(frame)) throw new SceneCommandError(`第 ${index + 1} 个姿态关键帧缺少有效帧号`)
  if (frame < range.start || frame > range.end) {
    throw new SceneCommandError(`第 ${index + 1} 个姿态关键帧的帧号 ${frame} 超出委派范围 ${range.start}–${range.end}`)
  }
  if (hasValue(source.pose) && hasValue(source.preset)) {
    throw new SceneCommandError('姿态关键帧不要同时给 pose 与 preset；用 pose 指定基础预设')
  }
  if (hasValue(source.jointsDegrees)) assertJointDegrees(source.jointsDegrees)
  const next = { frame }
  const pose = hasValue(source.pose) ? source.pose : source.preset
  if (hasValue(pose)) next.pose = String(pose)
  if (hasValue(source.poseTime)) next.poseTime = clamp(Number(source.poseTime), 0, 1)
  if (hasValue(source.jointsPreset)) next.jointsPreset = String(source.jointsPreset)
  if (hasValue(source.jointsDegrees)) next.jointsDegrees = source.jointsDegrees
  if (hasValue(source.interpolation)) next.interpolation = source.interpolation
  if (hasValue(source.continuousMotion)) next.continuousMotion = Boolean(source.continuousMotion)
  const actionable = next.pose || next.jointsPreset || next.jointsDegrees || hasValue(next.poseTime) || hasValue(next.continuousMotion)
  if (!actionable) throw new SceneCommandError(`第 ${index + 1} 个姿态关键帧没有任何骨骼或姿势设置`)
  return next
}

export function writePoseKeyframes(state, targetId, rawArgs = {}, options = {}) {
  const args = camelizeKeys(rawArgs || {})
  const person = requireRigPerson(state, targetId)
  if (state.routeTracks?.[person.id]) {
    throw new SceneCommandError('该人物由路线轨迹驱动；请先在界面清除路线，再让骨骼动画师写关键帧')
  }
  if (!Array.isArray(args.frames) || !args.frames.length) throw new SceneCommandError('frames 不能为空')
  if (args.frames.length > MAX_FRAMES_PER_CALL) {
    throw new SceneCommandError(`一次最多写 ${MAX_FRAMES_PER_CALL} 个姿态关键帧；请分多次写入`)
  }
  const range = options.range || resolveRange(state, options.startFrame, options.endFrame)
  const frames = args.frames.map((entry, index) => normalizeKeyframeEntry(entry, range, index))
  const result = manageKeyframes(state, { action: 'upsert', objects: [{ target: person.id, frames }] })
  const written = result.summary.objects[0]
  const writtenFrames = [...written.frames].sort((a, b) => a - b)
  const bones = [...new Set(frames.flatMap(entry => Object.keys(entry.jointsDegrees || {})))].sort()
  return {
    patch: result.patch,
    summary: {
      ...result.summary,
      frames: writtenFrames,
      bones,
      message: `骨骼动画师已写入 ${writtenFrames.length} 个姿态关键帧（${writtenFrames.join('/')}），调整 ${bones.length} 根骨骼`,
    },
  }
}

export function runRigCommand(name, state, rawArgs = {}, options = {}) {
  const targetId = String(options.targetId || '').trim()
  if (!targetId) throw new SceneCommandError('缺少骨骼动画师的目标人物')
  if (name === GET_CHARACTER_STATE) {
    return { result: readCharacterState(state, targetId), summary: { message: '已读取角色姿态' } }
  }
  if (name === GET_CHARACTER_KEYFRAMES) {
    const result = readCharacterKeyframes(state, targetId, rawArgs)
    return {
      result,
      summary: {
        message: `已读取“${result.target.name}”的 ${result.frameCount} 个关键帧${result.truncated ? `（返回前 ${result.returned} 个，可缩小帧范围）` : ''}`,
      },
    }
  }
  if (name === SET_CHARACTER_JOINTS) return setCharacterJoints(state, targetId, rawArgs)
  if (name === WRITE_POSE_KEYFRAMES) return writePoseKeyframes(state, targetId, rawArgs, options)
  throw new SceneCommandError(`未知的骨骼工具：${name || '未命名'}`)
}

export { resolveRange }
