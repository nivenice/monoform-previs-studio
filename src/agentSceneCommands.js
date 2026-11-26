// Pure scene commands behind the AI assistant's editing tools.
//
// Each command receives a read-only snapshot of the editor state and returns a
// patch that App.jsx applies through its normal setState calls, so keyframes,
// undo and autosave keep a single source of truth. Nothing here touches React,
// which keeps every rule unit-testable.
import { RIG_PRESETS, RIG_PRESET_OPTIONS, JOINT_DEFINITIONS, cloneJointPose, normalizePoseId, poseCanLoop, presetJoints, presetPhase, presetRoot } from './rig.js'
import { normalizeBodyType } from './personBodyType.js'
import { rotationToward, solveSubjectCamera } from './cameraMotion.js'
import { cameraKeyframeFromCamera, keyframeMaxFrame, normalizeInterpolation, objectAtFrame, objectKeyframeFromObject, uniqueSortedKeyframes } from './keyframeOps.js'

export const GET_SCENE_INFO = 'get_scene_info'
export const TRANSFORM_OBJECTS = 'transform_objects'
export const SET_POSE = 'set_pose'
export const MANAGE_KEYFRAMES = 'manage_keyframes'
export const SET_TIMELINE = 'set_timeline'

export const SCENE_COMMANDS = [GET_SCENE_INFO, TRANSFORM_OBJECTS, SET_POSE, MANAGE_KEYFRAMES, SET_TIMELINE]

export class SceneCommandError extends Error {}

const POSE_LABELS = Object.fromEntries(RIG_PRESET_OPTIONS)
const FPS_OPTIONS = [24, 25, 30]
const FOCAL_LENGTH_RANGE = [18, 120]
const SCALE_RANGE = [0.05, 20]
const DURATION_RANGE = [1, 60]
const POSITION_LIMIT = 1000
const MAX_OBJECTS = 80

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const round = (value, digits = 2) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  const rounded = Math.round(number * factor) / factor
  return Object.is(rounded, -0) ? 0 : rounded
}
const roundVector = (value, digits = 3) => Array.isArray(value) && value.length >= 3 ? value.slice(0, 3).map(item => round(item, digits)) : []
const radToDeg = value => Number.isFinite(Number(value)) ? round(Number(value) * 180 / Math.PI, 1) : 0
const degToRad = value => Number(value || 0) * Math.PI / 180
const degreesVector = (value, fallback = [0, 0, 0]) => Array.isArray(value) && value.length >= 3
  ? value.slice(0, 3).map((item, index) => Number.isFinite(Number(item)) ? Number(item) : fallback[index])
  : fallback
const normalizeDegrees = value => {
  let degrees = Number(value)
  if (!Number.isFinite(degrees)) return 0
  degrees %= 360
  if (degrees > 180) degrees -= 360
  if (degrees <= -180) degrees += 360
  return degrees
}
const vectorFrom = (value, fallback) => {
  if (Array.isArray(value) && value.length >= 3) {
    return value.slice(0, 3).map((item, index) => Number.isFinite(Number(item)) ? Number(item) : fallback[index])
  }
  if (value && typeof value === 'object') {
    return [0, 1, 2].map(index => {
      const key = ['x', 'y', 'z'][index]
      return Number.isFinite(Number(value[key])) ? Number(value[key]) : fallback[index]
    })
  }
  return [...fallback]
}
const hasValue = value => value !== undefined && value !== null && value !== ''

// Models sometimes emit snake_case even when the schema is camelCase.
export function camelizeKeys(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => camelizeKeys(item, depth + 1))
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.includes('_')
      ? key.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase())
      : key
    result[normalizedKey] = camelizeKeys(item, depth + 1)
  }
  return result
}

const poseLabel = pose => POSE_LABELS[normalizePoseId(pose)] || '自定义动作'

function timelineOf(state) {
  const fps = FPS_OPTIONS.includes(Number(state.settings?.fps)) ? Number(state.settings.fps) : (Number(state.fps) || 24)
  const durationSeconds = clamp(Math.round(Number(state.settings?.durationSeconds) || 15), DURATION_RANGE[0], DURATION_RANGE[1])
  return { fps, durationSeconds, totalFrames: fps * durationSeconds }
}

export function resolveObjects(state, targets, { personsOnly = false, allowAll = true } = {}) {
  const objects = Array.isArray(state.objects) ? state.objects : []
  if (!hasValue(targets)) throw new SceneCommandError('请指定目标对象：对象 id 数组、\"selected\"（当前选中）、\"persons\"（全部人物）或 \"all\"（全部对象）')
  const normalized = Array.isArray(targets) ? targets.map(item => String(item)) : [String(targets)]
  if (!normalized.length) throw new SceneCommandError('目标对象不能为空')
  const matches = []
  for (const token of normalized) {
    const keyword = token.trim()
    if (!keyword) continue
    if (keyword === 'all') {
      if (!allowAll) throw new SceneCommandError('这里不支持 \"all\"')
      for (const object of objects) matches.push(object)
      continue
    }
    if (keyword === 'persons') {
      const persons = objects.filter(object => object.type === 'person')
      if (!persons.length) throw new SceneCommandError('场景里没有人物模型')
      for (const person of persons) matches.push(person)
      continue
    }
    if (keyword === 'selected') {
      const selected = objects.find(object => object.id === state.selectedId)
      if (!selected) throw new SceneCommandError('当前没有选中场景对象；请先选中，或直接给出对象 id')
      matches.push(selected)
      continue
    }
    const byId = objects.find(object => object.id === keyword)
    if (byId) { matches.push(byId); continue }
    const byName = objects.filter(object => String(object.name || '') === keyword)
    if (byName.length === 1) { matches.push(byName[0]); continue }
    const byPartial = objects.filter(object => String(object.name || '').includes(keyword))
    if (byPartial.length === 1) { matches.push(byPartial[0]); continue }
    if (byPartial.length > 1) {
      throw new SceneCommandError(`“${keyword}”匹配到多个对象：${byPartial.map(object => `${object.name}(${object.id})`).join('、')}；请改用对象 id`)
    }
    throw new SceneCommandError(`找不到对象“${keyword}”；可用对象：${objects.map(object => `${object.name || object.type}(${object.id})`).join('、') || '（场景为空）'}`)
  }
  const unique = []
  for (const object of matches) if (!unique.includes(object)) unique.push(object)
  if (personsOnly) {
    const persons = unique.filter(object => object.type === 'person')
    if (!persons.length) throw new SceneCommandError('该工具只作用于人物模型')
    return persons
  }
  return unique
}

function resolvePose(state, name) {
  const key = String(name || '').trim()
  if (!key) throw new SceneCommandError('请提供姿势名（rig 预设 id，例如 idle、walk、aim_pistol）')
  if (Object.prototype.hasOwnProperty.call(RIG_PRESETS, key)) {
    return {
      pose: key,
      label: POSE_LABELS[key] || key,
      poseTime: presetPhase(key),
      joints: presetJoints(key),
      rigRoot: presetRoot(key),
    }
  }
  const custom = (Array.isArray(state.customPoses) ? state.customPoses : [])
    .find(item => item.id === key || String(item.name || '') === key)
  if (custom) {
    return {
      pose: normalizePoseId(custom.pose),
      label: String(custom.name || '自定义姿势'),
      poseTime: Number.isFinite(custom.poseTime) ? custom.poseTime : presetPhase(custom.pose),
      joints: cloneJointPose(custom.joints),
      rigRoot: Array.isArray(custom.rigRoot) ? [...custom.rigRoot.slice(0, 3)] : presetRoot(custom.pose),
    }
  }
  throw new SceneCommandError(`未知姿势“${key}”；可用预设：${Object.keys(RIG_PRESETS).join('、')}${Array.isArray(state.customPoses) && state.customPoses.length ? '；或本机自定义姿势名' : ''}`)
}

function applyJointDegrees(joints, jointsDegrees) {
  if (!jointsDegrees || typeof jointsDegrees !== 'object') return joints
  const known = new Set(JOINT_DEFINITIONS.map(joint => joint.id))
  const next = cloneJointPose(joints)
  for (const [jointId, value] of Object.entries(jointsDegrees)) {
    if (!known.has(jointId)) throw new SceneCommandError(`未知骨骼“${jointId}”；骨骼 id 形如 mixamorigRightArm，可用 get_scene_info(includeJoints) 查询`)
    const degrees = degreesVector(value)
    next[jointId] = degrees.map(degree => degToRad(clamp(degree, -180, 180)))
  }
  return next
}

const hasKeyframes = (state, id) => Array.isArray(state.objectKeyframes?.[id]) && state.objectKeyframes[id].length > 0
const warningsForAnimated = (state, object) => hasKeyframes(state, object.id)
  ? [`“${object.name || object.id}”已有关键帧：基础状态只影响没有关键帧的帧，动画帧请用 manage_keyframes 修改`]
  : []

// --- get_scene_info -------------------------------------------------------

export function describeSceneInfo(state, rawArgs = {}) {
  const args = camelizeKeys(rawArgs || {})
  const { fps, durationSeconds, totalFrames } = timelineOf(state)
  const camera = state.camera && typeof state.camera === 'object' ? state.camera : {}
  const cameraFrames = (Array.isArray(state.keyframes) ? state.keyframes : []).map(key => Number(key.frame)).sort((a, b) => a - b)
  const maxObjects = clamp(Math.round(Number(args.maxObjects) || 40), 1, MAX_OBJECTS)
  const objects = Array.isArray(state.objects) ? state.objects : []
  const detailed = hasValue(args.objectId) ? resolveObjects(state, [args.objectId]) : null
  const currentFrame = clamp(Math.round(Number(state.currentFrame) || 0), 0, totalFrames)

  const listed = (detailed || objects).slice(0, detailed ? 1 : maxObjects).map(object => {
    const track = Array.isArray(state.objectKeyframes?.[object.id]) ? state.objectKeyframes[object.id] : []
    const entry = {
      id: object.id,
      name: object.name || object.type,
      type: object.type,
      position: roundVector(object.position),
      rotationDegrees: (Array.isArray(object.rotation) ? object.rotation.slice(0, 3) : [0, 0, 0]).map(radToDeg),
      scale: roundVector(object.scale, 2),
      visible: object.visible !== false,
      locked: Boolean(object.locked),
      keyframeFrames: track.map(key => Number(key.frame)).sort((a, b) => a - b),
    }
    if (object.type === 'person') {
      const bodyType = normalizeBodyType(object.bodyType)
      entry.bodyType = bodyType
      entry.rigged = bodyType === 'standard'
      entry.pose = normalizePoseId(object.pose)
      entry.poseLabel = poseLabel(object.pose)
      entry.poseTime = Number.isFinite(object.poseTime) ? round(object.poseTime, 2) : presetPhase(object.pose)
      entry.continuousMotion = Boolean(object.continuousMotion)
    }
    if (object.type === 'assembly') entry.parts = Array.isArray(object.parts) ? object.parts.length : 0
    if (track.length) {
      const framed = objectAtFrame(object, track, currentFrame, fps)
      entry.current = {
        frame: currentFrame,
        position: roundVector(framed.position),
        rotationDegrees: (Array.isArray(framed.rotation) ? framed.rotation.slice(0, 3) : [0, 0, 0]).map(radToDeg),
        scale: roundVector(framed.scale, 2),
        ...(object.type === 'person' ? { pose: normalizePoseId(framed.pose), poseLabel: poseLabel(framed.pose) } : {}),
      }
    }
    if (state.routeTracks?.[object.id]) entry.hasRoute = true
    if (detailed) {
      entry.jointsDegrees = Object.fromEntries(Object.entries(cloneJointPose(object.joints || {}))
        .filter(([, value]) => value.some(item => Math.abs(item) > 1e-4))
        .map(([jointId, value]) => [jointId, value.map(radToDeg)]))
    }
    return entry
  })

  const result = {
    ok: true,
    tool: GET_SCENE_INFO,
    project: {
      name: String(state.settings?.name || ''),
      fps,
      durationSeconds,
      totalFrames,
      currentFrame,
      activeShot: { id: state.activeShotId || '', name: state.activeShotName || '' },
    },
    camera: {
      position: roundVector(camera.position),
      rotationDegrees: (Array.isArray(camera.rotation) ? camera.rotation.slice(0, 3) : [0, 0, 0]).map(radToDeg),
      focalLength: round(Number(camera.focalLength) || 42, 1),
      aspectRatio: camera.aspectRatio || '16:9',
      keyframeFrames: cameraFrames,
      follow: camera.follow?.enabled ? { enabled: true, targetId: camera.follow.targetId || '', shot: camera.follow.shot || 'medium' } : null,
    },
    selectedId: String(state.selectedId || ''),
    objects: listed,
    objectCount: objects.length,
    truncated: !detailed && objects.length > listed.length,
    poses: Object.entries(RIG_PRESETS).map(([id, preset]) => ({ id, label: preset.label, loopable: poseCanLoop(id) })),
    customPoses: (Array.isArray(state.customPoses) ? state.customPoses : []).map(item => ({ id: item.id, name: item.name })),
    limits: {
      fps: FPS_OPTIONS,
      durationSeconds: DURATION_RANGE,
      focalLength: FOCAL_LENGTH_RANGE,
      scale: SCALE_RANGE,
    },
    conventions: {
      up: 'Y',
      subjectForwardAtYaw0: '+Z',
      positionUnit: 'meter',
      rotationUnit: 'degrees',
      azimuthDegrees: '0=正前方，+90=人物左侧，180=背面（用 manage_keyframes.camera.framing）',
    },
  }
  if (detailed) {
    result.objects = listed
    result.jointCount = JOINT_DEFINITIONS.length
  }
  return { ok: true, tool: GET_SCENE_INFO, summary: { objects: listed.length }, result }
}

// --- transform_objects ----------------------------------------------------

export function transformObjects(state, rawArgs = {}) {
  const args = camelizeKeys(rawArgs || {})
  const targets = resolveObjects(state, args.targets ?? args.target)
  const respectLocks = args.respectLocks !== false
  const lockAxes = object => Array.isArray(object.rotationAxisLocks) ? object.rotationAxisLocks : [false, false, false]
  const positionLocks = object => Array.isArray(object.positionAxisLocks) ? object.positionAxisLocks : [false, false, false]
  const scaleLocks = object => Array.isArray(object.scaleAxisLocks) ? object.scaleAxisLocks : [false, false, false]

  const updated = []
  const skipped = []
  const warnings = []
  const nextObjects = state.objects.map(object => {
    if (!targets.includes(object)) return object
    if (object.locked && respectLocks) {
      skipped.push({ id: object.id, name: object.name, reason: '对象已锁定' })
      return object
    }
    const patch = {}
    const axisNotes = []

    if (hasValue(args.position)) {
      const raw = args.position
      const delta = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.delta) ? raw.delta : null
      if (delta) {
        const offset = vectorFrom(delta, [0, 0, 0]).map(value => clamp(value, -POSITION_LIMIT, POSITION_LIMIT))
        const current = vectorFrom(object.position, [0, 0, 0])
        const locks = positionLocks(object)
        patch.position = current.map((value, axis) => {
          if (respectLocks && locks[axis]) { axisNotes.push(`位置${'XYZ'[axis]}轴已锁定`); return value }
          return clamp(value + offset[axis], -POSITION_LIMIT, POSITION_LIMIT)
        })
      } else {
        const next = vectorFrom(raw, [0, 0, 0]).map(value => clamp(value, -POSITION_LIMIT, POSITION_LIMIT))
        const current = vectorFrom(object.position, [0, 0, 0])
        const locks = positionLocks(object)
        patch.position = current.map((value, axis) => {
          if (respectLocks && locks[axis]) { axisNotes.push(`位置${'XYZ'[axis]}轴已锁定`); return value }
          return next[axis]
        })
      }
    }

    if (hasValue(args.rotationDegrees) || hasValue(args.yawDegrees)) {
      const current = Array.isArray(object.rotation) ? object.rotation.slice(0, 3) : [0, 0, 0]
      const next = hasValue(args.rotationDegrees)
        ? degreesVector(args.rotationDegrees).map(normalizeDegrees)
        : current.map(radToDeg)
      if (hasValue(args.yawDegrees)) next[1] = normalizeDegrees(args.yawDegrees)
      const locks = lockAxes(object)
      patch.rotation = [0, 1, 2].map(axis => {
        if (respectLocks && locks[axis]) { axisNotes.push(`旋转${'XYZ'[axis]}轴已锁定`); return current[axis] }
        return degToRad(next[axis])
      })
    }

    if (hasValue(args.scale) || hasValue(args.size)) {
      const current = Array.isArray(object.scale) ? object.scale.slice(0, 3) : [1, 1, 1]
      const source = hasValue(args.scale) ? args.scale : args.size
      let next
      if (Array.isArray(source)) next = vectorFrom(source, [1, 1, 1])
      else if (source && typeof source === 'object') {
        const uniform = Number(source.uniform)
        next = Number.isFinite(uniform) ? [uniform, uniform, uniform] : vectorFrom(source, [1, 1, 1])
      } else {
        const uniform = Number(source)
        next = Number.isFinite(uniform) ? [uniform, uniform, uniform] : [1, 1, 1]
      }
      const locks = scaleLocks(object)
      patch.scale = current.map((value, axis) => {
        if (respectLocks && locks[axis]) { axisNotes.push(`缩放${'XYZ'[axis]}轴已锁定`); return value }
        return clamp(next[axis], SCALE_RANGE[0], SCALE_RANGE[1])
      })
    }

    if (hasValue(args.visible)) patch.visible = args.visible !== false
    if (hasValue(args.locked)) patch.locked = Boolean(args.locked)

    if (!Object.keys(patch).length) {
      skipped.push({ id: object.id, name: object.name, reason: '没有可应用的变换字段' })
      return object
    }
    if (axisNotes.length) warnings.push(`“${object.name || object.id}”${[...new Set(axisNotes)].join('、')}，该轴保持不变`)
    warnings.push(...warningsForAnimated(state, object))
    const next = { ...object, ...patch }
    updated.push({
      id: object.id,
      name: object.name || object.id,
      before: {
        position: roundVector(object.position),
        rotationDegrees: (Array.isArray(object.rotation) ? object.rotation.slice(0, 3) : [0, 0, 0]).map(radToDeg),
        scale: roundVector(object.scale, 2),
      },
      after: {
        position: roundVector(next.position),
        rotationDegrees: (Array.isArray(next.rotation) ? next.rotation.slice(0, 3) : [0, 0, 0]).map(radToDeg),
        scale: roundVector(next.scale, 2),
      },
    })
    return next
  })

  if (!updated.length) {
    const reason = skipped.map(item => `“${item.name}”：${item.reason}`).join('；') || '目标对象没有变化'
    throw new SceneCommandError(`没有对象被修改：${reason}`)
  }
  const last = updated.at(-1)
  return {
    ok: true,
    tool: TRANSFORM_OBJECTS,
    patch: { objects: nextObjects, selectedId: last.id },
    summary: {
      updated,
      skipped,
      warnings: [...new Set(warnings)],
      message: `已调整 ${updated.length} 个对象：${updated.map(item => item.name).join('、')}`,
    },
  }
}

// --- set_pose -------------------------------------------------------------

export function setPose(state, rawArgs = {}) {
  const args = camelizeKeys(rawArgs || {})
  const resolvedTargets = resolveObjects(state, args.targets ?? args.target, { personsOnly: true })
  const targets = resolvedTargets.filter(object => normalizeBodyType(object.bodyType) === 'standard')
  const skipped = resolvedTargets
    .filter(object => normalizeBodyType(object.bodyType) !== 'standard')
    .map(object => ({ id: object.id, name: object.name || object.id, reason: '极简模型是静态占位，不支持动作与骨骼' }))
  if (!targets.length) throw new SceneCommandError('极简模型是静态占位，不支持动作与骨骼；需要动作请改用标准人物')
  const source = hasValue(args.preset) || hasValue(args.customPose)
    ? resolvePose(state, args.preset ?? args.customPose)
    : null
  const resetJoints = args.resetJoints !== false || Boolean(source)
  const updated = []
  const warnings = []

  const nextObjects = state.objects.map(object => {
    if (!targets.includes(object)) return object
    if (object.locked) {
      skipped.push({ id: object.id, name: object.name, reason: '对象已锁定' })
      return object
    }
    const pose = source ? source.pose : normalizePoseId(object.pose)
    let joints = source
      ? cloneJointPose(source.joints)
      : (resetJoints ? presetJoints(pose) : cloneJointPose(object.joints || {}))
    if (!source && !resetJoints && args.jointsDegrees) joints = cloneJointPose(object.joints || {})
    joints = applyJointDegrees(joints, args.jointsDegrees)
    const poseTime = hasValue(args.poseTime)
      ? clamp(Number(args.poseTime), 0, 1)
      : (source ? source.poseTime : (Number.isFinite(object.poseTime) ? object.poseTime : presetPhase(pose)))
    const continuousMotion = poseCanLoop(pose) && (hasValue(args.continuousMotion) ? Boolean(args.continuousMotion) : Boolean(object.continuousMotion))
    const rigRoot = hasValue(args.rigRoot)
      ? vectorFrom(args.rigRoot, [0, 0, 0])
      : (source ? [...source.rigRoot] : (Array.isArray(object.rigRoot) ? [...object.rigRoot.slice(0, 3)] : [0, 0, 0]))
    const next = { ...object, pose, poseTime, continuousMotion, rigRoot, joints }
    warnings.push(...warningsForAnimated(state, object))
    updated.push({
      id: object.id,
      name: object.name || object.id,
      pose,
      poseLabel: source?.label || poseLabel(pose),
      poseTime: round(poseTime, 2),
      continuousMotion,
      jointOverrides: Object.entries(joints).filter(([, value]) => value.some(item => Math.abs(item) > 1e-4)).length,
    })
    return next
  })

  if (!updated.length) {
    const reason = skipped.map(item => `“${item.name}”：${item.reason}`).join('；') || '没有可更新的人物'
    throw new SceneCommandError(`姿势没有变化：${reason}`)
  }
  const last = updated.at(-1)
  return {
    ok: true,
    tool: SET_POSE,
    patch: { objects: nextObjects, selectedId: last.id },
    summary: {
      updated,
      skipped,
      warnings: [...new Set(warnings)],
      message: `已把 ${updated.map(item => item.name).join('、')} 设为“${last.poseLabel}”`,
    },
  }
}

// --- manage_keyframes -----------------------------------------------------

function parseFrame(value, totalFrames, label) {
  const frame = Number(value)
  if (!Number.isFinite(frame)) throw new SceneCommandError(`${label}缺少有效帧号`)
  const rounded = Math.round(frame)
  if (rounded < 0 || rounded > totalFrames) {
    throw new SceneCommandError(`${label}的帧号 ${rounded} 超出范围 0–${totalFrames}（当前时长只覆盖这么多帧；可用 set_timeline 延长）`)
  }
  return rounded
}

function composeCameraEntry(state, entry, totalFrames, index, existing) {
  const camera = state.camera || {}
  const frame = parseFrame(entry.frame, totalFrames, `第 ${index + 1} 个镜头关键帧`)
  let position = vectorFrom(entry.position, vectorFrom(camera.position, [0, 2, 6]))
  let rotation = null
  let focalLength = hasValue(entry.focalLength) ? Number(entry.focalLength) : Number(camera.focalLength) || 42

  if (entry.framing && typeof entry.framing === 'object') {
    const subject = resolveObjects(state, [entry.framing.subjectId ?? entry.framing.subject ?? 'selected'])[0]
    const solved = solveSubjectCamera(subject, {
      azimuthDegrees: entry.framing.azimuthDegrees,
      distance: entry.framing.distance,
      height: entry.framing.height,
      lookHeight: entry.framing.lookHeight,
      focalLength: hasValue(entry.framing.focalLength) ? entry.framing.focalLength : focalLength,
      aspectRatio: camera.aspectRatio || '16:9',
    })
    position = solved.position
    rotation = solved.rotation
    focalLength = solved.focalLength
  }
  if (Array.isArray(entry.rotationDegrees) || (entry.rotationDegrees && typeof entry.rotationDegrees === 'object')) {
    rotation = degreesVector(entry.rotationDegrees).map(value => degToRad(normalizeDegrees(value)))
  } else if (hasValue(entry.lookAt)) {
    rotation = rotationToward(position, vectorFrom(entry.lookAt, [0, 0, 0]))
  }
  if (!rotation) rotation = Array.isArray(camera.rotation) ? camera.rotation.slice(0, 3) : [0, 0, 0]

  const interpolation = normalizeInterpolation(hasValue(entry.interpolation) ? entry.interpolation : existing?.interpolation)
  const follow = existing
    ? {
        enabled: existing.followEnabled === true,
        targetId: existing.followTargetId || '',
        shot: existing.followShot || undefined,
        distance: existing.followDistance ?? undefined,
        height: existing.followHeight ?? undefined,
        lookHeight: existing.followLookHeight ?? undefined,
        offset: existing.followOffset || undefined,
        orbitDegrees: existing.followOrbitDegrees ?? 0,
        sideOffset: existing.followSideOffset ?? 0,
      }
    : camera.follow
  const key = cameraKeyframeFromCamera({ position, rotation, focalLength: clamp(focalLength, FOCAL_LENGTH_RANGE[0], FOCAL_LENGTH_RANGE[1]), follow }, frame, interpolation)
  if (!key.shot && camera.shot) key.shot = camera.shot
  return key
}

function composeObjectEntry(state, object, entry, totalFrames, index, existing, trackKeys = [], fps = 24) {
  const frame = parseFrame(entry.frame, totalFrames, `“${object.name || object.id}”第 ${index + 1} 个关键帧`)
  // A new in-between key must inherit the animated transform/pose of its
  // neighbours, not the object's base state, or a turn written by the main
  // agent snaps back while a subagent inserts joint keys.
  const baseObject = existing ? null : objectAtFrame(object, trackKeys, frame, fps)
  const base = existing || objectKeyframeFromObject(baseObject || object, frame)
  const next = { ...base, frame, source: 'manual' }
  if (hasValue(entry.position)) next.position = vectorFrom(entry.position, base.position).map(value => clamp(value, -POSITION_LIMIT, POSITION_LIMIT))
  if (hasValue(entry.rotationDegrees) || hasValue(entry.yawDegrees)) {
    const degrees = hasValue(entry.rotationDegrees)
      ? degreesVector(entry.rotationDegrees).map(normalizeDegrees)
      : base.rotation.map(radToDeg)
    if (hasValue(entry.yawDegrees)) degrees[1] = normalizeDegrees(entry.yawDegrees)
    next.rotation = degrees.map(degToRad)
  }
  if (hasValue(entry.scale) || hasValue(entry.size)) {
    const source = hasValue(entry.scale) ? entry.scale : entry.size
    const values = typeof source === 'number'
      ? [source, source, source]
      : vectorFrom(source, base.scale)
    next.scale = values.map(value => clamp(value, SCALE_RANGE[0], SCALE_RANGE[1]))
  }

  const poseName = hasValue(entry.pose) ? String(entry.pose) : null
  if (poseName) {
    const pose = resolvePose(state, poseName)
    next.pose = pose.pose
    next.poseTime = pose.poseTime
    if (!hasValue(entry.jointsPreset)) next.joints = cloneJointPose(pose.joints)
  }
  if (hasValue(entry.jointsPreset)) {
    const jointsSource = resolvePose(state, entry.jointsPreset)
    next.joints = cloneJointPose(jointsSource.joints)
    if (hasValue(entry.poseTime)) next.poseTime = clamp(Number(entry.poseTime), 0, 1)
    else if (hasValue(entry.pose)) next.poseTime = jointsSource.poseTime
  }
  if (entry.jointsDegrees) next.joints = applyJointDegrees(next.joints || {}, entry.jointsDegrees)
  if (hasValue(entry.poseTime) && !poseName && !hasValue(entry.jointsPreset)) next.poseTime = clamp(Number(entry.poseTime), 0, 1)
  if (hasValue(entry.continuousMotion)) next.continuousMotion = poseCanLoop(next.pose) && Boolean(entry.continuousMotion)
  if (hasValue(entry.rigRoot)) next.rigRoot = vectorFrom(entry.rigRoot, [0, 0, 0])
  next.interpolation = normalizeInterpolation(hasValue(entry.interpolation) ? entry.interpolation : base.interpolation)
  next.joints = cloneJointPose(next.joints || base.joints)
  next.rigRoot = Array.isArray(next.rigRoot) ? next.rigRoot.slice(0, 3).map(value => Number(value) || 0) : [0, 0, 0]
  next.poseTime = Number.isFinite(next.poseTime) ? next.poseTime : presetPhase(next.pose)
  return next
}

function upsertKey(list, key) {
  return uniqueSortedKeyframes([...(list || []).filter(item => item.frame !== key.frame), key])
}

export function manageKeyframes(state, rawArgs = {}) {
  const args = camelizeKeys(rawArgs || {})
  const { fps, totalFrames } = timelineOf(state)
  const action = String(args.action || 'upsert').toLowerCase()
  if (!['upsert', 'delete', 'clear', 'list'].includes(action)) {
    throw new SceneCommandError(`未知操作“${args.action}”；可用 upsert / delete / clear / list`)
  }

  if (action === 'list') {
    const objects = (state.objectKeyframes && typeof state.objectKeyframes === 'object' ? Object.entries(state.objectKeyframes) : [])
      .filter(([, track]) => Array.isArray(track) && track.length)
      .map(([id, track]) => ({ id, name: state.objects.find(object => object.id === id)?.name || id, frames: track.map(key => Number(key.frame)).sort((a, b) => a - b) }))
    return {
      ok: true,
      tool: MANAGE_KEYFRAMES,
      summary: {
        message: `镜头 ${Array.isArray(state.keyframes) ? state.keyframes.length : 0} 个关键帧；${objects.length} 个物体轨道`,
        cameraFrames: (Array.isArray(state.keyframes) ? state.keyframes : []).map(key => Number(key.frame)).sort((a, b) => a - b),
        objects,
      },
    }
  }

  const cameraFrames = Array.isArray(args.camera?.frames) ? args.camera.frames : []
  const objectTracks = Array.isArray(args.objects) ? args.objects : []
  const topFrames = Array.isArray(args.frames) ? args.frames : null
  const warnings = []

  if (action === 'delete' || action === 'clear') {
    const nextKeyframes = [...(Array.isArray(state.keyframes) ? state.keyframes : [])]
    const nextObjectKeyframes = { ...state.objectKeyframes }
    const deletedObjects = []
    const clearedObjects = []
    const refused = []
    let deletedCameraFrames = []

    const cameraEntries = [...cameraFrames, ...(topFrames || [])]
    if (action === 'clear' && args.camera) {
      deletedCameraFrames = nextKeyframes.map(key => Number(key.frame)).sort((a, b) => a - b)
      nextKeyframes.length = 0
    } else if (action === 'delete' && cameraEntries.length) {
      const frames = new Set(cameraEntries.map(entry => parseFrame(entry?.frame ?? entry, totalFrames, '镜头关键帧')))
      deletedCameraFrames = nextKeyframes.filter(key => frames.has(Number(key.frame))).map(key => Number(key.frame)).sort((a, b) => a - b)
      const remaining = nextKeyframes.filter(key => !frames.has(Number(key.frame)))
      nextKeyframes.length = 0
      nextKeyframes.push(...remaining)
    }

    for (const track of objectTracks) {
      const targets = resolveObjects(state, track.target ?? track.targets ?? args.targets)
      for (const object of targets) {
        if (!Array.isArray(nextObjectKeyframes[object.id]) || !nextObjectKeyframes[object.id].length) continue
        if (state.routeTracks?.[object.id]) {
          refused.push(`“${object.name || object.id}”由路线轨迹驱动，请先在界面清除路线`)
          continue
        }
        if (action === 'clear') {
          const frames = nextObjectKeyframes[object.id].map(key => Number(key.frame)).sort((a, b) => a - b)
          delete nextObjectKeyframes[object.id]
          clearedObjects.push({ id: object.id, name: object.name || object.id, frames })
          continue
        }
        const frames = new Set(
          [...(Array.isArray(track.frames) ? track.frames : []), ...(topFrames || [])]
            .map(entry => parseFrame(entry?.frame ?? entry, totalFrames, `“${object.name || object.id}”关键帧`)),
        )
        if (!frames.size) throw new SceneCommandError('删除物体关键帧需要给出帧号（frames）')
        const removed = nextObjectKeyframes[object.id].filter(key => frames.has(Number(key.frame))).map(key => Number(key.frame)).sort((a, b) => a - b)
        const remaining = nextObjectKeyframes[object.id].filter(key => !frames.has(Number(key.frame)))
        if (remaining.length) nextObjectKeyframes[object.id] = remaining
        else delete nextObjectKeyframes[object.id]
        if (removed.length) deletedObjects.push({ id: object.id, name: object.name || object.id, frames: removed })
      }
    }

    if (refused.length) warnings.push(...refused)
    if (!deletedCameraFrames.length && !deletedObjects.length && !clearedObjects.length) {
      throw new SceneCommandError('没有删除任何关键帧；请提供 frames，或在 camera.frames / objects[].frames 里写明帧号')
    }
    return {
      ok: true,
      tool: MANAGE_KEYFRAMES,
      patch: { keyframes: nextKeyframes, objectKeyframes: nextObjectKeyframes },
      summary: {
        deletedCameraFrames,
        deletedObjectFrames: deletedObjects,
        clearedObjects: clearedObjects.length ? clearedObjects : undefined,
        warnings,
        message: `已删除镜头 ${deletedCameraFrames.length} 个关键帧${deletedObjects.length + clearedObjects.length ? `、${deletedObjects.length + clearedObjects.length} 条物体轨道` : ''}`,
      },
    }
  }

  // upsert
  let nextKeyframes = [...(Array.isArray(state.keyframes) ? state.keyframes : [])]
  let nextObjectKeyframes = { ...state.objectKeyframes }
  const writtenCamera = []
  const writtenObjects = []

  for (let index = 0; index < cameraFrames.length; index += 1) {
    const entry = cameraFrames[index] || {}
    const frame = parseFrame(entry.frame, totalFrames, `第 ${index + 1} 个镜头关键帧`)
    const existing = nextKeyframes.find(key => Number(key.frame) === frame)
    const key = composeCameraEntry(state, entry, totalFrames, index, existing)
    nextKeyframes = upsertKey(nextKeyframes, key)
    writtenCamera.push(frame)
  }

  for (const track of objectTracks) {
    const targets = resolveObjects(state, track.target ?? track.targets ?? args.targets)
    if (!Array.isArray(track.frames) || !track.frames.length) throw new SceneCommandError('objects[].frames 不能为空')
    if (state.routeTracks?.[targets[0]?.id]) warnings.push(`“${targets[0].name || targets[0].id}”已有路线轨迹；手工关键帧与路线关键帧并存，重烘焙路线时会保留手工帧`)
    for (const object of targets) {
      const trackKeys = [...(nextObjectKeyframes[object.id] || [])]
      const frames = []
      for (let index = 0; index < track.frames.length; index += 1) {
        const entry = track.frames[index] || {}
        const frame = parseFrame(entry.frame, totalFrames, `“${object.name || object.id}”第 ${index + 1} 个关键帧`)
        const existing = trackKeys.find(key => Number(key.frame) === frame)
        const key = composeObjectEntry(state, object, entry, totalFrames, index, existing, trackKeys, fps)
        const merged = upsertKey(trackKeys, key)
        trackKeys.length = 0
        trackKeys.push(...merged)
        frames.push(frame)
      }
      nextObjectKeyframes[object.id] = trackKeys
      writtenObjects.push({ id: object.id, name: object.name || object.id, frames: [...new Set(frames)].sort((a, b) => a - b), pose: normalizePoseId(trackKeys.at(-1)?.pose || object.pose) })
    }
  }

  if (!writtenCamera.length && !writtenObjects.length) {
    throw new SceneCommandError('没有写入关键帧：请在 camera.frames 或 objects[].frames 里给出帧号和数值')
  }

  const patch = {}
  if (writtenCamera.length) {
    patch.keyframes = nextKeyframes
    const lastFrame = Math.max(...writtenCamera)
    const lastKey = nextKeyframes.find(key => Number(key.frame) === lastFrame)
    if (lastKey) {
      patch.camera = {
        ...state.camera,
        position: [...lastKey.position],
        rotation: [...lastKey.rotation],
        focalLength: lastKey.focalLength,
      }
    }
    patch.currentFrame = lastFrame
  }
  if (writtenObjects.length) {
    patch.objectKeyframes = nextObjectKeyframes
    patch.selectedId = writtenObjects.at(-1).id
  }

  return {
    ok: true,
    tool: MANAGE_KEYFRAMES,
    patch,
    summary: {
      cameraFrames: [...new Set(writtenCamera)].sort((a, b) => a - b),
      objects: writtenObjects,
      warnings: [...new Set(warnings)],
      message: `已写入镜头 ${new Set(writtenCamera).size} 个关键帧${writtenObjects.length ? `、${writtenObjects.length} 条物体轨道（${writtenObjects.map(item => `${item.name}:${item.frames.join('/')}`).join('、')}）` : ''}`,
    },
  }
}

// --- set_timeline ---------------------------------------------------------

export function setTimeline(state, rawArgs = {}) {
  const args = camelizeKeys(rawArgs || {})
  const current = state.settings || {}
  const fps = hasValue(args.fps) ? Number(args.fps) : (Number(current.fps) || 24)
  if (hasValue(args.fps) && !FPS_OPTIONS.includes(fps)) {
    throw new SceneCommandError(`帧率只能是 ${FPS_OPTIONS.join(' / ')}；收到 ${args.fps}`)
  }
  const requestedDuration = hasValue(args.durationSeconds) ? Math.round(Number(args.durationSeconds)) : (Number(current.durationSeconds) || 15)
  if (!Number.isFinite(requestedDuration)) throw new SceneCommandError('时长必须是数字（秒）')
  if (requestedDuration < DURATION_RANGE[0] || requestedDuration > DURATION_RANGE[1]) {
    throw new SceneCommandError(`时长必须在 ${DURATION_RANGE[0]}–${DURATION_RANGE[1]} 秒之间；收到 ${requestedDuration}`)
  }
  const totalFrames = fps * requestedDuration
  const lastFrame = keyframeMaxFrame(state.keyframes, state.objectKeyframes)
  if (lastFrame > totalFrames) {
    const requiredSeconds = Math.max(DURATION_RANGE[0], Math.ceil(lastFrame / fps))
    throw new SceneCommandError(`最后关键帧在第 ${lastFrame} 帧，当前设置只能覆盖 ${totalFrames} 帧；请把时长设为至少 ${requiredSeconds} 秒，或先删除末尾关键帧`)
  }
  const settings = {
    name: hasValue(args.name) ? String(args.name).trim().slice(0, 40) || current.name || '未命名场景' : current.name || '未命名场景',
    fps,
    durationSeconds: requestedDuration,
    loopPlayback: hasValue(args.loopPlayback) ? Boolean(args.loopPlayback) : Boolean(current.loopPlayback),
  }
  return {
    ok: true,
    tool: SET_TIMELINE,
    patch: {
      settings,
      currentFrame: clamp(Number(state.currentFrame) || 0, 0, totalFrames),
    },
    summary: {
      fps,
      durationSeconds: requestedDuration,
      totalFrames,
      message: `时间轴已更新：${fps} FPS · ${requestedDuration} 秒（0–${totalFrames} 帧）`,
    },
  }
}

export function runSceneCommand(name, state, args = {}) {
  switch (name) {
    case GET_SCENE_INFO: return describeSceneInfo(state, args)
    case TRANSFORM_OBJECTS: return transformObjects(state, args)
    case SET_POSE: return setPose(state, args)
    case MANAGE_KEYFRAMES: return manageKeyframes(state, args)
    case SET_TIMELINE: return setTimeline(state, args)
    default: throw new SceneCommandError(`未知场景命令：${name || '未命名'}`)
  }
}
