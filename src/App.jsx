import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownToLine, Axis3D, Box, BoxSelect, Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleDot, Copy, Download,
  FileImage, FileVideo2, Focus, FolderOpen, Grid3X3, Import, Link2, Lock, MousePointer2, Move3D, Pause, Play, Plus,
  Magnet, Maximize2, Minimize2, Minus, Redo2, RotateCcw, RotateCw, Save, Settings2, SkipBack, SkipForward, SlidersHorizontal, Sparkles, Sun,
  ScanFace, ScanLine, Trash2, Undo2, Unlink2, UserRound, Video, ZoomIn,
  Unlock,
} from 'lucide-react'
import { MainViewport, CameraPreview } from './Viewport.jsx'
import { sceneToMonoform } from './sceneToMonoform.js'
import { AgentPanel } from './AgentPanel.jsx'
import { pathToKeys } from './previsMotion.js'
import { CAMERA_SHOT_PRESETS, shotPreset, solveFollowCamera } from './cameraMotion.js'
import { ShotsPanel } from './ShotsPanel.jsx'
import { mergeRouteKeyframes, removeRouteOwnedKeyframes, routeOwnedKeyframe } from './routeOwnership.js'
import { JOINT_DEFINITIONS, JOINT_GROUPS, RIG_PRESET_GROUPS, RIG_PRESET_OPTIONS, cloneJointPose, normalizePoseId, poseCanLoop, poseForObject, presetJoints, presetPhase, presetRoot } from './rig.js'
import { PERSON_BODY_TYPES, normalizeBodyType } from './personBodyType.js'
import { normalizeFaceText } from './minimalPerson.js'
import { cameraKeyframeFromCamera, clampKeyframeFrames, keyframeMaxFrame, normalizeFrameNumber, normalizeInterpolation, objectAtFrame, objectKeyframeFromObject, objectsAtFrame, resolveCameraAtFrame, rotateVectorXYZ, uniqueSortedKeyframes } from './keyframeOps.js'
import { axisValueDigits, formatAxisValue, mergeCameraAxisLocks, normalizeAxisLocks, parseAxisValue, resetVectorPreservingLocks, stepAxisValue, toggleAxisLock } from './transformValues.js'

const CAMERA_ID = '__shot_camera__'
// When embedded with a ?key=... query (canvas director nodes), scope storage per node so multiple instances do not share a project.
const EMBED_KEY = new URLSearchParams(window.location.search).get('key') || ''
const PROJECT_STORAGE_KEY = EMBED_KEY ? `monoform-project-${EMBED_KEY}` : 'monoform-project'
const LEGACY_PROJECT_STORAGE_KEY = 'stageframe-project'
const CUSTOM_POSE_STORAGE_KEY = EMBED_KEY ? `monoform-custom-poses-${EMBED_KEY}` : 'monoform-custom-poses'
const PROJECT_VERSION = 16
const DEFAULT_PROJECT_SETTINGS = {
  name: '未命名场景',
  fps: 24,
  durationSeconds: 15,
  loopPlayback: false,
}
const DEFAULT_LIGHTING = {
  ambientIntensity: 1.35,
  keyIntensity: 2.8,
  fillIntensity: 1.1,
  keyAzimuth: 39,
  keyElevation: 51,
  exposure: 0.9,
  ambientColor: '#f7f1e6',
  keyColor: '#fff6e8',
  fillColor: '#a9c2c6',
}
const FPS_OPTIONS = [24, 25, 30]
const FOCAL_LENGTH_PRESETS = [18, 24, 35, 50, 85, 120]
const BRAND_MARK_URL = `${import.meta.env.BASE_URL}branding/monoform-mark.png`
// Electron hides the native title bar on Windows/Linux and overlays the native
// caption buttons on the right edge; leave room for them and make the topbar draggable.
const HAS_CUSTOM_TITLEBAR = typeof window !== 'undefined' && Boolean(window.monoform) && window.monoform.platform !== 'darwin'
const ASPECT_RATIOS = [
  { value: '16:9', label: '16 : 9 · 横屏视频', ratio: 16 / 9 },
  { value: '9:16', label: '9 : 16 · 竖屏短视频', ratio: 9 / 16 },
  { value: '4:3', label: '4 : 3 · 经典画幅', ratio: 4 / 3 },
  { value: '3:4', label: '3 : 4 · 竖版经典画幅', ratio: 3 / 4 },
  { value: '3:2', label: '3 : 2 · 摄影画幅', ratio: 3 / 2 },
  { value: '1:1', label: '1 : 1 · 方形画幅', ratio: 1 },
  { value: '1.85:1', label: '1.85 : 1 · 影院宽屏', ratio: 1.85 },
  { value: '2.39:1', label: '2.39 : 1 · 电影宽银幕', ratio: 2.39 },
  { value: 'custom', label: '自定义画幅' },
]
const COMMON_ASPECT_RATIOS = ['16:9', '9:16', '4:3', '3:4']
const CUSTOM_ASPECT_PATTERN = /^custom:([0-9]+(?:\.[0-9]+)?):([0-9]+(?:\.[0-9]+)?)$/
const cleanAspectPart = value => String(Math.round(clamp(Number(value) || 1, 0.1, 100) * 100) / 100)
const customAspectParts = value => {
  const match = String(value || '').match(CUSTOM_ASPECT_PATTERN)
  return match ? [Number(match[1]), Number(match[2])] : [16, 9]
}
const customAspectValue = (width, height) => `custom:${cleanAspectPart(width)}:${cleanAspectPart(height)}`
const aspectSelectValue = value => CUSTOM_ASPECT_PATTERN.test(String(value || '')) ? 'custom' : value
const aspectValue = value => {
  const custom = String(value || '').match(CUSTOM_ASPECT_PATTERN)
  if (custom) return Number(custom[1]) / Math.max(0.1, Number(custom[2]))
  return ASPECT_RATIOS.find(option => option.value === value)?.ratio || 16 / 9
}
const aspectLabel = value => {
  if (aspectSelectValue(value) === 'custom') {
    const [width, height] = customAspectParts(value)
    return `${width} : ${height} · 自定义`
  }
  return value || '16:9'
}
const customAspectFrom = value => {
  if (aspectSelectValue(value) === 'custom') return value
  const parts = String(value || '16:9').split(':').map(Number)
  return customAspectValue(parts[0] || 16, parts[1] || 9)
}
const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

function exportDimensionsForAspect(aspectRatio) {
  const ratio = aspectValue(aspectRatio)
  const even = value => Math.max(2, Math.round(value / 2) * 2)
  return ratio >= 1
    ? { width: 1280, height: even(1280 / ratio) }
    : { width: even(1280 * ratio), height: 1280 }
}

const initialObjects = [
  {
    id: 'actor-lead', name: '人物 · 主角', type: 'person', bodyType: 'standard', pose: 'walk',
    poseTime: presetPhase('walk'), continuousMotion: false, position: [-1.25, 0, 0.3], rotation: [0, 0.25, 0], scale: [1, 1, 1], color: '#e8e3d8', joints: presetJoints(),
  },
]

const DEFAULT_CAMERA_POSITION = [7.4, 4.6, 8.2]
const LEGACY_DEFAULT_CAMERA_TARGET = [0.2, 1.2, 0]
const DEFAULT_CAMERA_ROTATION = cameraRotationToward(DEFAULT_CAMERA_POSITION, LEGACY_DEFAULT_CAMERA_TARGET)
const initialCamera = {
  position: [...DEFAULT_CAMERA_POSITION],
  rotation: [...DEFAULT_CAMERA_ROTATION],
  focalLength: 42,
  aspectRatio: '16:9',
  positionAxisLocks: [false, false, false],
  rotationAxisLocks: [false, false, false],
}
const DEFAULT_REFERENCE = {
  image: '',
  name: '',
  opacity: 0.45,
  scale: 1,
  x: 0,
  y: 0,
  visible: true,
  includeInExport: false,
}

const initialKeyframes = []
const initialCharacterKeyframes = {}

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const radToDeg = value => Math.round((value * 180 / Math.PI) * 10) / 10
const degToRad = value => Number(value || 0) * Math.PI / 180
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const POSE_LABELS = Object.fromEntries(RIG_PRESET_OPTIONS)
const poseLabel = pose => POSE_LABELS[normalizePoseId(pose)] || '自定义动作'

function finiteVector3(value, fallback) {
  return Array.isArray(value) && value.length >= 3
    ? value.slice(0, 3).map((item, index) => Number.isFinite(Number(item)) ? Number(item) : fallback[index])
    : [...fallback]
}

function cameraRotationToward(position, target) {
  const eye = finiteVector3(position, DEFAULT_CAMERA_POSITION)
  const point = finiteVector3(target, LEGACY_DEFAULT_CAMERA_TARGET)
  let dx = point[0] - eye[0]
  let dy = point[1] - eye[1]
  let dz = point[2] - eye[2]
  const length = Math.hypot(dx, dy, dz)
  if (length < 1e-8) return [0, 0, 0]
  dx /= length; dy /= length; dz /= length
  return [Math.asin(Math.min(1, Math.max(-1, dy))), Math.atan2(-dx, -dz), 0]
}

function normalizeCamera(camera = {}) {
  const position = finiteVector3(camera.position, initialCamera.position)
  const rotation = Array.isArray(camera.rotation)
    ? finiteVector3(camera.rotation, initialCamera.rotation)
    : cameraRotationToward(position, camera.target || LEGACY_DEFAULT_CAMERA_TARGET)
  const sourceFollow = camera.follow && typeof camera.follow === 'object' ? camera.follow : null
  const follow = sourceFollow ? {
    enabled: sourceFollow.enabled !== false,
    targetId: String(sourceFollow.targetId || ''),
    shot: Object.prototype.hasOwnProperty.call(CAMERA_SHOT_PRESETS, sourceFollow.shot) ? sourceFollow.shot : 'medium',
    distance: clamp(Number(sourceFollow.distance) || shotPreset(sourceFollow.shot).distance, 1, 40),
    height: clamp(Number(sourceFollow.height) || shotPreset(sourceFollow.shot).height, 0.2, 20),
    lookHeight: clamp(Number(sourceFollow.lookHeight) || shotPreset(sourceFollow.shot).lookHeight, 0, 10),
    offset: finiteVector3(sourceFollow.offset, [0, shotPreset(sourceFollow.shot).height, shotPreset(sourceFollow.shot).distance]),
    focalLength: clamp(Number(sourceFollow.focalLength) || shotPreset(sourceFollow.shot).focalLength, 18, 120),
    unit: 'character-height',
    orbitDegrees: clamp(Number(sourceFollow.orbitDegrees) || 0, -180, 180),
    sideOffset: clamp(Number(sourceFollow.sideOffset) || 0, -10, 10),
  } : null
  return {
    position,
    rotation,
    focalLength: clamp(Number(camera.focalLength) || initialCamera.focalLength, 18, 120),
    shot: Object.prototype.hasOwnProperty.call(CAMERA_SHOT_PRESETS, camera.shot) ? camera.shot : null,
    follow,
    aspectRatio: ASPECT_RATIOS.some(option => option.ratio && option.value === camera.aspectRatio) || CUSTOM_ASPECT_PATTERN.test(String(camera.aspectRatio || ''))
      ? camera.aspectRatio
      : initialCamera.aspectRatio,
    positionAxisLocks: normalizeAxisLocks(camera.positionAxisLocks),
    rotationAxisLocks: normalizeAxisLocks(camera.rotationAxisLocks),
  }
}

function normalizeCameraKeyframes(keys = [], fallbackCamera = initialCamera) {
  const source = Array.isArray(keys) ? keys.filter(Boolean) : []
  return uniqueSortedKeyframes(source.map(key => {
    const position = finiteVector3(key.position, fallbackCamera.position)
    return {
      frame: normalizeFrameNumber(key.frame),
      interpolation: normalizeInterpolation(key.interpolation),
      position,
      rotation: Array.isArray(key.rotation)
        ? finiteVector3(key.rotation, fallbackCamera.rotation)
        : cameraRotationToward(position, key.target || LEGACY_DEFAULT_CAMERA_TARGET),
      focalLength: clamp(Number(key.focalLength) || fallbackCamera.focalLength, 18, 120),
      shot: Object.prototype.hasOwnProperty.call(CAMERA_SHOT_PRESETS, key.shot) ? key.shot : null,
      followEnabled: typeof key.followEnabled === 'boolean' ? key.followEnabled : null,
      followTargetId: key.followTargetId ? String(key.followTargetId) : '',
      followShot: Object.prototype.hasOwnProperty.call(CAMERA_SHOT_PRESETS, key.followShot) ? key.followShot : null,
      followDistance: Number.isFinite(Number(key.followDistance)) ? clamp(Number(key.followDistance), 1, 40) : null,
      followHeight: Number.isFinite(Number(key.followHeight)) ? clamp(Number(key.followHeight), 0.2, 20) : null,
      followLookHeight: Number.isFinite(Number(key.followLookHeight)) ? clamp(Number(key.followLookHeight), 0, 10) : null,
      followOffset: Array.isArray(key.followOffset) ? finiteVector3(key.followOffset, [0, 2.8, 5.2]) : null,
      followOrbitDegrees: key.followOrbitDegrees == null ? null : clamp(Number(key.followOrbitDegrees) || 0, -180, 180),
      followSideOffset: key.followSideOffset == null ? null : clamp(Number(key.followSideOffset) || 0, -10, 10),
    }
  }))
}

function normalizeReference(reference = {}) {
  const image = typeof reference.image === 'string' && /^data:image\/(?:png|jpe?g|webp);base64,/i.test(reference.image)
    ? reference.image
    : ''
  return {
    image,
    name: image ? String(reference.name || '参考图').slice(0, 80) : '',
    opacity: clamp(Number(reference.opacity) || DEFAULT_REFERENCE.opacity, 0.1, 1),
    scale: clamp(Number(reference.scale) || DEFAULT_REFERENCE.scale, 0.25, 2),
    x: clamp(Number(reference.x) || 0, -75, 75),
    y: clamp(Number(reference.y) || 0, -75, 75),
    visible: reference.visible !== false,
    includeInExport: reference.includeInExport === true,
  }
}

function normalizeProjectSettings(settings = {}) {
  const fps = FPS_OPTIONS.includes(Number(settings.fps)) ? Number(settings.fps) : DEFAULT_PROJECT_SETTINGS.fps
  const durationSeconds = clamp(Math.round(Number(settings.durationSeconds) || DEFAULT_PROJECT_SETTINGS.durationSeconds), 1, 60)
  return {
    name: String(settings.name || DEFAULT_PROJECT_SETTINGS.name).trim().slice(0, 40) || DEFAULT_PROJECT_SETTINGS.name,
    fps,
    durationSeconds,
    loopPlayback: Boolean(settings.loopPlayback),
  }
}

function normalizeLighting(lighting = {}) {
  const numeric = (value, fallback, minimum, maximum) => {
    const parsed = Number(value)
    return clamp(Number.isFinite(parsed) ? parsed : fallback, minimum, maximum)
  }
  const color = (value, fallback) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : fallback
  return {
    ambientIntensity: numeric(lighting.ambientIntensity, DEFAULT_LIGHTING.ambientIntensity, 0, 3),
    keyIntensity: numeric(lighting.keyIntensity, DEFAULT_LIGHTING.keyIntensity, 0, 6),
    fillIntensity: numeric(lighting.fillIntensity, DEFAULT_LIGHTING.fillIntensity, 0, 4),
    keyAzimuth: numeric(lighting.keyAzimuth, DEFAULT_LIGHTING.keyAzimuth, -180, 180),
    keyElevation: numeric(lighting.keyElevation, DEFAULT_LIGHTING.keyElevation, 5, 85),
    exposure: numeric(lighting.exposure, DEFAULT_LIGHTING.exposure, 0.25, 1.75),
    ambientColor: color(lighting.ambientColor, DEFAULT_LIGHTING.ambientColor),
    keyColor: color(lighting.keyColor, DEFAULT_LIGHTING.keyColor),
    fillColor: color(lighting.fillColor, DEFAULT_LIGHTING.fillColor),
  }
}

function timecodeAtFrame(frame, fps) {
  const safeFrame = Math.max(0, Math.round(frame))
  const frames = safeFrame % fps
  const totalSeconds = Math.floor(safeFrame / fps)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  return [hours, minutes, seconds, frames].map(value => String(value).padStart(2, '0')).join(':')
}

function normalizePerson(object) {
  if (object?.type !== 'person') return object
  const pose = normalizePoseId(object.pose)
  return {
    ...object,
    bodyType: normalizeBodyType(object.bodyType),
    pose,
    poseTime: Number.isFinite(object.poseTime) ? object.poseTime : presetPhase(pose),
    rigRoot: Array.isArray(object.rigRoot) ? object.rigRoot.slice(0, 3).map(value => Number(value) || 0) : [0, 0, 0],
    joints: cloneJointPose(object.joints),
    footLock: Boolean(object.footLock),
    continuousMotion: poseCanLoop(pose) && Boolean(object.continuousMotion),
    faceText: normalizeFaceText(object.faceText),
  }
}

function normalizeObjectAxisLocks(object) {
  if (!object || typeof object !== 'object') return object
  return {
    ...object,
    positionAxisLocks: normalizeAxisLocks(object.positionAxisLocks),
    rotationAxisLocks: normalizeAxisLocks(object.rotationAxisLocks),
    scaleAxisLocks: normalizeAxisLocks(object.scaleAxisLocks),
  }
}

function readCustomPoses() {
  try {
    const poses = JSON.parse(localStorage.getItem(CUSTOM_POSE_STORAGE_KEY) || '[]')
    if (!Array.isArray(poses)) return []
    return poses.filter(pose => pose?.id && pose?.name).map(pose => ({
      ...pose,
      pose: normalizePoseId(pose.pose),
      poseTime: Number.isFinite(pose.poseTime) ? pose.poseTime : presetPhase(pose.pose),
      rigRoot: Array.isArray(pose.rigRoot) ? pose.rigRoot.slice(0, 3) : presetRoot(pose.pose),
      joints: cloneJointPose(pose.joints),
    }))
  } catch {
    return []
  }
}

function normalizeObjectTracks(tracks = {}) {
  if (!tracks || typeof tracks !== 'object') return {}
  return Object.fromEntries(Object.entries(tracks).map(([id, keys]) => [id, uniqueSortedKeyframes((Array.isArray(keys) ? keys.filter(Boolean) : []).map(key => {
    const pose = normalizePoseId(key.pose)
    return {
      ...key,
      frame: normalizeFrameNumber(key.frame),
      interpolation: normalizeInterpolation(key.interpolation),
      pose,
      poseTime: Number.isFinite(key.poseTime) ? key.poseTime : presetPhase(pose),
      continuousMotion: poseCanLoop(pose) ? (key.continuousMotion === undefined ? undefined : Boolean(key.continuousMotion)) : false,
      rigRoot: Array.isArray(key.rigRoot) ? key.rigRoot.slice(0, 3).map(value => Number(value) || 0) : [0, 0, 0],
      joints: cloneJointPose(key.joints),
    }
  }))]))
}

function normalizeRouteTracks(tracks = {}) {
  if (!tracks || typeof tracks !== 'object') return {}
  return Object.fromEntries(Object.entries(tracks).map(([id, route]) => [id, {
    ...route,
    points: Array.isArray(route?.points) ? route.points.filter(p => Array.isArray(p) && p.length >= 3).map(p => p.slice(0, 3).map(Number)) : [],
    startFrame: normalizeFrameNumber(route?.startFrame),
    endFrame: normalizeFrameNumber(route?.endFrame),
    visible: route?.visible !== false,
    loopMotion: route?.loopMotion !== false,
    keyframes: Array.isArray(route?.keyframes)
      ? route.keyframes.map(value => normalizeFrameNumber(value)).filter((value, index, list) => list.indexOf(value) === index)
      : [],
    keyframesOwned: route?.keyframesOwned === true,
  }]).filter(([, route]) => route.points.length >= 2))
}

const cloneProjectValue = value => JSON.parse(JSON.stringify(value))
const defaultShotName = index => `镜头 ${String(index + 1).padStart(2, '0')}`

function uniqueShotName(shots, preferred) {
  const used = new Set(shots.map(shot => String(shot.name || '').trim().toLocaleLowerCase()))
  const base = String(preferred || '镜头').trim().slice(0, 30) || '镜头'
  if (!used.has(base.toLocaleLowerCase())) return base
  for (let copy = 2; copy <= 99; copy += 1) {
    const suffix = ` ${copy}`
    const candidate = `${base.slice(0, 30 - suffix.length)}${suffix}`
    if (!used.has(candidate.toLocaleLowerCase())) return candidate
  }
  return `${base.slice(0, 23)} ${uid().slice(-6)}`
}

function normalizeShot(shot, index, fallback) {
  const objects = removeUntouchedStarterBlocks((Array.isArray(shot?.objects) ? shot.objects : fallback.objects).map(normalizePerson).map(normalizeObjectAxisLocks))
  const camera = normalizeCamera(shot?.camera || fallback.camera)
  let keyframes = normalizeCameraKeyframes(shot?.keyframes ?? fallback.keyframes ?? [], camera)
  let objectKeyframes = normalizeObjectTracks(shot?.objectKeyframes || shot?.characterKeyframes || fallback.objectKeyframes || {})
  const routeTracks = normalizeRouteTracks(shot?.routeTracks || fallback.routeTracks || {})
  const timing = normalizeProjectSettings({
    fps: shot?.fps ?? shot?.settings?.fps ?? fallback.settings.fps,
    durationSeconds: shot?.durationSeconds ?? shot?.settings?.durationSeconds ?? fallback.settings.durationSeconds,
    loopPlayback: shot?.loopPlayback ?? shot?.settings?.loopPlayback ?? fallback.settings.loopPlayback,
  })
  const maxFrame = keyframeMaxFrame(keyframes, objectKeyframes)
  if (maxFrame > timing.fps * timing.durationSeconds) timing.durationSeconds = clamp(Math.ceil(maxFrame / timing.fps), 1, 60)
  const supportedMaxFrame = timing.fps * timing.durationSeconds
  if (maxFrame > supportedMaxFrame) {
    keyframes = clampKeyframeFrames(keyframes, supportedMaxFrame)
    objectKeyframes = Object.fromEntries(Object.entries(objectKeyframes).map(([id, track]) => [id, clampKeyframeFrames(track, supportedMaxFrame)]))
  }
  return {
    id: String(shot?.id || `shot-${uid()}`),
    name: String(shot?.name || defaultShotName(index)).trim().slice(0, 30) || defaultShotName(index),
    thumbnail: typeof shot?.thumbnail === 'string' && shot.thumbnail.startsWith('data:image/') ? shot.thumbnail : '',
    fps: timing.fps,
    durationSeconds: timing.durationSeconds,
    loopPlayback: timing.loopPlayback,
    objects,
    camera,
    lighting: normalizeLighting(shot?.lighting || fallback.lighting),
    reference: normalizeReference(shot?.reference || fallback.reference),
    keyframes,
    objectKeyframes,
    routeTracks,
  }
}

function isUntouchedStarterBlock(object, id, name, position, rotation, scale, color) {
  if (!object || object.id !== id || object.type !== 'box' || object.name !== name) return false
  const same = (a, b, epsilon = 1e-6) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Math.abs(Number(value) - Number(b[index])) <= epsilon)
  return same(object.position, position) && same(object.rotation, rotation) && same(object.scale, scale) && object.color === color && object.generatedScene !== true && object.sourceSceneId === undefined
}

function removeUntouchedStarterBlocks(objects) {
  if (!Array.isArray(objects)) return objects
  return objects.filter(object => !(
    isUntouchedStarterBlock(object, 'block-stage', '平台', [1.4, 0.45, -0.8], [0, -0.18, 0], [2.8, 0.9, 2.1], '#9a968c') ||
    isUntouchedStarterBlock(object, 'block-step', '台阶', [2.9, 0.18, 0.55], [0, -0.18, 0], [1.7, 0.36, 1.1], '#77746d')
  ))
}

function normalizeProjectData(data) {
  if (!data) return null
  const firstShot = Array.isArray(data.shots) ? data.shots[0] : null
  const sourceObjects = Array.isArray(data.objects) ? data.objects : firstShot?.objects
  if (!Array.isArray(sourceObjects)) return null
  const migrateLegacyDefaultDuration = Number(data.version || 0) < PROJECT_VERSION
  const legacySettingsDuration = Number(data.settings?.durationSeconds)
  const settings = normalizeProjectSettings({
    ...data.settings,
    durationSeconds: migrateLegacyDefaultDuration && legacySettingsDuration === 5 ? DEFAULT_PROJECT_SETTINGS.durationSeconds : data.settings?.durationSeconds,
  })
  const fallback = {
    settings,
    objects: sourceObjects,
    camera: data.camera || firstShot?.camera || initialCamera,
    lighting: data.lighting || firstShot?.lighting || DEFAULT_LIGHTING,
    reference: data.reference || firstShot?.reference || DEFAULT_REFERENCE,
    keyframes: data.keyframes || [],
    objectKeyframes: data.objectKeyframes || data.characterKeyframes || {},
    routeTracks: data.routeTracks || {},
  }
  const rawShots = Array.isArray(data.shots) && data.shots.length ? data.shots : [{
    id: 'shot-01',
    name: '镜头 01',
    fps: settings.fps,
    durationSeconds: settings.durationSeconds,
    loopPlayback: settings.loopPlayback,
    objects: fallback.objects,
    camera: fallback.camera,
    lighting: fallback.lighting,
    keyframes: fallback.keyframes,
    objectKeyframes: fallback.objectKeyframes,
    routeTracks: fallback.routeTracks,
  }]
  const shots = rawShots.slice(0, 30).map((shot, index) => {
    const legacyShotDuration = Number(shot?.durationSeconds ?? shot?.settings?.durationSeconds)
    const migratedShot = migrateLegacyDefaultDuration && legacyShotDuration === 5
      ? { ...shot, durationSeconds: DEFAULT_PROJECT_SETTINGS.durationSeconds, settings: { ...shot?.settings, durationSeconds: DEFAULT_PROJECT_SETTINGS.durationSeconds } }
      : shot
    return normalizeShot(migratedShot, index, fallback)
  })
  const activeShotId = shots.some(shot => shot.id === data.activeShotId) ? data.activeShotId : shots[0].id
  const activeShot = shots.find(shot => shot.id === activeShotId) || shots[0]
  return {
    ...data,
    version: PROJECT_VERSION,
    settings: { ...settings, fps: activeShot.fps, durationSeconds: activeShot.durationSeconds, loopPlayback: activeShot.loopPlayback },
    activeShotId,
    shots,
    objects: activeShot.objects,
    camera: activeShot.camera,
    lighting: activeShot.lighting,
    reference: activeShot.reference,
    keyframes: activeShot.keyframes,
    objectKeyframes: activeShot.objectKeyframes,
    routeTracks: activeShot.routeTracks,
  }
}

function readCachedProject() {
  try {
    const current = localStorage.getItem(PROJECT_STORAGE_KEY)
    const legacy = current ? null : localStorage.getItem(LEGACY_PROJECT_STORAGE_KEY)
    const serialized = current || legacy
    const data = JSON.parse(serialized || 'null')
    const normalized = normalizeProjectData(data)
    if (!normalized) return null
    if (!current && legacy) localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(normalized))
    return normalized
  } catch {
    return null
  }
}

function projectData({ settings, objects, camera, lighting, reference, keyframes, objectKeyframes, routeTracks, shots, activeShotId }) {
  const normalizedSettings = normalizeProjectSettings(settings)
  const sourceShots = shots?.length ? shots : [{ id: 'shot-01', name: '镜头 01' }]
  const resolvedActiveShotId = sourceShots.some(shot => shot.id === activeShotId) ? activeShotId : sourceShots[0].id
  const liveShot = {
    ...(sourceShots.find(shot => shot.id === resolvedActiveShotId) || sourceShots[0]),
    id: resolvedActiveShotId,
    fps: normalizedSettings.fps,
    durationSeconds: normalizedSettings.durationSeconds,
    loopPlayback: normalizedSettings.loopPlayback,
    objects,
    camera,
    lighting: normalizeLighting(lighting),
    reference,
    keyframes,
    objectKeyframes,
    routeTracks,
  }
  const serializedShots = sourceShots.map(shot => shot.id === resolvedActiveShotId ? liveShot : shot)
  return {
    version: PROJECT_VERSION,
    settings: normalizedSettings,
    activeShotId: resolvedActiveShotId,
    shots: serializedShots,
    objects,
    camera,
    lighting: normalizeLighting(lighting),
    reference,
    keyframes,
    objectKeyframes,
    routeTracks,
  }
}

function followAtCameraKeyframe(baseFollow, key) {
  if (!key || !baseFollow) return baseFollow
  if (key.followEnabled === false) return null
  return {
    ...baseFollow,
    enabled: key.followEnabled === true ? true : baseFollow.enabled,
    targetId: key.followTargetId || baseFollow.targetId,
    shot: key.followShot || key.shot || baseFollow.shot,
    distance: key.followDistance ?? baseFollow.distance,
    height: key.followHeight ?? baseFollow.height,
    lookHeight: key.followLookHeight ?? baseFollow.lookHeight,
    offset: key.followOffset || baseFollow.offset,
    orbitDegrees: key.followOrbitDegrees ?? baseFollow.orbitDegrees ?? 0,
    sideOffset: key.followSideOffset ?? baseFollow.sideOffset ?? 0,
  }
}

function cameraAtFrame(keyframes, frame, aspectRatio = '16:9', baseCamera) {
  return mergeCameraAxisLocks(resolveCameraAtFrame(keyframes, frame, aspectRatio, baseCamera), baseCamera)
}

function visualCenterForObject(object) {
  if (!object) return [0, 0, 0]
  const position = object.position || [0, 0, 0]
  if (object.type !== 'person') return [...position]
  const root = object.rigRoot || [0, 0, 0]
  const scale = object.scale || [1, 1, 1]
  const localCenter = [root[0] * scale[0], (root[1] + 1) * scale[1], root[2] * scale[2]]
  const offset = rotateVectorXYZ(localCenter, object.rotation)
  return position.map((value, index) => value + offset[index])
}

function fallbackCharacterKeyframes() {
  return {}
}

function ToolButton({ icon: Icon, active, label, onClick, disabled = false, shortcut }) {
  return (
    <button className={`icon-button ${active ? 'is-active' : ''}`} onClick={onClick} disabled={disabled} title={`${label}${shortcut ? ` (${shortcut})` : ''}`} aria-label={label}>
      <Icon size={15} strokeWidth={1.8} />
    </button>
  )
}

function AxisValueInput({ title, label, value, min, max, step, digits, unit = '', disabled = false, onChange }) {
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0
  const [draft, setDraft] = useState(() => formatAxisValue(numericValue, digits))
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!focusedRef.current) setDraft(formatAxisValue(numericValue, digits))
  }, [digits, numericValue])
  const commitText = text => {
    const next = parseAxisValue(text, min, max, digits)
    if (next !== null && next !== numericValue) onChange(next)
    return next
  }
  const handleChange = event => {
    const text = event.target.value
    setDraft(text)
    commitText(text)
  }
  const handleBlur = () => {
    focusedRef.current = false
    const next = parseAxisValue(draft, min, max, digits)
    if (next === null) setDraft(formatAxisValue(numericValue, digits))
    else {
      if (next !== numericValue) onChange(next)
      setDraft(formatAxisValue(next, digits))
    }
  }
  const handleKeyDown = event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setDraft(formatAxisValue(numericValue, digits))
      event.currentTarget.blur()
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const amount = Math.abs(Number(step)) || 0.01
    const next = stepAxisValue(numericValue, event.key === 'ArrowUp' ? 1 : -1, amount * (event.shiftKey ? 10 : 1), min, max, digits)
    setDraft(formatAxisValue(next, digits))
    if (next !== numericValue) onChange(next)
  }
  return (
    <div className="axis-value-field">
      <input
        aria-label={`${title} ${label} 数值`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        disabled={disabled}
        onFocus={event => { focusedRef.current = true; event.target.select() }}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      />
      {unit && <i>{unit}</i>}
    </div>
  )
}

function AxisSlider({ label, title, value, onChange, accent, min, max, step, unit = '', disabled = false, locked = false, onToggleLock }) {
  const numericValue = Number.isFinite(Number(value)) ? Number(value) : 0
  const safeMin = Math.min(min, Math.floor(numericValue / step) * step)
  const safeMax = Math.max(max, Math.ceil(numericValue / step) * step)
  const digits = axisValueDigits(step)
  const lockName = title.split(' · ')[0]
  return (
    <div className={`axis-slider ${onToggleLock ? 'has-axis-lock' : ''} ${locked ? 'is-axis-locked' : ''}`} style={{ '--axis-color': accent }}>
      <span>{label}</span>
      <input aria-label={`${title} ${label}`} type="range" min={safeMin} max={safeMax} step={step} value={numericValue} onChange={event => onChange(Number(event.target.value))} disabled={disabled || locked} />
      <AxisValueInput title={title} label={label} value={numericValue} min={safeMin} max={safeMax} step={step} digits={digits} unit={unit} disabled={disabled || locked} onChange={onChange} />
      {onToggleLock && <button type="button" className="axis-lock-button" aria-label={`${locked ? '解除' : '锁定'} ${lockName} ${label} 轴`} aria-pressed={locked} title={`${locked ? '解除' : '锁定'} ${lockName} ${label} 轴`} disabled={disabled} onClick={onToggleLock}>{locked ? <Lock size={10} /> : <Unlock size={10} />}</button>}
    </div>
  )
}

function VectorFields({ title, value, onChange, degrees = false, kind = 'position', disabled = false, axisLocks = [false, false, false], onToggleAxisLock, proportionalScale = false, onToggleProportionalScale, onReset, resetLabel = '归零', resetTitle }) {
  const source = Array.isArray(value) ? value : [0, 0, 0]
  const display = degrees ? source.map(radToDeg) : source
  const settings = degrees
    ? { min: -180, max: 180, step: 0.1, unit: '°' }
    : kind === 'scale'
      ? { min: 0.05, max: 5, step: 0.01, unit: '' }
      : { min: -30, max: 30, step: 0.01, unit: '' }
  const locks = normalizeAxisLocks(axisLocks)
  const update = (index, next) => {
    if (locks[index]) return
    const copy = [...display]
    if (kind === 'scale' && proportionalScale) {
      const baseline = Math.max(0.0001, Math.abs(display[index]))
      const ratio = next / baseline
      display.forEach((current, axis) => { copy[axis] = locks[axis] ? current : Math.max(0.05, current * ratio) })
    } else copy[index] = next
    onChange(degrees ? copy.map(degToRad) : copy)
  }
  const resetDisabled = disabled || (Boolean(onToggleAxisLock) && locks.every(Boolean))
  return (
    <div className="property-group">
      <div className="property-label-row">
        <div className="property-label" title={title}>{title}</div>
        {(kind === 'scale' || onReset) && <div className="property-label-actions">
          {kind === 'scale' && <button type="button" className={`proportional-lock ${proportionalScale ? 'is-active' : ''}`} aria-pressed={proportionalScale} onClick={onToggleProportionalScale} disabled={disabled} title="开启后拖动任意未锁定轴，其他未锁定轴按原比例同步缩放">{proportionalScale ? <Link2 size={11} /> : <Unlink2 size={11} />} 等比</button>}
          {onReset && <button type="button" className="property-reset" onClick={onReset} disabled={resetDisabled} title={resetTitle || `${resetLabel}${title}`}><RotateCcw size={10} /> {resetLabel}</button>}
        </div>}
      </div>
      <div className="axis-sliders">
        <AxisSlider label="X" title={title} value={display[0]} onChange={value => update(0, value)} accent="#d7675b" disabled={disabled} locked={locks[0]} onToggleLock={onToggleAxisLock ? () => onToggleAxisLock(0) : null} {...settings} />
        <AxisSlider label="Y" title={title} value={display[1]} onChange={value => update(1, value)} accent="#76a96c" disabled={disabled} locked={locks[1]} onToggleLock={onToggleAxisLock ? () => onToggleAxisLock(1) : null} {...settings} />
        <AxisSlider label="Z" title={title} value={display[2]} onChange={value => update(2, value)} accent="#5d87c7" disabled={disabled} locked={locks[2]} onToggleLock={onToggleAxisLock ? () => onToggleAxisLock(2) : null} {...settings} />
      </div>
    </div>
  )
}

function InspectorSection({ title, collapsed, onToggle, children }) {
  return (
    <div className={`inspector-section ${collapsed ? 'is-collapsed' : ''}`}>
      <button
        type="button"
        className="section-title"
        aria-expanded={!collapsed}
        title={`${collapsed ? '展开' : '收起'}${title}`}
        onClick={onToggle}
        onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') event.stopPropagation() }}
      >
        <span>{title}</span><ChevronDown size={14} />
      </button>
      {!collapsed && <div className="section-content">{children}</div>}
    </div>
  )
}

function AssetCard({ icon: Icon, title, subtitle, onClick, previewClass = '' }) {
  return (
    <button className="asset-card" onClick={onClick}>
      <span className={`asset-preview ${previewClass}`}><Icon size={28} strokeWidth={1.2} /></span>
      <span className="asset-copy"><strong>{title}</strong><small>{subtitle}</small></span>
      <Plus className="asset-add" size={14} />
    </button>
  )
}

function SceneList({ objects, selectedId, onSelect, onToggleVisible, onToggleLock, onClearCanvas }) {
  return (
    <div className="scene-list">
      <div className="scene-list-toolbar"><span>场景对象 · {objects.length}</span><button type="button" className="clear-canvas-button" onClick={onClearCanvas} disabled={!objects.length} title="删除画布中的全部对象，保留主摄像机"><Trash2 size={12} /> 清空画布</button></div>
      <div className={`scene-row ${selectedId === CAMERA_ID ? 'is-selected' : ''}`} onClick={() => onSelect(CAMERA_ID)}>
        <Camera size={14} /><span>主摄像机</span><i className="status-dot live" />
      </div>
      {objects.map(object => (
        <div key={object.id} className={`scene-row ${selectedId === object.id ? 'is-selected' : ''}`} onClick={() => onSelect(object.id)}>
          {object.type === 'person' ? <UserRound size={14} /> : object.type === 'model' ? <Sparkles size={14} /> : object.type === 'depthMesh' ? <ScanLine size={14} /> : <Box size={14} />}
          <span>{object.name}</span>
          <button className="scene-row-action" title={object.locked ? '解除锁定' : '锁定物体'} onClick={event => { event.stopPropagation(); onToggleLock(object.id) }}>{object.locked ? <Lock size={11} /> : <Unlock size={11} />}</button>
          <button className="scene-row-action visibility-action" title={object.visible === false ? '显示物体' : '隐藏物体'} onClick={event => { event.stopPropagation(); onToggleVisible(object.id) }}><i className={`status-dot ${object.visible === false ? '' : 'on'}`} /></button>
        </div>
      ))}
    </div>
  )
}

function CameraMotionPanel({ camera, objects, currentFrame, fps, onUpdateCamera, onAddKeyframe, onOpenCameraView }) {
  const targetId = camera.follow?.targetId || objects.find(item => item.type === 'person')?.id || ''
  const follow = camera.follow
  const currentShot = camera.shot || follow?.shot || 'medium'
  const preset = shotPreset(currentShot)
  const enable = event => onUpdateCamera({ follow: event.target.checked ? { ...follow, enabled: true, targetId, shot: follow?.shot || currentShot, distance: follow?.distance ?? preset.distance, height: follow?.height ?? preset.height, lookHeight: follow?.lookHeight ?? preset.lookHeight, focalLength: follow?.focalLength ?? preset.focalLength, orbitDegrees: follow?.orbitDegrees ?? 0, sideOffset: follow?.sideOffset ?? 0 } : null })
  const patchFollow = patch => onUpdateCamera({ follow: { ...follow, ...patch } })
  const setShot = value => {
    const next = shotPreset(value)
    onUpdateCamera({ shot: value, focalLength: next.focalLength, ...(follow?.enabled ? { follow: { ...follow, shot: value, distance: next.distance, height: next.height, lookHeight: next.lookHeight, focalLength: next.focalLength } } : {}) })
  }
  return <div className="camera-motion-panel"><div className="section-kicker">镜头运动 · 当前 {Math.round(currentFrame)} 帧（{(currentFrame / fps).toFixed(2)} 秒）</div><button type="button" onClick={onOpenCameraView}>查看摄像机画面</button><label>景别<select value={currentShot} onChange={event => setShot(event.target.value)}>{Object.entries(CAMERA_SHOT_PRESETS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label><label><input type="checkbox" checked={Boolean(follow?.enabled && follow?.targetId)} onChange={enable} /> 跟随角色</label>{follow?.enabled && <><label>跟随角色<select value={targetId} onChange={event => patchFollow({ targetId: event.target.value })}>{objects.filter(item => item.type === 'person').map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>距离（角色高度 H）<input type="range" min="1" max="20" step="0.1" value={follow.distance ?? preset.distance} onChange={event => patchFollow({ distance:Number(event.target.value) })} /><output>{Number(follow.distance ?? preset.distance).toFixed(1)} H</output></label><label>环绕角度<input type="range" min="-180" max="180" value={follow.orbitDegrees ?? 0} onChange={event => patchFollow({ orbitDegrees:Number(event.target.value) })} /><output>{Math.round(follow.orbitDegrees ?? 0)}°</output></label></>}<label>焦距<input type="range" min="18" max="120" value={camera.focalLength} onChange={event => onUpdateCamera({ focalLength:Number(event.target.value) })} /><output>{Math.round(camera.focalLength)} mm</output></label><button type="button" className="camera-motion-key" onClick={onAddKeyframe}>在当前帧记录镜头关键帧</button><small>先定位时间轴，再调焦距／景别／跟随，点击记录；已选关键帧可在时间轴参数区直接修改。</small></div>
}

function LeftSidebar({ objects, selectedId, onSelect, onAddPerson, onAddPrimitive, onImport, onToggleVisible, onToggleLock, shots, activeShotId, onSelectShot, onAddShot, onDuplicateShot, onDeleteShot, onRenameShot, onCaptureShot, camera, currentFrame, fps, onUpdateCamera, onAddCameraKeyframe, onOpenCameraView, onClearCanvas }) {
  const [tab, setTab] = useState('assets')
  const inputRef = useRef(null)
  return (
    <aside className="left-sidebar panel">
      <div className="panel-tabs">
        <button className={tab === 'assets' ? 'is-active' : ''} onClick={() => setTab('assets')}>资源库</button>
        <button className={tab === 'scene' ? 'is-active' : ''} onClick={() => setTab('scene')}>场景层级</button>
        <button className={tab === 'shots' ? 'is-active' : ''} onClick={() => setTab('shots')}>镜头</button>
        <button className={tab === 'motion' ? 'is-active' : ''} onClick={() => setTab('motion')}>镜头运动</button>
      </div>
      {tab === 'assets' ? (
        <div className="assets-scroll">
          <div className="section-kicker">人物体型</div>
          <AssetCard icon={UserRound} title="标准人物" subtitle="标准骨骼 · 可做精细动作" onClick={() => onAddPerson('standard')} previewClass="person-preview" />
          <AssetCard icon={ScanFace} title="极简模型" subtitle="圆柱+圆头 · 静态占位" onClick={() => onAddPerson('minimal')} />
          <div className="section-kicker section-gap">基础物体</div>
          <div className="primitive-grid">
            <button onClick={() => onAddPrimitive('box')}><Box size={24} /><span>方块</span></button>
            <button onClick={() => onAddPrimitive('sphere')}><CircleDot size={24} /><span>球体</span></button>
            <button onClick={() => onAddPrimitive('cylinder')}><CircleDot size={24} /><span>圆柱</span></button>
            <button onClick={() => onAddPrimitive('plane')}><Grid3X3 size={24} /><span>平面</span></button>
          </div>
          <div className="section-kicker section-gap">场景粗模</div>
          <div className="primitive-grid blockout-grid">
            {[['arch', '拱门'], ['stairs', '楼梯'], ['door', '门'], ['window', '窗'], ['table', '桌子'], ['chair', '椅子'], ['sofa', '沙发'], ['roof', '屋顶'], ['tree', '树木'], ['vehicle', '车辆']].map(([type, label]) => (
              <button key={type} onClick={() => onAddPrimitive(type)}><Box size={20} /><span>{label}</span></button>
            ))}
          </div>
          <div className="section-kicker section-gap">外部模型</div>
          <button className="import-drop" onClick={() => inputRef.current?.click()}>
            <Import size={18} /><strong>导入 GLB / GLTF</strong><span>导入本地三维模型</span>
          </button>
          <input ref={inputRef} className="visually-hidden" type="file" accept=".glb,.gltf" onChange={onImport} />
        </div>
      ) : tab === 'scene' ? (
        <SceneList objects={objects} selectedId={selectedId} onSelect={onSelect} onToggleVisible={onToggleVisible} onToggleLock={onToggleLock} onClearCanvas={onClearCanvas} />
      ) : tab === 'motion' ? (
        <CameraMotionPanel camera={camera} objects={objects} currentFrame={currentFrame} fps={fps} onUpdateCamera={onUpdateCamera} onAddKeyframe={onAddCameraKeyframe} onOpenCameraView={onOpenCameraView} />
      ) : <ShotsPanel shots={shots} activeShotId={activeShotId} onSelect={onSelectShot} onAdd={onAddShot} onDuplicate={onDuplicateShot} onDelete={onDeleteShot} onRename={onRenameShot} onCapture={onCaptureShot} />}
    </aside>
  )
}

function Inspector({ selected, camera, objects = [], selectedJoint, customPoses, onSelectJoint, onUpdateObject, onUpdateCamera, onDelete, onDuplicate, onFocus, onToggleLock, onGround, onResetPosition, onResetRotation, onResetScale, onSaveCustomPose, onApplyCustomPose, onDeleteCustomPose }) {
  const [collapsedSections, setCollapsedSections] = useState({})
  const toggleSection = id => setCollapsedSections(current => ({ ...current, [id]: !current[id] }))
  if (!selected) {
    return <div className="inspector-panel empty-inspector"><MousePointer2 size={24} /><span>选择场景中的物体</span></div>
  }
  const isCamera = selected.id === CAMERA_ID
  const position = isCamera ? camera.position : selected.position
  const typeLabel = selected.type === 'depthMesh' ? 'DEPTH SPACE' : selected.type?.toUpperCase()
  const rigPose = selected.type === 'person' ? poseForObject(selected) : null
  const canLoopPose = selected.type === 'person' && poseCanLoop(selected.pose)
  const jointRotation = rigPose?.joints[selectedJoint] || [0, 0, 0]
  const positionLocks = normalizeAxisLocks(isCamera ? camera.positionAxisLocks : selected.positionAxisLocks)
  const rotationLocks = normalizeAxisLocks(isCamera ? camera.rotationAxisLocks : selected.rotationAxisLocks)
  const scaleLocks = normalizeAxisLocks(selected.scaleAxisLocks)
  const toggleAxis = (field, locks, axis) => {
    const next = toggleAxisLock(locks, axis)
    if (isCamera) onUpdateCamera({ [field]: next })
    else onUpdateObject({ [field]: next })
  }
  const positionResetLabel = isCamera ? '复位' : '归零'
  const rotationResetLabel = isCamera ? '复位' : '归零'
  const positionResetTitle = isCamera ? '恢复默认机位（已锁定的轴保持原值）' : '将位置恢复为 0（已锁定的轴保持原值）'
  const rotationResetTitle = isCamera ? '恢复默认朝向（已锁定的轴保持原值）' : `${selected.type === 'person' ? '将整体旋转' : '将旋转'}恢复为 0°（已锁定的轴保持原值）`
  const updateJoint = rotation => onUpdateObject({
    joints: { ...rigPose.joints, [selectedJoint]: rotation },
  })
  const applyPreset = pose => onUpdateObject({
    pose: normalizePoseId(pose),
    poseTime: presetPhase(pose),
    continuousMotion: poseCanLoop(pose) ? Boolean(selected.continuousMotion) : false,
    rigRoot: presetRoot(pose),
    joints: presetJoints(pose),
  })
  return (
    <div className="inspector-panel">
      <div className="inspector-head">
        <div><small>{isCamera ? 'CAMERA' : typeLabel}</small>{isCamera ? <strong>主摄像机</strong> : <input className="inspector-name-input" value={selected.name} onChange={event => onUpdateObject({ name: event.target.value })} aria-label="物体名称" />}</div>
        <div className="inspector-head-actions">
          <ToolButton icon={Focus} label="视图聚焦" onClick={onFocus} />
          {!isCamera && <ToolButton icon={selected.locked ? Unlock : Lock} label={selected.locked ? '解除锁定' : '锁定'} onClick={onToggleLock} />}
          {!isCamera && <ToolButton icon={Copy} label="复制" onClick={onDuplicate} />}
          {!isCamera && <ToolButton icon={Trash2} label="删除" onClick={onDelete} />}
        </div>
      </div>
      <div className="inspector-scroll">
        {!isCamera && selected.locked && <div className="locked-banner"><Lock size={12} /> 已锁定空间变换</div>}
        <InspectorSection title="变换" collapsed={Boolean(collapsedSections.transform)} onToggle={() => toggleSection('transform')}>
          <VectorFields
            title="位置"
            value={position}
            onChange={value => isCamera ? onUpdateCamera({ position: value }) : onUpdateObject({ position: value })}
            disabled={!isCamera && selected.locked}
            axisLocks={positionLocks}
            onToggleAxisLock={axis => toggleAxis('positionAxisLocks', positionLocks, axis)}
            onReset={onResetPosition}
            resetLabel={positionResetLabel}
            resetTitle={positionResetTitle}
          />
          {isCamera
            ? <VectorFields title="摄像机旋转 · X 俯仰 / Y 水平 / Z 翻滚" value={camera.rotation} degrees onChange={rotation => onUpdateCamera({ rotation })} axisLocks={rotationLocks} onToggleAxisLock={axis => toggleAxis('rotationAxisLocks', rotationLocks, axis)} onReset={onResetRotation} resetLabel={rotationResetLabel} resetTitle={rotationResetTitle} />
            : <VectorFields title={selected.type === 'person' ? '整体旋转 · X 纵向 / Y 水平 / Z 翻滚' : '旋转'} value={selected.rotation} degrees onChange={rotation => onUpdateObject({ rotation })} disabled={selected.locked} axisLocks={rotationLocks} onToggleAxisLock={axis => toggleAxis('rotationAxisLocks', rotationLocks, axis)} onReset={onResetRotation} resetLabel={rotationResetLabel} resetTitle={rotationResetTitle} />}
          {!isCamera && <VectorFields
            title="缩放"
            kind="scale"
            value={selected.scale}
            proportionalScale={Boolean(selected.proportionalScale)}
            axisLocks={scaleLocks}
            onToggleProportionalScale={() => onUpdateObject({ proportionalScale: !selected.proportionalScale })}
            onToggleAxisLock={axis => onUpdateObject({ scaleAxisLocks: toggleAxisLock(scaleLocks, axis) })}
            onReset={onResetScale}
            resetLabel="归一"
            resetTitle="将缩放恢复为 1（已锁定的轴保持原值）"
            onChange={scale => onUpdateObject({ scale })}
            disabled={selected.locked}
          />}
          {!isCamera && <div className="transform-quick-actions">
            <button type="button" onClick={onGround} disabled={selected.locked || positionLocks[1]} title={positionLocks[1] ? 'Y 轴已锁定，请先解锁' : '按当前外形将物体最低点贴到世界地面'}><ArrowDownToLine size={11} /> 落到地面</button>
          </div>}
        </InspectorSection>
        {isCamera ? (
          <InspectorSection title="镜头" collapsed={Boolean(collapsedSections.camera)} onToggle={() => toggleSection('camera')}>
            <label className="range-field"><span>焦距</span><input type="range" min="18" max="120" value={camera.focalLength} onChange={e => onUpdateCamera({ focalLength: Number(e.target.value) })} /><output>{Math.round(camera.focalLength)} mm</output></label>
            <div className="focal-presets" aria-label="常用焦距">
              {FOCAL_LENGTH_PRESETS.map(value => <button type="button" key={value} className={Math.round(camera.focalLength) === value ? 'is-active' : ''} onClick={() => onUpdateCamera({ focalLength: value })}>{value}</button>)}
            </div>
            <div className="camera-follow-control">
              <label className="settings-toggle"><input type="checkbox" checked={Boolean(camera.follow?.enabled && camera.follow?.targetId)} onChange={event => {
                const targetId = camera.follow?.targetId || objects.find(object => object.type === 'person')?.id || ''
                const presetValue = shotPreset(camera.follow?.shot || 'medium')
                onUpdateCamera({ follow: event.target.checked ? { ...(camera.follow || {}), enabled: true, targetId, shot: camera.follow?.shot || 'medium', distance: camera.follow?.distance ?? presetValue.distance, height: camera.follow?.height ?? presetValue.height, lookHeight: camera.follow?.lookHeight ?? presetValue.lookHeight, offset: camera.follow?.offset || [0, presetValue.height, presetValue.distance], focalLength: camera.follow?.focalLength ?? presetValue.focalLength } : null })
              }} /><span><strong>跟随角色移动</strong><small>播放时每一帧重新计算摄像机位置</small></span></label>
              {camera.follow?.enabled && camera.follow?.targetId && <>
                <small className="camera-unit-note">距离和高度按角色高度比例计算 · 当前单位：H</small>
                <label className="select-field"><span>跟随对象</span><select value={camera.follow.targetId} onChange={event => onUpdateCamera({ follow: { ...camera.follow, targetId: event.target.value } })}>{objects.filter(object => object.type === 'person').map(object => <option key={object.id} value={object.id}>{object.name}</option>)}</select></label>
                <div className="shot-preset-buttons" aria-label="跟随景别">{Object.entries(CAMERA_SHOT_PRESETS).map(([value,preset]) => <button type="button" key={value} className={(camera.follow.shot || 'medium') === value ? 'is-active' : ''} onClick={() => { const presetValue=shotPreset(value); onUpdateCamera({ follow: { ...camera.follow, shot:value, focalLength:presetValue.focalLength, distance:presetValue.distance, height:presetValue.height, lookHeight:presetValue.lookHeight, offset:[0,presetValue.height,presetValue.distance] } }) }}>{preset.label}</button>)}</div>
                <label className="range-field"><span>跟随距离</span><input type="range" min="1" max="20" step="0.1" value={camera.follow.distance} onChange={event => onUpdateCamera({ follow: { ...camera.follow, distance: Number(event.target.value), offset: [camera.follow.offset?.[0] || 0, camera.follow.height, Number(event.target.value)] } })} /><output>{Number(camera.follow.distance).toFixed(1)} H</output></label>
                <label className="range-field"><span>跟随高度</span><input type="range" min="0.2" max="10" step="0.1" value={camera.follow.height} onChange={event => onUpdateCamera({ follow: { ...camera.follow, height: Number(event.target.value), offset: [camera.follow.offset?.[0] || 0, Number(event.target.value), camera.follow.distance] } })} /><output>{Number(camera.follow.height).toFixed(1)} H</output></label>
                <label className="range-field"><span>环绕角度</span><input type="range" min="-180" max="180" step="1" value={camera.follow.orbitDegrees ?? 0} onChange={event => onUpdateCamera({ follow: { ...camera.follow, orbitDegrees: Number(event.target.value) } })} /><output>{Math.round(camera.follow.orbitDegrees ?? 0)}°</output></label>
                <label className="range-field"><span>左右偏移</span><input type="range" min="-10" max="10" step="0.1" value={camera.follow.sideOffset ?? 0} onChange={event => onUpdateCamera({ follow: { ...camera.follow, sideOffset: Number(event.target.value) } })} /><output>{Number(camera.follow.sideOffset ?? 0).toFixed(1)} H</output></label>
              </>}
            </div>
            <div className="camera-info"><span>传感器</span><strong>全画幅 36 mm</strong></div>
            <label className="select-field aspect-field"><span>画面比例</span><select value={aspectSelectValue(camera.aspectRatio || '16:9')} onChange={event => onUpdateCamera({ aspectRatio: event.target.value === 'custom' ? customAspectFrom(camera.aspectRatio) : event.target.value })}>{ASPECT_RATIOS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            {aspectSelectValue(camera.aspectRatio) === 'custom' && (() => {
              const [customWidth, customHeight] = customAspectParts(camera.aspectRatio)
              return <div className="custom-aspect-inputs"><span>自定义</span><input aria-label="自定义画幅宽" type="number" min="0.1" max="100" step="0.1" value={customWidth} onChange={event => onUpdateCamera({ aspectRatio: customAspectValue(event.target.value, customHeight) })} /><i>:</i><input aria-label="自定义画幅高" type="number" min="0.1" max="100" step="0.1" value={customHeight} onChange={event => onUpdateCamera({ aspectRatio: customAspectValue(customWidth, event.target.value) })} /></div>
            })()}
          </InspectorSection>
        ) : selected.type === 'person' && selected.bodyType === 'minimal' ? (
          <InspectorSection title="人物" collapsed={Boolean(collapsedSections.person)} onToggle={() => toggleSection('person')}>
            <label className="select-field"><span>体型</span><select value={selected.bodyType} onChange={e => onUpdateObject({ bodyType: e.target.value })}>{PERSON_BODY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-field"><span>面部文字</span><input aria-label="极简模型面部文字" maxLength={5} placeholder="1-5 个字，可留空" value={selected.faceText || ''} onChange={event => onUpdateObject({ faceText: normalizeFaceText(event.target.value) })} /><output>{Array.from(selected.faceText || '').length}/5</output></label>
            <p className="pose-source-note">极简模型为静态占位：不参与动作、骨骼与表情，用于构图、朝向和面部文字标注。切回标准人物后会恢复原有动作设置。</p>
            <label className="color-field person-color-field"><span>人物颜色</span><input type="color" value={selected.color || '#e8e3d8'} onChange={e => onUpdateObject({ color: e.target.value })} /><output>{selected.color || '#e8e3d8'}</output></label>
          </InspectorSection>
        ) : selected.type === 'person' ? (
          <InspectorSection title="人物" collapsed={Boolean(collapsedSections.person)} onToggle={() => toggleSection('person')}>
            <label className="select-field"><span>体型</span><select value={selected.bodyType} onChange={e => onUpdateObject({ bodyType: e.target.value })}>{PERSON_BODY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="select-field"><span>动作预设</span><select value={normalizePoseId(selected.pose)} onChange={e => applyPreset(e.target.value)}>{RIG_PRESET_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="range-field pose-time-field"><span>动作相位</span><input type="range" min="0" max="1" step="0.01" value={Number.isFinite(selected.poseTime) ? selected.poseTime : presetPhase(selected.pose)} onChange={e => onUpdateObject({ poseTime: Number(e.target.value) })} /><output>{Math.round((Number.isFinite(selected.poseTime) ? selected.poseTime : presetPhase(selected.pose)) * 100)}%</output></label>
            <label className={`motion-loop-control ${canLoopPose ? '' : 'is-disabled'}`}>
              <input type="checkbox" checked={canLoopPose && Boolean(selected.continuousMotion)} disabled={!canLoopPose} onChange={event => onUpdateObject({ continuousMotion: event.target.checked })} />
              <span><strong>随时间轴循环动作</strong><small>{canLoopPose ? '播放、拖帧和导出时持续循环' : '当前预设是固定姿势，不支持循环'}</small></span>
            </label>
            <p className="pose-source-note">角色状态关键帧会记录动作、相位、循环开关和完整骨骼，并在对应帧切换。动作来源：Three.js X-Bot 与 CC0 日常动作；预设之外的精细动作可以交给 AI 助手里的「骨骼动画师」。当前模型没有面部表情，需要角色标识时可用「极简模型」的面部文字。</p>
            <div className="pose-library">
              <div className="pose-library-head"><span>动作库</span><small>{RIG_PRESET_OPTIONS.length} PRESETS</small></div>
              {RIG_PRESET_GROUPS.map(group => (
                <div className="pose-group" key={group.label}>
                  <div className="pose-group-label">{group.label}</div>
                  <div className="pose-grid">
                    {group.poses.map(([value, label]) => (
                      <button key={value} type="button" data-pose={value} className={normalizePoseId(selected.pose) === value ? 'is-active' : ''} onClick={() => applyPreset(value)} title={`${group.label} · ${label}`}>
                        <span className="pose-figure"><i /><i /><i /></span>
                        <strong>{label}</strong>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="joint-editor">
              <div className="joint-editor-head"><span>完整骨骼</span><small>{JOINT_DEFINITIONS.length} 根均可旋转</small></div>
              <label className="select-field"><span>当前骨骼</span><select value={selectedJoint} onChange={event => onSelectJoint(event.target.value)}>{JOINT_GROUPS.map(group => <optgroup key={group.label} label={group.label}>{group.joints.map(joint => <option key={joint.id} value={joint.id}>{joint.label}</option>)}</optgroup>)}</select></label>
              <VectorFields title="关节旋转" value={jointRotation} degrees onChange={updateJoint} />
              <button type="button" className="joint-reset-button" onClick={() => updateJoint([0, 0, 0])}>重置当前关节</button>
              <button type="button" className="joint-reset-button" onClick={() => onUpdateObject({ joints: presetJoints(selected.pose) })}>重置全部骨骼</button>
              <p className="joint-editor-hint">按 Q 后拖动青绿色的手脚控制点可摆放四肢末端；拖动人物其他部位或金色骨骼点可旋转单根骨骼。按住 Shift 左右拖可调整单骨骼扭转，也可使用 X/Y/Z 滑块微调。</p>
              <label className="foot-lock-control">
                <input type="checkbox" checked={Boolean(selected.footLock)} onChange={event => onUpdateObject({ footLock: event.target.checked })} />
                <span><strong>脚底锁定</strong><small>脚部 IK 保持当前脚底高度，只沿地面拖动</small></span>
              </label>
            </div>
            <div className="custom-pose-library">
              <div className="joint-editor-head"><span>我的姿势</span><small>{customPoses.length} SAVED</small></div>
              <button type="button" className="save-custom-pose" onClick={() => onSaveCustomPose(selected)}><Save size={12} /> 保存当前姿势</button>
              {customPoses.length ? (
                <div className="custom-pose-list">
                  {customPoses.map(customPose => (
                    <div className="custom-pose-row" key={customPose.id}>
                      <button type="button" onClick={() => onApplyCustomPose(customPose)} title={`应用“${customPose.name}”`}>{customPose.name}</button>
                      <button type="button" className="custom-pose-delete" onClick={() => onDeleteCustomPose(customPose.id)} title={`删除“${customPose.name}”`} aria-label={`删除“${customPose.name}”`}><Trash2 size={11} /></button>
                    </div>
                  ))}
                </div>
              ) : <p className="custom-pose-empty">还没有保存的姿势。调整骨骼后可存入本机姿势库。</p>}
            </div>
            <label className="color-field person-color-field"><span>人物颜色</span><input type="color" value={selected.color || '#e8e3d8'} onChange={e => onUpdateObject({ color: e.target.value })} /><output>{selected.color || '#e8e3d8'}</output></label>
          </InspectorSection>
        ) : (
          <InspectorSection title="外观" collapsed={Boolean(collapsedSections.appearance)} onToggle={() => toggleSection('appearance')}>
            <label className="color-field"><span>白模材质</span><input type="color" value={selected.color || '#d8d3c8'} onChange={e => onUpdateObject({ color: e.target.value })} /><output>{selected.color || '#d8d3c8'}</output></label>
          </InspectorSection>
        )}
      </div>
    </div>
  )
}

function ProjectSettingsDialog({ settings, maxKeyframeFrame = 0, onApply, onClose }) {
  const [draft, setDraft] = useState(settings)
  const totalFrames = Number(draft.fps) * Number(draft.durationSeconds)
  const safeMaxKeyframeFrame = normalizeFrameNumber(maxKeyframeFrame)
  const requiredSeconds = Math.max(1, Math.ceil(safeMaxKeyframeFrame / (Number(draft.fps) || DEFAULT_PROJECT_SETTINGS.fps)))
  const hasDurationConflict = Number.isFinite(totalFrames) && totalFrames < safeMaxKeyframeFrame
  const submit = event => {
    event.preventDefault()
    onApply(normalizeProjectSettings(draft))
  }
  return (
    <div className="settings-overlay" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
      <form className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="project-settings-title" onSubmit={submit}>
        <div className="settings-dialog-head">
          <div><Settings2 size={17} /><span><strong id="project-settings-title">时间轴设置</strong><small>先确定时长，再制作关键帧</small></span></div>
          <button type="button" onClick={onClose} aria-label="关闭时间轴设置">关闭</button>
        </div>
        <div className="settings-fields">
          <label><span>工程名称</span><input autoFocus value={draft.name} maxLength="40" onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label>
          <div className="settings-field-row">
            <label><span>帧率</span><select value={draft.fps} onChange={event => setDraft(current => ({ ...current, fps: Number(event.target.value) }))}>{FPS_OPTIONS.map(value => <option value={value} key={value}>{value} FPS</option>)}</select></label>
            <label><span>时间轴总时长</span><div className="duration-input"><input type="number" min="1" max="60" step="1" value={draft.durationSeconds} onChange={event => setDraft(current => ({ ...current, durationSeconds: event.target.value }))} /><i>秒</i></div></label>
          </div>
          <div className={`settings-summary ${hasDurationConflict ? 'is-warning' : ''}`}>
            <span>关键帧条范围</span>
            <strong>0–{Number.isFinite(totalFrames) ? totalFrames : 0} 帧</strong>
            <small>{safeMaxKeyframeFrame ? `最后关键帧：第 ${safeMaxKeyframeFrame} 帧 · 当前帧率最短 ${requiredSeconds} 秒` : `${draft.fps || 0} FPS · 导出 MP4 将严格使用此时长`}</small>
          </div>
          {hasDurationConflict && <p className="settings-warning">当前时长放不下已有关键帧，请至少设置为 {requiredSeconds} 秒，或先删除/移动末尾关键帧。</p>}
          <label className="settings-toggle"><input type="checkbox" checked={Boolean(draft.loopPlayback)} onChange={event => setDraft(current => ({ ...current, loopPlayback: event.target.checked }))} /><span><strong>循环播放</strong><small>到达镜头结尾后自动从第 0 帧继续</small></span></label>
        </div>
        <div className="settings-dialog-actions"><button type="button" onClick={onClose}>取消</button><button type="submit">应用设置</button></div>
      </form>
    </div>
  )
}

function ViewportAspectPicker({ value, onChange }) {
  const selected = aspectSelectValue(value)
  const [customWidth, customHeight] = customAspectParts(value)
  const choose = next => onChange(next === 'custom' ? customAspectFrom(value) : next)
  return (
    <div className="viewport-aspect-picker floating-panel" aria-label="主视图画面比例">
      <span className="viewport-aspect-label">画幅</span>
      {COMMON_ASPECT_RATIOS.map(ratio => (
        <button type="button" key={ratio} className={selected === ratio ? 'is-active' : ''} onClick={() => choose(ratio)}>{ratio}</button>
      ))}
      <button type="button" className={selected === 'custom' ? 'is-active' : ''} onClick={() => choose('custom')}>自定义</button>
      {selected === 'custom' && (
        <span className="viewport-custom-aspect">
          <input aria-label="自定义画幅宽" type="number" min="0.1" max="100" step="0.1" value={customWidth} onChange={event => onChange(customAspectValue(event.target.value, customHeight))} />
          <i>:</i>
          <input aria-label="自定义画幅高" type="number" min="0.1" max="100" step="0.1" value={customHeight} onChange={event => onChange(customAspectValue(customWidth, event.target.value))} />
        </span>
      )}
    </div>
  )
}

function LightingPanel({ lighting, onChange, onClose }) {
  const update = patch => onChange(current => normalizeLighting({ ...current, ...patch }))
  const range = (label, key, minimum, maximum, step, suffix = '') => (
    <label className="lighting-range" key={key}>
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={minimum}
        max={maximum}
        step={step}
        value={lighting[key]}
        onChange={event => update({ [key]: Number(event.target.value) })}
      />
      <output>{Number(lighting[key]).toFixed(step < 1 ? 2 : 0)}{suffix}</output>
    </label>
  )
  const color = (label, key) => (
    <label className="lighting-color" key={key}>
      <span>{label}</span>
      <input type="color" aria-label={label} value={lighting[key]} onChange={event => update({ [key]: event.target.value })} />
      <output>{lighting[key]}</output>
    </label>
  )
  return (
    <div className="lighting-panel floating-panel" role="dialog" aria-label="场景光照调整">
      <div className="lighting-panel-head">
        <div><Sun size={14} /><span><strong>场景光照</strong><small>当前镜头 · 导出同步</small></span></div>
        <button type="button" onClick={onClose} aria-label="收起光照面板"><ChevronUp size={13} /></button>
      </div>
      <div className="lighting-panel-body">
        {range('环境亮度', 'ambientIntensity', 0, 3, 0.05)}
        {range('主光亮度', 'keyIntensity', 0, 6, 0.05)}
        {range('补光亮度', 'fillIntensity', 0, 4, 0.05)}
        {range('水平方向', 'keyAzimuth', -180, 180, 1, '°')}
        {range('主光高度', 'keyElevation', 5, 85, 1, '°')}
        {range('画面曝光', 'exposure', 0.25, 1.75, 0.01)}
        <div className="lighting-colors">
          {color('环境色', 'ambientColor')}
          {color('主光色', 'keyColor')}
          {color('补光色', 'fillColor')}
        </div>
      </div>
      <div className="lighting-panel-foot"><button type="button" onClick={() => onChange(cloneProjectValue(DEFAULT_LIGHTING))}>恢复默认光照</button></div>
    </div>
  )
}

function CameraAnglePanel({ camera, onChange, onClose, onLevel }) {
  const rotation = Array.isArray(camera.rotation) ? camera.rotation : [0, 0, 0]
  const rotationAxisLocks = normalizeAxisLocks(camera.rotationAxisLocks)
  const updateAxis = (axis, degrees) => {
    if (rotationAxisLocks[axis]) return
    const next = [...rotation]
    next[axis] = Number(degrees) * Math.PI / 180
    onChange({ rotation: next })
  }
  const range = (label, axis, minimum, maximum) => {
    const degrees = Math.round((rotation[axis] || 0) * 180 / Math.PI)
    const locked = rotationAxisLocks[axis]
    return (
      <label className={`camera-angle-range ${locked ? 'is-axis-locked' : ''}`} key={label}>
        <span>{label}</span>
        <input type="range" aria-label={`摄像机${label}`} min={minimum} max={maximum} step="1" value={degrees} disabled={locked} title={locked ? `${label}轴已锁定，请先解锁` : undefined} onChange={event => updateAxis(axis, event.target.value)} />
        <output>{degrees}°</output>
      </label>
    )
  }
  return (
    <div className="camera-angle-panel floating-panel" role="dialog" aria-label="摄像机角度调整">
      <div className="camera-angle-head">
        <div><SlidersHorizontal size={14} /><span><strong>镜头角度</strong><small>参考图地面与水平线校正</small></span></div>
        <button type="button" onClick={onClose} aria-label="收起镜头角度面板"><ChevronUp size={13} /></button>
      </div>
      <div className="camera-angle-body">
        {range('俯仰', 0, -89, 89)}
        {range('水平', 1, -180, 180)}
        {range('翻滚', 2, -45, 45)}
      </div>
      <div className="camera-angle-foot">
        <span>先用“翻滚”校正倾斜，再用俯仰和水平匹配参考图透视。</span>
        <button type="button" onClick={onLevel} disabled={rotationAxisLocks[2]} title={rotationAxisLocks[2] ? '翻滚轴已锁定，请先解锁' : '将摄像机翻滚恢复为 0'}>水平归正</button>
      </div>
    </div>
  )
}

function CameraKeyframeEditor({ keyframe, objects = [], totalFrames = 0, onChange, onClose }) {
  if (!keyframe) return null
  const followEnabled = keyframe.followEnabled === true
  const targetId = keyframe.followTargetId || objects.find(object => object.type === 'person')?.id || ''
  const followShot = keyframe.followShot || keyframe.shot || 'medium'
  const preset = shotPreset(followShot)
  const update = patch => onChange?.(patch)
  // Anchor the popover on the keyframe it edits: the parent slot maps 0-100% to the track.
  const anchor = totalFrames > 0 ? clamp((Number(keyframe.frame) || 0) / totalFrames, 0, 1) : 0
  return <div className="camera-key-editor" style={{ '--anchor': `${anchor * 100}%` }} aria-label="镜头关键帧参数">
    <div className="camera-key-editor-title">
      <span>镜头关键帧参数 · 第 {keyframe.frame} 帧</span>
      <button type="button" onClick={onClose} title="收起关键帧参数" aria-label="收起关键帧参数"><ChevronDown size={12} /></button>
    </div>
    <label className="settings-toggle"><input type="checkbox" checked={followEnabled} onChange={event => update(event.target.checked ? { followEnabled: true, followTargetId: targetId, followShot, followDistance: keyframe.followDistance ?? preset.distance, followHeight: keyframe.followHeight ?? preset.height, followLookHeight: keyframe.followLookHeight ?? preset.lookHeight, followOffset: keyframe.followOffset || [0, preset.height, preset.distance], followOrbitDegrees: keyframe.followOrbitDegrees ?? 0, followSideOffset: keyframe.followSideOffset ?? 0 } : { followEnabled: false, followTargetId: '', followShot: null })} /><span><strong>{followEnabled ? '跟随模式' : '固定镜头'}</strong><small>此状态只影响当前关键帧</small></span></label>
    <label className="select-field"><span>景别</span><select value={followEnabled ? followShot : (keyframe.shot || 'medium')} onChange={event => { const shot = event.target.value; const next = shotPreset(shot); update(followEnabled ? { followShot: shot, shot, followDistance: next.distance, followHeight: next.height, followLookHeight: next.lookHeight, focalLength: next.focalLength } : { shot, focalLength: next.focalLength }) }}>{Object.entries(CAMERA_SHOT_PRESETS).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>
    {followEnabled && <>
      <label className="select-field"><span>跟随对象</span><select value={targetId} onChange={event => update({ followTargetId: event.target.value })}>{objects.filter(object => object.type === 'person').map(object => <option key={object.id} value={object.id}>{object.name}</option>)}</select></label>
      <label className="range-field"><span>跟随距离</span><input type="range" min="1" max="20" step="0.1" value={keyframe.followDistance ?? preset.distance} onChange={event => update({ followDistance: Number(event.target.value) })} /><output>{Number(keyframe.followDistance ?? preset.distance).toFixed(1)} H</output></label>
      <label className="range-field"><span>跟随高度</span><input type="range" min="0.2" max="10" step="0.1" value={keyframe.followHeight ?? preset.height} onChange={event => update({ followHeight: Number(event.target.value) })} /><output>{Number(keyframe.followHeight ?? preset.height).toFixed(1)} H</output></label>
      <label className="range-field"><span>环绕角度</span><input type="range" min="-180" max="180" step="1" value={keyframe.followOrbitDegrees ?? 0} onChange={event => update({ followOrbitDegrees: Number(event.target.value) })} /><output>{Math.round(keyframe.followOrbitDegrees ?? 0)}°</output></label>
      <label className="range-field"><span>左右偏移</span><input type="range" min="-10" max="10" step="0.1" value={keyframe.followSideOffset ?? 0} onChange={event => update({ followSideOffset: Number(event.target.value) })} /><output>{Number(keyframe.followSideOffset ?? 0).toFixed(1)} H</output></label>
    </>}
    <label className="range-field"><span>焦距</span><input type="range" min="18" max="120" step="1" value={keyframe.focalLength ?? 42} onChange={event => update({ focalLength: Number(event.target.value) })} /><output>{Math.round(keyframe.focalLength ?? 42)} mm</output></label>
  </div>
}

function Timeline({ currentFrame, fps, totalFrames, objects = [], onChangeCameraKeyframe, onOpenSettings, onSeek, playing, onTogglePlay, keyframes, onAddKeyframe, onDeleteKeyframe, objectTrack, onAddObjectKeyframe, onDeleteObjectKeyframe, selectedKeyframe, onSelectKeyframe, onMoveKeyframe, onCopyKeyframe, onPasteKeyframe, onDeleteSelectedKeyframe, onChangeInterpolation, hasClipboard }) {
  const [dragging, setDragging] = useState(null)
  // The minimal person is a static placeholder: record its transforms without posing language.
  const trackIsRiggedPerson = objectTrack?.type === 'person' && objectTrack?.bodyType !== 'minimal'
  const rulerFrames = useMemo(() => [...new Set(Array.from({ length: 6 }, (_, index) => Math.round(totalFrames * index / 5)))], [totalFrames])
  const selectedCameraKeyframe = useMemo(() => (
    selectedKeyframe?.kind === 'camera'
      ? keyframes.find(key => key.frame === selectedKeyframe.frame) || null
      : null
  ), [keyframes, selectedKeyframe])
  const scrub = useCallback((event, rect) => {
    onSeek(Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * totalFrames))
  }, [onSeek, totalFrames])
  const onPointerDown = event => {
    const rect = event.currentTarget.getBoundingClientRect()
    scrub(event, rect)
    const move = moveEvent => scrub(moveEvent, rect)
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const beginKeyDrag = (event, key, kind, trackId) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.parentElement.getBoundingClientRect()
    let toFrame = key.frame
    onSeek(key.frame)
    onSelectKeyframe({ kind, frame: key.frame, trackId })
    setDragging({ kind, trackId, fromFrame: key.frame, toFrame })
    const move = moveEvent => {
      toFrame = Math.round(clamp((moveEvent.clientX - rect.left) / rect.width, 0, 1) * totalFrames)
      setDragging({ kind, trackId, fromFrame: key.frame, toFrame })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(null)
      if (toFrame !== key.frame) onMoveKeyframe({ kind, trackId, fromFrame: key.frame, toFrame })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const renderTrack = (frames, kind, onDelete, trackId = null) => (
    <div className={`track ${kind}-track`} onPointerDown={onPointerDown}>
      <div className="track-fill" style={{ width: `${currentFrame / totalFrames * 100}%` }} />
      {!frames.length && <span className="empty-track-note">暂无关键帧</span>}
      {frames.map(key => {
        const isDragged = dragging?.kind === kind && dragging?.trackId === trackId && dragging?.fromFrame === key.frame
        const displayFrame = isDragged ? dragging.toFrame : key.frame
        const isSelected = selectedKeyframe?.kind === kind && selectedKeyframe?.trackId === trackId && selectedKeyframe?.frame === key.frame
        const stateCopy = kind === 'object' && trackIsRiggedPerson ? ` · ${poseLabel(key.pose)}${key.continuousMotion ? '（持续）' : ''}` : ''
        const title = `第 ${key.frame} 帧${stateCopy} · ${normalizeInterpolation(key.interpolation) === 'smooth' ? '平滑' : normalizeInterpolation(key.interpolation) === 'linear' ? '线性' : '保持'} · 拖动可移动`
        return <button key={key.frame} className={`keyframe ${kind} ${key.frame === currentFrame ? 'is-current' : ''} ${isSelected ? 'is-selected' : ''}`} data-interpolation={normalizeInterpolation(key.interpolation)} style={{ left: `${displayFrame / totalFrames * 100}%` }} title={title} aria-label={title} onPointerDown={event => beginKeyDrag(event, key, kind, trackId)} onDoubleClick={event => { event.stopPropagation(); onDelete(key.frame); onSelectKeyframe(null) }} />
      })}
      <div className="playhead" style={{ left: `${currentFrame / totalFrames * 100}%` }}><i /></div>
    </div>
  )
  return (
    <section className="timeline panel">
      <div className="timeline-controls">
        <ToolButton icon={SkipBack} label="回到开头" onClick={() => onSeek(0)} />
        <button className={`play-button ${playing ? 'is-playing' : ''}`} onClick={onTogglePlay}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        <ToolButton icon={SkipForward} label="跳到结尾" onClick={() => onSeek(totalFrames)} />
        <div className="time-readout"><strong>{String(currentFrame).padStart(3, '0')}</strong><span>/ {totalFrames} 帧 · {fps} FPS</span></div>
        <div className="timeline-key-editor">
          {selectedKeyframe ? (
            <>
              <span>{selectedKeyframe.kind === 'camera' ? '镜头' : trackIsRiggedPerson ? '角色状态' : '物体'} · {selectedKeyframe.frame} 帧</span>
              <select value={selectedKeyframe.interpolation} onChange={event => onChangeInterpolation(event.target.value)} title="插值方式">
                <option value="smooth">平滑</option>
                <option value="linear">线性</option>
                <option value="hold">保持</option>
              </select>
              <div><button onClick={onCopyKeyframe} title="复制关键帧"><Copy size={12} /></button><button onClick={onPasteKeyframe} disabled={!hasClipboard} title="粘贴到当前帧"><Plus size={12} /></button><button onClick={onDeleteSelectedKeyframe} title="删除关键帧"><Trash2 size={12} /></button></div>
            </>
          ) : <span className="timeline-key-empty">点击关键帧进行编辑</span>}
        </div>
      </div>
      <div className="timeline-body">
        <div className="ruler timeline-ruler">{rulerFrames.map(frame => <span key={frame} style={{ left: `${frame / totalFrames * 100}%` }}>{frame}</span>)}</div>
        <button type="button" className="timeline-settings-button" onClick={onOpenSettings} title="设置时间轴时长和帧率"><Settings2 size={12} /> 时间轴设置</button>
        <div className="track-label camera-track-label"><Camera size={13} /><span>主摄像机</span></div>
        <div className="camera-track-slot">{renderTrack(keyframes, 'camera', onDeleteKeyframe)}<CameraKeyframeEditor keyframe={selectedCameraKeyframe} objects={objects} totalFrames={totalFrames} onChange={onChangeCameraKeyframe} onClose={() => onSelectKeyframe(null)} /></div>
        <button className="keyframe-button camera-keyframe-button" onClick={onAddKeyframe}><Plus size={13} /> 镜头关键帧</button>
        {objectTrack && (
          <>
            <div className="track-label object-track-label">{objectTrack.type === 'person' ? <UserRound size={13} /> : <Box size={13} />}<span>{objectTrack.name}</span></div>
            <div className="object-track-slot">{renderTrack(objectTrack.keyframes, 'object', onDeleteObjectKeyframe, objectTrack.id)}</div>
            <button className="keyframe-button object-keyframe-button" onClick={onAddObjectKeyframe}><Plus size={13} /> {trackIsRiggedPerson ? '角色状态关键帧' : '物体关键帧'}</button>
          </>
        )}
      </div>
    </section>
  )
}

function referenceImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const imageExtension = /\.(png|jpe?g|webp|bmp|gif)$/i.test(file?.name || '')
    if (!file || (!file.type?.startsWith('image/') && !imageExtension)) { reject(new Error('请选择 PNG、JPG、WEBP、BMP 或 GIF 图片')); return }
    if (file.size > 50 * 1024 * 1024) { reject(new Error('参考图不能超过 50 MB')); return }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('图片格式无法读取'))
      image.onload = () => {
        const longest = Math.max(image.naturalWidth, image.naturalHeight)
        const ratio = Math.min(1, 1600 / Math.max(1, longest))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
        const context = canvas.getContext('2d')
        context.fillStyle = '#e8e6df'
        context.fillRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.84))
      }
      image.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

function referenceCanvasForExport(reference, width, height) {
  return new Promise((resolve, reject) => {
    if (!reference?.image || !reference.includeInExport) return resolve(null)
    const image = new Image()
    image.onerror = () => reject(new Error('参考图无法加入导出画面'))
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      context.fillStyle = '#9b9c98'
      context.fillRect(0, 0, width, height)
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      const drawWidth = width * 0.72 * reference.scale
      const drawHeight = drawWidth * image.naturalHeight / Math.max(1, image.naturalWidth)
      const centerX = width * (0.5 + reference.x / 100)
      const centerY = height * (0.5 + reference.y / 100)
      context.globalAlpha = reference.opacity
      context.drawImage(image, centerX - drawWidth / 2, centerY - drawHeight / 2, drawWidth, drawHeight)
      context.globalAlpha = 1
      resolve(canvas)
    }
    image.src = reference.image
  })
}

function ReferenceOverlay({ reference, onChange, onToast, cameraMode = false, cameraAspect = 16 / 9, children }) {
  const dragRef = useRef(null)
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const update = patch => onChange(current => normalizeReference({ ...current, ...patch }))
  const upload = async event => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    try {
      const image = await referenceImageFromFile(file)
      onChange(normalizeReference({ ...DEFAULT_REFERENCE, image, name: file.name }))
      setEditing(false)
      setExpanded(true)
      onToast(`参考图“${file.name}”已加入 · 可切换到“摄像机视角”核对导出构图`)
    } catch (error) {
      onToast(error.message || '参考图上传失败')
    } finally {
      input.value = ''
    }
  }
  const beginDrag = event => {
    if (!editing) return
    event.preventDefault()
    event.stopPropagation()
    const bounds = event.currentTarget.parentElement.getBoundingClientRect()
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: reference.x, y: reference.y, width: bounds.width, height: bounds.height }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }
  const moveDrag = event => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    update({
      x: drag.x + (event.clientX - drag.startX) / Math.max(1, drag.width) * 100,
      y: drag.y + (event.clientY - drag.startY) / Math.max(1, drag.height) * 100,
    })
  }
  const endDrag = event => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }
  const hasImage = Boolean(reference.image)
  const referenceLayer = hasImage && reference.visible ? (
    <div className={`reference-layer ${editing ? 'is-editing' : ''}`} aria-label={`参考图 ${reference.name}`}>
      <img
        src={reference.image}
        alt={reference.name || '动作参考图'}
        draggable="false"
        style={{ left: `${50 + reference.x}%`, top: `${50 + reference.y}%`, width: `${72 * reference.scale}%`, opacity: reference.opacity }}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  ) : null
  return (
    <>
      <div className={`reference-panel floating-panel ${hasImage ? 'has-image' : ''} ${hasImage && !expanded ? 'is-collapsed' : ''}`}>
        {hasImage && !expanded ? (
          <button type="button" className="reference-expand" title="展开参考图工具" aria-label="展开参考图工具" onClick={() => setExpanded(true)}><FileImage size={13} /><ChevronDown size={11} /></button>
        ) : (
          <>
            <label className="reference-upload reference-upload-label"><input type="file" accept="image/*,.png,.jpg,.jpeg,.webp,.bmp,.gif" onChange={upload} /><FileImage size={13} /> {hasImage ? '更换参考图' : '上传参考图'}</label>
            {hasImage && (
              <>
                <button type="button" className={reference.visible ? 'is-active' : ''} onClick={() => update({ visible: !reference.visible })}>{reference.visible ? '隐藏' : '显示'}</button>
                <button type="button" className={editing ? 'is-active' : ''} onClick={() => { setEditing(value => !value); update({ visible: true }) }}><Move3D size={12} /> {editing ? '锁定' : '移动图'}</button>
                <button type="button" title="移除参考图" aria-label="移除参考图" onClick={() => { onChange(cloneProjectValue(DEFAULT_REFERENCE)); setEditing(false); setExpanded(true) }}><Trash2 size={12} /></button>
                <label><span>透明</span><input aria-label="参考图透明度" type="range" min="0.1" max="1" step="0.05" value={reference.opacity} onChange={event => update({ opacity: Number(event.target.value) })} /></label>
                <label><span>大小</span><input aria-label="参考图大小" type="range" min="0.25" max="2" step="0.05" value={reference.scale} onChange={event => update({ scale: Number(event.target.value) })} /></label>
                <label className="reference-export-toggle"><input aria-label="参考图随 PNG 和 MP4 导出" type="checkbox" checked={reference.includeInExport} onChange={event => update({ includeInExport: event.target.checked })} /><span>进入导出</span></label>
                <button type="button" onClick={() => update({ x: 0, y: 0, scale: 1 })}>居中</button>
                <button type="button" title="收起参考图工具" aria-label="收起参考图工具" onClick={() => { setExpanded(false); setEditing(false) }}><ChevronUp size={12} /></button>
              </>
            )}
          </>
        )}
      </div>
      {cameraMode ? (
        <div className="camera-edit-frame">
          <div className="camera-edit-stage" style={{ aspectRatio: cameraAspect, '--camera-aspect': cameraAspect }}>
            {referenceLayer}
            {children}
          </div>
        </div>
      ) : <>{referenceLayer}{children}</>}
    </>
  )
}

export default function App() {
  const startupProject = useMemo(() => readCachedProject(), [])
  const [settings, setSettings] = useState(() => normalizeProjectSettings(startupProject?.settings))
  const [shots, setShots] = useState(() => startupProject?.shots || [{
    id: 'shot-01', name: '镜头 01', thumbnail: '', fps: DEFAULT_PROJECT_SETTINGS.fps, durationSeconds: DEFAULT_PROJECT_SETTINGS.durationSeconds, loopPlayback: false,
    objects: cloneProjectValue(initialObjects), camera: cloneProjectValue(initialCamera), lighting: cloneProjectValue(DEFAULT_LIGHTING), reference: cloneProjectValue(DEFAULT_REFERENCE), keyframes: [], objectKeyframes: {},
  }])
  const [activeShotId, setActiveShotId] = useState(() => startupProject?.activeShotId || 'shot-01')
  const [objects, setObjects] = useState(() => startupProject?.objects || initialObjects)
  const [selectedId, setSelectedId] = useState(() => startupProject?.objects?.[0]?.id || 'actor-lead')
  const [selectedJoint, setSelectedJoint] = useState('mixamorigSpine2')
  const [transformMode, setTransformMode] = useState('translate')
  const [transformSpace, setTransformSpace] = useState('world')
  const [snapEnabled, setSnapEnabled] = useState(true)
  const [groundRequest, setGroundRequest] = useState(null)
  const [camera, setCamera] = useState(() => ({ ...initialCamera, ...(startupProject?.camera || {}) }))
  const [lighting, setLighting] = useState(() => normalizeLighting(startupProject?.lighting))
  const [reference, setReference] = useState(() => normalizeReference(startupProject?.reference))
  const [keyframes, setKeyframes] = useState(() => startupProject?.keyframes || initialKeyframes)
  const [characterKeyframes, setCharacterKeyframes] = useState(() => startupProject?.objectKeyframes || startupProject?.characterKeyframes || initialCharacterKeyframes)
  const [routeTracks, setRouteTracks] = useState(() => startupProject?.routeTracks || {})
  const [routeEditMode, setRouteEditMode] = useState(false)
  const [routeEditPoints, setRouteEditPoints] = useState([])
  const [objectDrafts, setObjectDrafts] = useState({})
  const [currentFrame, setCurrentFrame] = useState(0)
  const [selectedKeyframe, setSelectedKeyframe] = useState(null)
  const [keyframeClipboard, setKeyframeClipboard] = useState(null)
  const [customPoses, setCustomPoses] = useState(() => readCustomPoses())
  const [playing, setPlaying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [capturingImage, setCapturingImage] = useState(false)
  const [exportReferenceBackground, setExportReferenceBackground] = useState(null)
  const [monitorReferenceBackground, setMonitorReferenceBackground] = useState(null)
  const [exportProgress, setExportProgress] = useState(0)
  const [showGrid, setShowGrid] = useState(true)
  const [cameraView, setCameraView] = useState(false)
  const [lightingPanelOpen, setLightingPanelOpen] = useState(false)
  const [cameraAnglePanelOpen, setCameraAnglePanelOpen] = useState(false)
  const [viewOptionsCollapsed, setViewOptionsCollapsed] = useState(false)
  const [monitorMode, setMonitorMode] = useState('normal')
  const [editorView, setEditorView] = useState({ position: [8.5, 6.4, 9.5], target: [0, 1, 0] })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [viewFocusRequest, setViewFocusRequest] = useState(null)
  const [toast, setToast] = useState('')
  const [sceneReferenceImage, setSceneReferenceImage] = useState('')
  const [rightTab, setRightTab] = useState('inspector')
  const [drawRoute, setDrawRoute] = useState(false)
  useEffect(() => {if(drawRoute){setTransformMode('select');setLightingPanelOpen(false);setCameraAnglePanelOpen(false);setPlaying(false)}},[drawRoute])
  const [routeEndSecond, setRouteEndSecond] = useState(5)
  const [routeLoopMotion, setRouteLoopMotion] = useState(true)
  const [routeNotice, setRouteNotice] = useState('')
  useEffect(() => () => { if (sceneReferenceImage) URL.revokeObjectURL(sceneReferenceImage) }, [sceneReferenceImage])
  const [saveStatus, setSaveStatus] = useState(startupProject ? '已恢复自动保存' : '自动保存已开启')
  const [, setHistoryVersion] = useState(0)
  const loadRef = useRef(null)
  const playStartRef = useRef(null)
  const currentFrameRef = useRef(0)
  const exportCanvasRef = useRef(null)
  const imageCaptureCanvasRef = useRef(null)
  const monitorCanvasRef = useRef(null)
  const editorViewRef = useRef(editorView)
  const exportLockRef = useRef(false)
  const historyRef = useRef({ past: [], future: [], last: '', timer: null, restoring: false })
  const latestProjectRef = useRef(null)
  const objectsRef = useRef(objects)
  const sceneContextSourceRef = useRef({})

  const fps = settings.fps
  const totalFrames = fps * settings.durationSeconds

  const selected = useMemo(() => selectedId === CAMERA_ID ? { id: CAMERA_ID } : objects.find(object => object.id === selectedId), [objects, selectedId])
  const activeObject = useMemo(() => selected?.id && selected.id !== CAMERA_ID ? selected : null, [selected])
  const activeShot = useMemo(() => shots.find(shot => shot.id === activeShotId) || shots[0], [activeShotId, shots])
  const displayedShots = useMemo(() => shots.map(shot => shot.id === activeShotId ? {
    ...shot,
    fps: settings.fps,
    durationSeconds: settings.durationSeconds,
    loopPlayback: settings.loopPlayback,
    objects,
    camera,
    lighting,
    reference,
    keyframes,
    objectKeyframes: characterKeyframes,
    routeTracks,
  } : shot), [activeShotId, camera, characterKeyframes, keyframes, lighting, objects, reference, routeTracks, settings.durationSeconds, settings.fps, settings.loopPlayback, shots])
  const maxKeyframeFrame = useMemo(() => keyframeMaxFrame(keyframes, characterKeyframes), [characterKeyframes, keyframes])
  const selectedKeyframeInfo = useMemo(() => {
    if (!selectedKeyframe) return null
    const track = selectedKeyframe.kind === 'camera' ? keyframes : characterKeyframes[selectedKeyframe.trackId]
    const key = track?.find(item => item.frame === selectedKeyframe.frame)
    return key ? { ...selectedKeyframe, interpolation: normalizeInterpolation(key.interpolation) } : null
  }, [characterKeyframes, keyframes, selectedKeyframe])
  const hasObjectAnimation = useMemo(() => Object.values(characterKeyframes).some(track => track?.length), [characterKeyframes])
  const isAnimating = playing || exporting
  const animatedObjects = useMemo(() => {
    const framedObjects = hasObjectAnimation ? objectsAtFrame(objects, characterKeyframes, currentFrame, fps) : objects
    return framedObjects.map(object => objectDrafts[object.id] || object)
  }, [hasObjectAnimation, objects, characterKeyframes, currentFrame, fps, objectDrafts])
  const animatedCamera = useMemo(() => {
    const base = keyframes.length ? cameraAtFrame(keyframes, currentFrame, camera.aspectRatio, camera) : camera
    const keyFollow = base.followEnabled === true ? {
      enabled: true,
      targetId: base.followTargetId,
      shot: base.followShot || base.shot || 'medium',
      distance: base.followDistance ?? shotPreset(base.followShot || base.shot || 'medium').distance,
      height: base.followHeight ?? shotPreset(base.followShot || base.shot || 'medium').height,
      lookHeight: base.followLookHeight ?? shotPreset(base.followShot || base.shot || 'medium').lookHeight,
      offset: base.followOffset || [0, base.followHeight ?? 2.8, base.followDistance ?? 5.2],
      focalLength: base.focalLength,
    } : null
    const follow = followAtCameraKeyframe(camera.follow || keyFollow, base)
    if (!follow?.enabled || !follow.targetId) return { ...base, follow }
    const target = animatedObjects.find(object => object.id === follow.targetId)
    if (!target) return { ...base, follow }
    const frameFollow = { ...follow, shot: base.shot || follow.shot }
    return { ...base, ...solveFollowCamera(target, base, frameFollow), follow }
  }, [keyframes, currentFrame, camera, animatedObjects])
  const inspectorSelected = useMemo(() => selectedId === CAMERA_ID ? selected : animatedObjects.find(object => object.id === selectedId), [animatedObjects, selected, selectedId])
  const displayCamera = animatedCamera.follow?.enabled || isAnimating ? animatedCamera : camera
  const updateCameraFromUI = useCallback(patch => {
    setCamera(current => {
      if (patch?.follow === null && animatedCamera?.position?.length === 3) {
        return { ...current, position: [...animatedCamera.position], rotation: [...animatedCamera.rotation], focalLength: animatedCamera.focalLength, ...patch }
      }
      return { ...current, ...patch }
    })
  }, [animatedCamera])
  const previewAspect = aspectValue(displayCamera.aspectRatio)
  const previewAspectClass = previewAspect >= 16 / 9 ? 'is-wide' : 'is-tall'
  const exportDimensions = useMemo(() => exportDimensionsForAspect(camera.aspectRatio), [camera.aspectRatio])
  const currentProject = useMemo(() => projectData({
    settings,
    objects,
    camera,
    lighting,
    reference,
    keyframes,
    objectKeyframes: characterKeyframes,
    routeTracks,
    shots,
    activeShotId,
  }), [settings, objects, camera, lighting, reference, keyframes, characterKeyframes, routeTracks, shots, activeShotId])

  useEffect(() => {
    currentFrameRef.current = currentFrame
  }, [currentFrame])

  useEffect(() => {
    objectsRef.current = objects
  }, [objects])

  useEffect(() => {
    sceneContextSourceRef.current = {
      objects,
      camera,
      keyframes,
      objectKeyframes: characterKeyframes,
      routeTracks,
      customPoses,
      shots,
      activeShotName: activeShot?.name || '',
      activeShotId,
      currentFrame,
      fps,
      settings,
      selectedId,
    }
  })

  const getSceneContext = useCallback(() => sceneContextSourceRef.current, [])
  // AI tools edit the project through the same setters as the UI. The ref is
  // updated synchronously as well, so several tool calls in one assistant turn
  // see each other's writes before React commits the next render.
  const applyAgentScenePatch = useCallback((patch, summary) => {
    if (!patch || typeof patch !== 'object') return
    const source = sceneContextSourceRef.current
    const nextSource = { ...source }
    if (Array.isArray(patch.objects)) {
      nextSource.objects = patch.objects
      objectsRef.current = patch.objects
      setObjects(patch.objects)
      setObjectDrafts(() => ({}))
    }
    if (patch.camera && typeof patch.camera === 'object') {
      nextSource.camera = patch.camera
      setCamera(patch.camera)
    }
    if (Array.isArray(patch.keyframes)) {
      nextSource.keyframes = patch.keyframes
      setKeyframes(patch.keyframes)
    }
    if (patch.objectKeyframes && typeof patch.objectKeyframes === 'object') {
      nextSource.objectKeyframes = patch.objectKeyframes
      setCharacterKeyframes(patch.objectKeyframes)
    }
    if (patch.settings && typeof patch.settings === 'object') {
      const settingsNext = normalizeProjectSettings(patch.settings)
      nextSource.settings = settingsNext
      nextSource.fps = settingsNext.fps
      setSettings(settingsNext)
      setShots(list => list.map(shot => shot.id === source.activeShotId
        ? { ...shot, fps: settingsNext.fps, durationSeconds: settingsNext.durationSeconds, loopPlayback: settingsNext.loopPlayback }
        : shot))
    }
    if (patch.selectedId) {
      nextSource.selectedId = patch.selectedId
      setSelectedId(patch.selectedId)
    }
    if (Number.isFinite(Number(patch.currentFrame))) {
      const nextFrame = clamp(Math.round(Number(patch.currentFrame)), 0, (nextSource.settings?.fps || fps) * (nextSource.settings?.durationSeconds || settings.durationSeconds))
      nextSource.currentFrame = nextFrame
      currentFrameRef.current = nextFrame
      setCurrentFrame(nextFrame)
    }
    sceneContextSourceRef.current = nextSource
    if (summary?.message) setToast(summary.message)
  }, [fps, settings.durationSeconds])
  const agentSceneToolkit = useMemo(() => ({
    snapshot: () => sceneContextSourceRef.current,
    applyScenePatch: (patch, summary) => applyAgentScenePatch(patch, summary),
  }), [applyAgentScenePatch])
  const selectInspector = useCallback(id => {
    setSelectedId(id)
    setRightTab('inspector')
  }, [])

  useEffect(() => {
    let active = true
    if (!reference.image || !reference.includeInExport) {
      setMonitorReferenceBackground(null)
      return () => { active = false }
    }
    referenceCanvasForExport(reference, exportDimensions.width, exportDimensions.height)
      .then(canvas => { if (active) setMonitorReferenceBackground(canvas) })
      .catch(() => { if (active) setMonitorReferenceBackground(null) })
    return () => { active = false }
  }, [exportDimensions.height, exportDimensions.width, reference])

  useEffect(() => {
    try { localStorage.setItem(CUSTOM_POSE_STORAGE_KEY, JSON.stringify(customPoses)) } catch { /* 姿势库写入失败时不影响工程编辑 */ }
  }, [customPoses])

  useEffect(() => {
    if (selectedKeyframe?.kind === 'object' && selectedKeyframe.trackId !== selectedId) setSelectedKeyframe(null)
  }, [selectedId, selectedKeyframe])

  useEffect(() => {
    latestProjectRef.current = currentProject
    const history = historyRef.current
    if (!history.last) {
      history.last = currentProject
      return
    }
    if (history.restoring) {
      history.restoring = false
      history.last = currentProject
      return
    }
    clearTimeout(history.timer)
    const previous = history.last
    history.timer = setTimeout(() => {
      if (latestProjectRef.current === previous) return
      history.past.push(previous)
      if (history.past.length > 50) history.past.shift()
      history.last = latestProjectRef.current
      history.future = []
      setHistoryVersion(version => version + 1)
    }, 280)
    return () => clearTimeout(history.timer)
  }, [currentProject])

  useEffect(() => {
    setSaveStatus('保存中…')
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(currentProject))
        setSaveStatus('已自动保存')
      } catch {
        setSaveStatus('自动保存空间不足')
      }
    }, 900)
    return () => clearTimeout(timer)
  }, [currentProject])

  const applyProjectSnapshot = useCallback(snapshot => {
    const normalized = normalizeProjectData(snapshot)
    if (!normalized) return
    setSettings(normalized.settings)
    setShots(normalized.shots)
    setActiveShotId(normalized.activeShotId)
    setObjects(normalized.objects)
    setCamera(normalized.camera)
    setLighting(normalized.lighting)
    setReference(normalized.reference)
    setKeyframes(normalized.keyframes)
    setCharacterKeyframes(normalized.objectKeyframes)
    setRouteTracks(normalized.routeTracks || {})
    setRouteEditMode(false)
    setObjectDrafts({})
    setSelectedKeyframe(null)
    setPlaying(false)
    setCurrentFrame(frame => {
      const nextFrame = clamp(frame, 0, normalized.settings.fps * normalized.settings.durationSeconds)
      currentFrameRef.current = nextFrame
      return nextFrame
    })
    setSelectedId(current => current === CAMERA_ID || normalized.objects.some(object => object.id === current) ? current : normalized.objects[0]?.id || CAMERA_ID)
  }, [])

  const flushHistory = useCallback(() => {
    const history = historyRef.current
    clearTimeout(history.timer)
    const latest = latestProjectRef.current
    if (history.last && latest && latest !== history.last) {
      history.past.push(history.last)
      if (history.past.length > 50) history.past.shift()
      history.last = latest
      history.future = []
    }
  }, [])

  const undo = useCallback(() => {
    flushHistory()
    const history = historyRef.current
    const previous = history.past.pop()
    if (!previous) return
    history.future.push(history.last)
    history.last = previous
    history.restoring = true
    applyProjectSnapshot(previous)
    setHistoryVersion(version => version + 1)
    setToast('已撤销')
  }, [applyProjectSnapshot, flushHistory])

  const redo = useCallback(() => {
    const history = historyRef.current
    const next = history.future.pop()
    if (!next) return
    history.past.push(history.last)
    history.last = next
    history.restoring = true
    applyProjectSnapshot(next)
    setHistoryVersion(version => version + 1)
    setToast('已重做')
  }, [applyProjectSnapshot])

  const focusSelected = useCallback(() => {
    if (selectedId === CAMERA_ID) {
      setViewFocusRequest({ position: [...displayCamera.position], height: 0, distance: 4, nonce: Date.now() })
      return
    }
    const object = animatedObjects.find(item => item.id === selectedId)
    if (!object) return
    const maxScale = Math.max(...(object.scale || [1, 1, 1]).map(value => Math.abs(value) || 1))
    setViewFocusRequest({
      position: visualCenterForObject(object),
      height: 0,
      distance: clamp(maxScale * 4.5, 2.8, 14),
      nonce: Date.now(),
    })
  }, [animatedObjects, displayCamera.position, selectedId])

  const seekToFrame = useCallback(frame => {
    const nextFrame = clamp(Math.round(frame), 0, totalFrames)
    setPlaying(false)
    setObjectDrafts({})
    setCurrentFrame(nextFrame)
    currentFrameRef.current = nextFrame
    if (keyframes.length) setCamera(current => cameraAtFrame(keyframes, nextFrame, current.aspectRatio, current))
  }, [keyframes, totalFrames])

  const togglePlayback = useCallback(() => {
    setPlaying(wasPlaying => {
      if (wasPlaying) {
        const pausedFrame = currentFrameRef.current
        if (keyframes.length) setCamera(current => cameraAtFrame(keyframes, pausedFrame, current.aspectRatio, current))
      }
      if (!wasPlaying && currentFrameRef.current >= totalFrames) {
        setCurrentFrame(0)
        currentFrameRef.current = 0
        if (keyframes.length) setCamera(current => cameraAtFrame(keyframes, 0, current.aspectRatio, current))
      }
      if (!wasPlaying) setObjectDrafts({})
      return !wasPlaying
    })
  }, [keyframes, totalFrames])

  useEffect(() => {
    if (!playing) { playStartRef.current = null; return }
    let frameId
    const animate = timestamp => {
      if (playStartRef.current === null) playStartRef.current = timestamp - currentFrameRef.current / fps * 1000
      let frame = Math.floor((timestamp - playStartRef.current) / 1000 * fps)
      if (frame >= totalFrames) {
        if (settings.loopPlayback) {
          frame %= totalFrames
          playStartRef.current = timestamp - frame / fps * 1000
        } else {
          setCurrentFrame(totalFrames)
          currentFrameRef.current = totalFrames
          if (keyframes.length) setCamera(current => cameraAtFrame(keyframes, totalFrames, current.aspectRatio, current))
          setPlaying(false)
          return
        }
      }
      setCurrentFrame(frame)
      currentFrameRef.current = frame
      frameId = requestAnimationFrame(animate)
    }
    frameId = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frameId)
  }, [playing, keyframes, fps, totalFrames, settings.loopPlayback])

  useEffect(() => {
    const onKeyDown = event => {
      if (drawRoute) {
        if (event.key === 'Escape') { event.preventDefault(); setDrawRoute(false) }
        return
      }
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
      if (event.key.toLowerCase() === 'w') setTransformMode('translate')
      if (event.key.toLowerCase() === 'e') setTransformMode('rotate')
      if (event.key.toLowerCase() === 'r') setTransformMode('scale')
      if (event.key.toLowerCase() === 'f') focusSelected()
      if (event.code === 'Space') { event.preventDefault(); togglePlayback() }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId !== CAMERA_ID) deleteSelected()
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected() }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z') { event.preventDefault(); undo() }
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) { event.preventDefault(); redo() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedId, objects, togglePlayback, undo, redo, focusSelected, drawRoute])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(timer)
  }, [toast])

  const applySettings = nextSettings => {
    const next = normalizeProjectSettings(nextSettings)
    const nextTotalFrames = next.fps * next.durationSeconds
    const lastKeyframeFrame = normalizeFrameNumber(maxKeyframeFrame)
    if (nextTotalFrames < lastKeyframeFrame) {
      const requiredSeconds = Math.max(1, Math.ceil(lastKeyframeFrame / next.fps))
      setToast(`最后关键帧在第 ${lastKeyframeFrame} 帧，时长至少 ${requiredSeconds} 秒`)
      return
    }
    setPlaying(false)
    setSettings(next)
    setShots(list => list.map(shot => shot.id === activeShotId ? { ...shot, fps: next.fps, durationSeconds: next.durationSeconds, loopPlayback: next.loopPlayback } : shot))
    setCurrentFrame(frame => {
      const nextFrame = clamp(frame, 0, nextTotalFrames)
      currentFrameRef.current = nextFrame
      return nextFrame
    })
    setSettingsOpen(false)
    setToast(`时间轴已更新 · ${next.fps} FPS · ${next.durationSeconds} 秒`)
  }

  const thumbnailFromMonitor = () => {
    const source = monitorCanvasRef.current
    if (!source?.width || !source?.height) return ''
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 240
      canvas.height = 135
      const context = canvas.getContext('2d')
      context.fillStyle = '#11110f'
      context.fillRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(canvas.width / source.width, canvas.height / source.height)
      const width = source.width * scale
      const height = source.height * scale
      context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      return canvas.toDataURL('image/jpeg', 0.74)
    } catch {
      return ''
    }
  }

  const liveShotRecord = (shot, thumbnail = shot?.thumbnail || '') => ({
    ...shot,
    id: shot?.id || activeShotId,
    name: shot?.name || '镜头',
    thumbnail,
    fps: settings.fps,
    durationSeconds: settings.durationSeconds,
    loopPlayback: settings.loopPlayback,
    objects,
    camera,
    lighting,
    reference,
    keyframes,
    objectKeyframes: characterKeyframes,
    routeTracks,
  })

  const applyShotState = shot => {
    setPlaying(false)
    setObjectDrafts({})
    setSelectedKeyframe(null)
    setKeyframeClipboard(null)
    setSettings(current => ({ ...current, fps: shot.fps, durationSeconds: shot.durationSeconds, loopPlayback: shot.loopPlayback }))
    setObjects(cloneProjectValue(shot.objects))
    setCamera(cloneProjectValue(shot.camera))
    setLighting(normalizeLighting(shot.lighting))
    setReference(normalizeReference(shot.reference))
    setKeyframes(cloneProjectValue(shot.keyframes || []))
    setCharacterKeyframes(cloneProjectValue(shot.objectKeyframes || {}))
    setRouteTracks(cloneProjectValue(shot.routeTracks || {}))
    setRouteEditMode(false)
    setRouteEditPoints([])
    setCurrentFrame(0)
    currentFrameRef.current = 0
    setActiveShotId(shot.id)
    setSelectedId(shot.objects?.[0]?.id || CAMERA_ID)
  }

  const switchShot = shotId => {
    if (shotId === activeShotId) return
    const target = shots.find(shot => shot.id === shotId)
    if (!target) return
    const thumbnail = thumbnailFromMonitor()
    setShots(list => list.map(shot => shot.id === activeShotId ? liveShotRecord(shot, thumbnail || shot.thumbnail) : shot))
    applyShotState(target)
    setToast(`已切换到“${target.name}”`)
  }

  const addShot = () => {
    if (shots.length >= 30) { setToast('每个工程最多 30 个镜头'); return }
    const thumbnail = thumbnailFromMonitor()
    const id = `shot-${uid()}`
    const nextShot = {
      id,
      name: uniqueShotName(shots, defaultShotName(shots.length)),
      thumbnail,
      fps: settings.fps,
      durationSeconds: settings.durationSeconds,
      loopPlayback: settings.loopPlayback,
      objects: cloneProjectValue(objects),
      camera: cloneProjectValue(camera),
      lighting: cloneProjectValue(lighting),
      reference: cloneProjectValue(DEFAULT_REFERENCE),
      keyframes: [],
      objectKeyframes: {},
      routeTracks: {},
    }
    setShots(list => [...list.map(shot => shot.id === activeShotId ? liveShotRecord(shot, thumbnail || shot.thumbnail) : shot), nextShot])
    applyShotState(nextShot)
    setToast(`已新建“${nextShot.name}” · 场景已复制，关键帧和参考图为空`)
  }

  const duplicateShot = shotId => {
    if (shots.length >= 30) { setToast('每个工程最多 30 个镜头'); return }
    const thumbnail = thumbnailFromMonitor()
    const storedSource = shots.find(shot => shot.id === shotId)
    if (!storedSource) return
    const source = shotId === activeShotId ? liveShotRecord(storedSource, thumbnail || storedSource.thumbnail) : storedSource
    const duplicate = cloneProjectValue({ ...source, id: `shot-${uid()}`, name: uniqueShotName(shots, `${source.name} 副本`) })
    setShots(list => {
      const persisted = list.map(shot => shot.id === activeShotId ? liveShotRecord(shot, thumbnail || shot.thumbnail) : shot)
      const sourceIndex = persisted.findIndex(shot => shot.id === shotId)
      return [...persisted.slice(0, sourceIndex + 1), duplicate, ...persisted.slice(sourceIndex + 1)]
    })
    applyShotState(duplicate)
    setToast(`已复制“${source.name}”`)
  }

  const deleteShot = shotId => {
    if (shots.length <= 1) return
    const sourceIndex = shots.findIndex(shot => shot.id === shotId)
    const source = shots[sourceIndex]
    if (!source || !window.confirm(`删除镜头“${source.name}”？`)) return
    const thumbnail = thumbnailFromMonitor()
    const persisted = shots.map(shot => shot.id === activeShotId ? liveShotRecord(shot, thumbnail || shot.thumbnail) : shot)
    const remaining = persisted.filter(shot => shot.id !== shotId)
    setShots(remaining)
    if (shotId === activeShotId) applyShotState(remaining[Math.min(sourceIndex, remaining.length - 1)])
    setToast(`已删除“${source.name}”`)
  }

  const renameShot = (shotId, name, commit = false) => setShots(list => {
    const index = list.findIndex(shot => shot.id === shotId)
    if (index < 0) return list
    const draft = String(name || '').slice(0, 30)
    const nextName = commit ? (draft.trim() || defaultShotName(index)) : draft
    return list.map(shot => shot.id === shotId ? { ...shot, name: nextName } : shot)
  })

  const captureShotThumbnail = shotId => {
    if (shotId !== activeShotId) { setToast('请先切换到该镜头再更新缩略图'); return }
    const thumbnail = thumbnailFromMonitor()
    if (!thumbnail) { setToast('摄像机画面尚未准备好，请稍后重试'); return }
    setShots(list => list.map(shot => shot.id === shotId ? { ...shot, thumbnail } : shot))
    setToast('镜头缩略图已更新')
  }

  const addPerson = bodyType => {
    const id = uid()
    const person = { id, name: `${bodyType === 'minimal' ? '极简模型' : '人物'} · ${objects.filter(item => item.type === 'person').length + 1}`, type: 'person', bodyType, pose: 'idle', poseTime: presetPhase('idle'), joints: presetJoints(), rigRoot: [0, 0, 0], footLock: false, continuousMotion: false, faceText: '', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#e8e3d8' }
    setObjects(list => [...list, person])
    setSelectedId(id)
  }
  const addPrimitive = type => {
    const id = uid()
    const labels = { box: '方块', sphere: '球体', cylinder: '圆柱', plane: '平面', arch: '拱门', stairs: '楼梯', table: '桌子', chair: '椅子', sofa: '沙发', door: '门', window: '窗', tree: '树木', vehicle: '车辆', roof: '屋顶' }
    const defaultScales = { arch: [1.8, 2.2, 0.45], stairs: [2.2, 1.4, 2.8], door: [1.2, 2.2, 0.25], window: [1.5, 1.3, 0.22], table: [1.7, 1, 1.1], chair: [0.8, 1, 0.8], sofa: [2.2, 1.1, 1], tree: [1.8, 2.6, 1.8], vehicle: [2.8, 1.2, 1.6], roof: [2.8, 1.2, 2.2] }
    const positionY = type === 'plane' ? 0.02 : (type === 'tree' ? 1.3 : 0.5)
    setObjects(list => [...list, { id, name: `${labels[type] || type} · ${list.filter(item => item.type === type).length + 1}`, type, position: [0, positionY, 0], rotation: [0, 0, 0], scale: type === 'plane' ? [2, 1, 2] : (defaultScales[type] || [1, 1, 1]), color: type === 'tree' ? '#9ca68d' : '#c7c2b7' }])
    setSelectedId(id)
  }
  const importModel = event => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const id = uid()
      setObjects(list => [...list, { id, name: file.name.replace(/\.(glb|gltf)$/i, ''), type: 'model', url: reader.result, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#ddd8cc' }])
      setSelectedId(id)
      setToast('模型已加入场景')
    }
    reader.readAsDataURL(file)
    event.target.value = ''
  }
  const applySceneFromTool = useCallback((result, attachment) => {
    const mapped = sceneToMonoform(result.scene, objectsRef.current.map(item => item.id), `scene-${uid()}`)
    if (!mapped.objects.length) throw new Error('模型返回了场景，但没有可导入的有效体块；请换一张图或补充更明确的空间描述')
    objectsRef.current = [...objectsRef.current, ...mapped.objects]
    setObjects(list => [...list, ...mapped.objects])
    if (mapped.camera) {
      setCamera(normalizeCamera(mapped.camera))
      setEditorView({ position: [...mapped.camera.position], target: [...mapped.camera.target] })
    }
    setSelectedId(mapped.objects[0].id)
    if (attachment?.file) {
      setSceneReferenceImage(current => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(attachment.file) })
    }
    const report = `新增 ${mapped.objects.length} 个独立体块 · ${mapped.evidence.length} 组结构证据${result.warnings?.length ? ` · ${result.warnings.length} 条待核对` : ''}`
    setToast(report)
    return {
      added: mapped.objects.length,
      evidence: mapped.evidence.length,
      warnings: Array.isArray(result.warnings) ? result.warnings.length : 0,
      message: report,
    }
  }, [])
  const updateObjectById = (id, patch) => {
    setObjectDrafts(drafts => {
      if (!characterKeyframes[id]?.length) {
        if (!(id in drafts)) return drafts
        const next = { ...drafts }
        delete next[id]
        return next
      }
      const source = drafts[id] || objectAtFrame(objects.find(object => object.id === id), characterKeyframes[id], currentFrame, fps)
      return source ? { ...drafts, [id]: { ...source, ...patch } } : drafts
    })
    setObjects(list => list.map(object => object.id === id ? { ...object, ...patch } : object))
  }
  const clearCanvas = () => {
    if (!objects.length) return
    if (!window.confirm(`确定清空画布中的 ${objects.length} 个对象？主摄像机和镜头关键帧会保留。`)) return
    setObjects([])
    setCharacterKeyframes({})
    setRouteTracks({})
    setObjectDrafts({})
    setCamera(current => ({ ...current, follow: null }))
    setKeyframes(keys => keys.map(key => ({ ...key, followEnabled: false, followTargetId: '', followShot: null, followDistance: null, followHeight: null, followLookHeight: null, followOffset: null, followOrbitDegrees: null, followSideOffset: null })))
    setSelectedId(CAMERA_ID)
    setSelectedKeyframe(null)
    setDrawRoute(false)
    setRouteEditMode(false)
    setRouteEditPoints([])
    setToast(`已清空画布 · 删除 ${objects.length} 个对象`)
  }
  const updateSelected = patch => updateObjectById(selectedId, patch)
  const groundSelected = () => {
    if (!activeObject || activeObject.locked) return
    if (normalizeAxisLocks(activeObject.positionAxisLocks)[1]) { setToast('Y 轴已锁定，请先解锁'); return }
    setGroundRequest({ id: activeObject.id, nonce: Date.now() })
    setToast('已按模型最低点落到地面')
  }
  const resetSelectedPosition = () => {
    if (selectedId === CAMERA_ID) {
      const locks = normalizeAxisLocks(camera.positionAxisLocks)
      if (locks.every(Boolean)) { setToast('摄像机位置轴已全部锁定'); return }
      updateCameraFromUI({ position: resetVectorPreservingLocks(DEFAULT_CAMERA_POSITION, camera.position, locks) })
      setToast(locks.some(Boolean) ? '摄像机机位已复位 · 锁定轴保持' : '摄像机已恢复默认机位')
      return
    }
    if (!activeObject || activeObject.locked) return
    const currentObject = animatedObjects.find(object => object.id === selectedId) || activeObject
    const locks = normalizeAxisLocks(currentObject.positionAxisLocks)
    if (locks.every(Boolean)) { setToast('位置轴已全部锁定'); return }
    updateSelected({ position: resetVectorPreservingLocks([0, 0, 0], currentObject.position, locks) })
    setToast(locks.some(Boolean) ? '位置已归零 · 锁定轴保持' : '位置已归零')
  }
  const resetSelectedRotation = () => {
    if (selectedId === CAMERA_ID) {
      const locks = normalizeAxisLocks(camera.rotationAxisLocks)
      if (locks.every(Boolean)) { setToast('摄像机旋转轴已全部锁定'); return }
      updateCameraFromUI({ rotation: resetVectorPreservingLocks(DEFAULT_CAMERA_ROTATION, camera.rotation, locks) })
      setToast(locks.some(Boolean) ? '摄像机旋转已复位 · 锁定轴保持' : '摄像机已恢复默认朝向')
      return
    }
    if (!activeObject || activeObject.locked) return
    const currentObject = animatedObjects.find(object => object.id === selectedId) || activeObject
    const locks = normalizeAxisLocks(currentObject.rotationAxisLocks)
    if (locks.every(Boolean)) { setToast('旋转轴已全部锁定'); return }
    updateSelected({ rotation: resetVectorPreservingLocks([0, 0, 0], currentObject.rotation, locks) })
    setToast(locks.some(Boolean) ? '旋转已归零 · 锁定轴保持' : (activeObject.type === 'person' ? '整体旋转已归零' : '旋转已归零'))
  }
  const resetSelectedScale = () => {
    if (!activeObject || activeObject.locked) return
    const currentObject = animatedObjects.find(object => object.id === selectedId) || activeObject
    const locks = normalizeAxisLocks(currentObject.scaleAxisLocks)
    if (locks.every(Boolean)) { setToast('缩放轴已全部锁定'); return }
    updateSelected({ scale: resetVectorPreservingLocks([1, 1, 1], currentObject.scale, locks) })
    setToast(locks.some(Boolean) ? '缩放已归一 · 锁定轴保持' : '整体缩放已恢复为 1')
  }
  const captureEditorView = useCallback(view => {
    if (view?.position?.length === 3 && view?.rotation?.length === 3 && view?.target?.length === 3) editorViewRef.current = view
  }, [])
  const openCameraView = () => {
    setEditorView(cloneProjectValue(editorViewRef.current))
    setCameraView(true)
  }
  const openEditorView = () => {
    setCameraView(false)
    setCameraAnglePanelOpen(false)
  }
  const levelCameraHorizon = () => {
    if (normalizeAxisLocks(camera.rotationAxisLocks)[2]) { setToast('翻滚轴已锁定，请先解锁'); return }
    setCamera(current => {
      const rotation = Array.isArray(current.rotation) ? [...current.rotation] : [0, 0, 0]
      rotation[2] = 0
      return { ...current, rotation }
    })
    setToast('摄像机翻滚已归零 · 地面水平线已校正')
  }
  const collapseViewOptions = () => {
    setViewOptionsCollapsed(true)
    setLightingPanelOpen(false)
    setCameraAnglePanelOpen(false)
  }
  const saveCustomPose = person => {
    if (!person || person.type !== 'person') return
    const suggestedName = `自定义姿势 ${customPoses.length + 1}`
    const name = window.prompt('为当前姿势命名', suggestedName)?.trim()
    if (!name) return
    const rig = poseForObject(person)
    setCustomPoses(list => [...list, {
      id: uid(),
      name,
      pose: normalizePoseId(person.pose),
      poseTime: Number.isFinite(person.poseTime) ? person.poseTime : presetPhase(person.pose),
      rigRoot: [...rig.root],
      joints: cloneJointPose(rig.joints),
    }])
    setToast(`姿势“${name}”已保存到本机`)
  }
  const applyCustomPose = customPose => {
    if (!customPose || !activeObject || activeObject.type !== 'person') return
    updateSelected({
      pose: normalizePoseId(customPose.pose),
      poseTime: Number.isFinite(customPose.poseTime) ? customPose.poseTime : presetPhase(customPose.pose),
      rigRoot: [...(customPose.rigRoot || presetRoot(customPose.pose))],
      joints: cloneJointPose(customPose.joints),
    })
    setToast(`已应用姿势“${customPose.name}”`)
  }
  const deleteCustomPose = poseId => {
    const pose = customPoses.find(item => item.id === poseId)
    if (!pose || !window.confirm(`删除姿势“${pose.name}”？`)) return
    setCustomPoses(list => list.filter(item => item.id !== poseId))
    setToast(`已删除姿势“${pose.name}”`)
  }
  const deleteSelected = () => {
    if (selectedId === CAMERA_ID) return
    const source = objects.find(object => object.id === selectedId)
    if (source?.locked) { setToast('物体已锁定，请先解除锁定'); return }
    setObjects(list => list.filter(object => object.id !== selectedId))
    setCharacterKeyframes(tracks => {
      const next = { ...tracks }
      delete next[selectedId]
      return next
    })
    setObjectDrafts(drafts => {
      const next = { ...drafts }
      delete next[selectedId]
      return next
    })
    setSelectedId(CAMERA_ID)
  }
  const duplicateSelected = () => {
    const source = objects.find(object => object.id === selectedId)
    if (!source) return
    const id = uid()
    const duplicate = { ...source, id, name: `${source.name} 副本`, position: [source.position[0] + 0.6, source.position[1], source.position[2] + 0.6] }
    setObjects(list => [...list, duplicate])
    setCharacterKeyframes(tracks => {
      const sourceTrack = tracks[source.id]
      if (!sourceTrack?.length) return tracks
      return {
        ...tracks,
        [id]: sourceTrack.map(key => ({ ...key, position: [key.position[0] + 0.6, key.position[1], key.position[2] + 0.6] })),
      }
    })
    setSelectedId(id)
  }
  const addKeyframe = () => {
    const existing = keyframes.find(key => key.frame === currentFrame)
    const next = cameraKeyframeFromCamera(camera, currentFrame, normalizeInterpolation(existing?.interpolation))
    setKeyframes(list => [...list.filter(key => key.frame !== currentFrame), next].sort((a, b) => a.frame - b.frame))
    setSelectedKeyframe({ kind: 'camera', frame: currentFrame, trackId: null })
    setToast(`已记录第 ${currentFrame} 帧`)
  }
  const deleteKeyframe = frame => {
    setKeyframes(list => list.filter(key => key.frame !== frame))
    if (selectedKeyframe?.kind === 'camera' && selectedKeyframe.frame === frame) setSelectedKeyframe(null)
  }
  const startRouteEdit = () => {
    if (activeObject?.type !== 'person') { setToast('请先选中有轨迹的角色'); return }
    const saved = routeTracks[activeObject.id]
    if (!saved) { setToast('该角色还没有可编辑轨迹'); return }
    setRouteEditPoints(saved.points.map(point => [...point]))
    setRouteLoopMotion(saved.loopMotion !== false)
    setCameraView(false);setDrawRoute(true);setRouteEditMode(true)
  }
  const clearRouteForObject = objectId => {
    const route = routeTracks[objectId]
    setRouteTracks(tracks => {
      const next = { ...tracks }
      delete next[objectId]
      return next
    })
    setCharacterKeyframes(tracks => {
      const remaining = removeRouteOwnedKeyframes(tracks[objectId] || [], route || { id: objectId })
      if (remaining.length) return { ...tracks, [objectId]: remaining }
      const next = { ...tracks }
      delete next[objectId]
      return next
    })
    if (activeObject?.id === objectId) {
      setDrawRoute(false)
      setRouteEditMode(false)
      setRouteEditPoints([])
    }
    setToast('已清除当前角色轨迹，手动关键帧已保留')
  }
  const onRouteAction = () => {
    if (drawRoute) { setDrawRoute(false); setRouteEditMode(false); return }
    if (activeObject?.type !== 'person') { setToast('请先选中角色'); return }
    if (routeTracks[activeObject.id]) { startRouteEdit() } else { setCameraView(false); setDrawRoute(true); setRouteEditMode(false) }
  }
  const updateRoutePoint = useCallback((index, point) => {
    if (!routeEditMode || !activeObject) return
    const current = routeTracks[activeObject.id]
    if (!current?.points?.[index]) return
    const points = current.points.map((item, itemIndex) => itemIndex === index ? [...point] : [...item])
    setRouteEditPoints(points)
    const template = { ...objectKeyframeFromObject(activeObject, current.startFrame), continuousMotion: current.loopMotion !== false }
    const keys = pathToKeys(points, current.startFrame, current.endFrame, template).map(key => ({ ...key, source: 'route', routeId: activeObject.id }))
    setRouteTracks(tracks => ({ ...tracks, [activeObject.id]: { ...current, points, keyframes: keys.map(key => key.frame), keyframesOwned: true } }))
    setCharacterKeyframes(tracks => ({ ...tracks, [activeObject.id]: uniqueSortedKeyframes(mergeRouteKeyframes(tracks[activeObject.id] || [], keys, { ...current, keyframesOwned: true })) }))
  }, [routeEditMode, activeObject, routeTracks])
  const finishDrawRoute = points => {
    const actor=objects.find(item=>item.id===selectedId && item.type==='person')
    if(!actor){setRouteNotice('请先选中角色');setDrawRoute(false);return}
    try{
      const saved = routeTracks[actor.id]
      const startFrame = routeEditMode && saved ? saved.startFrame : currentFrame
      const endFrame = routeEditMode && saved ? saved.endFrame : Math.min(totalFrames,Math.max(currentFrame+1,Math.round(Number(routeEndSecond)*fps)))
      const template={...objectKeyframeFromObject(actor,startFrame),continuousMotion:routeLoopMotion}
      const keys=pathToKeys(points,startFrame,endFrame,template).map(key=>({...key,source:'route',routeId:actor.id}))
      const route = { id: actor.id, points: points.map(point => [...point]), startFrame, endFrame, visible: true, loopMotion: routeLoopMotion, keyframes: keys.map(key => key.frame), keyframesOwned: true }
      const saveRoute = { ...route, points: route.points.map(point => [...point]) }
      setRouteTracks(tracks => ({ ...tracks, [actor.id]: saveRoute }))
      setRouteEditPoints(route.points)
      setCharacterKeyframes(tracks=>({ ...tracks,[actor.id]:uniqueSortedKeyframes(mergeRouteKeyframes(tracks[actor.id]||[], keys, { ...(saved || route), keyframesOwned: true })) }))
      setRouteNotice(`已绘制 ${keys.length} 帧 · ${startFrame} → ${endFrame}`)
      setToast(`已为“${actor.name}”生成 ${keys.length} 个轨迹关键帧`)
      setDrawRoute(false)
    }catch(error){setRouteNotice(error.message||'画轨迹失败')}
  }
  const addObjectKeyframe = () => {
    if (!activeObject) return
    const source = objectDrafts[activeObject.id] || activeObject
    const existing = characterKeyframes[activeObject.id]?.find(key => key.frame === currentFrame)
    const next = { ...objectKeyframeFromObject(source, currentFrame), interpolation: normalizeInterpolation(existing?.interpolation), source: 'manual' }
    setCharacterKeyframes(tracks => ({
      ...tracks,
      [activeObject.id]: [...(tracks[activeObject.id] || []).filter(key => key.frame !== currentFrame), next].sort((a, b) => a.frame - b.frame),
    }))
    setSelectedKeyframe({ kind: 'object', frame: currentFrame, trackId: activeObject.id })
    setObjectDrafts(drafts => {
      const nextDrafts = { ...drafts }
      delete nextDrafts[activeObject.id]
      return nextDrafts
    })
    setToast(activeObject.type === 'person' ? `已记录“${activeObject.name}”第 ${currentFrame} 帧角色状态` : `已记录“${activeObject.name}”第 ${currentFrame} 帧`)
  }
  const deleteObjectKeyframe = frame => {
    if (!activeObject) return
    setCharacterKeyframes(tracks => {
      const current = tracks[activeObject.id] || []
      const remaining = current.filter(key => key.frame !== frame)
      if (remaining.length) return { ...tracks, [activeObject.id]: remaining }
      const next = { ...tracks }
      delete next[activeObject.id]
      return next
    })
    if (selectedKeyframe?.kind === 'object' && selectedKeyframe.trackId === activeObject.id && selectedKeyframe.frame === frame) setSelectedKeyframe(null)
  }
  const moveKeyframe = ({ kind, trackId, fromFrame, toFrame }) => {
    const move = list => {
      const source = list.find(key => key.frame === fromFrame)
      if (!source) return list
      return [...list.filter(key => key.frame !== fromFrame && key.frame !== toFrame), { ...source, frame: toFrame }].sort((a, b) => a.frame - b.frame)
    }
    if (kind === 'camera') setKeyframes(move)
    else setCharacterKeyframes(tracks => ({ ...tracks, [trackId]: move(tracks[trackId] || []) }))
    setSelectedKeyframe({ kind, trackId, frame: toFrame })
    seekToFrame(toFrame)
    setToast(`关键帧已移动到第 ${toFrame} 帧`)
  }
  const changeSelectedInterpolation = interpolation => {
    if (!selectedKeyframeInfo) return
    const update = list => list.map(key => key.frame === selectedKeyframeInfo.frame ? { ...key, interpolation: normalizeInterpolation(interpolation) } : key)
    if (selectedKeyframeInfo.kind === 'camera') setKeyframes(update)
    else setCharacterKeyframes(tracks => ({ ...tracks, [selectedKeyframeInfo.trackId]: update(tracks[selectedKeyframeInfo.trackId] || []) }))
  }
  const copySelectedKeyframe = () => {
    if (!selectedKeyframeInfo) return
    const track = selectedKeyframeInfo.kind === 'camera' ? keyframes : characterKeyframes[selectedKeyframeInfo.trackId]
    const key = track?.find(item => item.frame === selectedKeyframeInfo.frame)
    if (!key) return
    setKeyframeClipboard({ kind: selectedKeyframeInfo.kind, key: JSON.parse(JSON.stringify(key)) })
    setToast('关键帧已复制')
  }
  const pasteKeyframe = () => {
    if (!keyframeClipboard) return
    const next = { ...JSON.parse(JSON.stringify(keyframeClipboard.key)), frame: currentFrame }
    if (keyframeClipboard.kind === 'camera') {
      setKeyframes(list => [...list.filter(key => key.frame !== currentFrame), next].sort((a, b) => a.frame - b.frame))
      setSelectedKeyframe({ kind: 'camera', frame: currentFrame, trackId: null })
    } else {
      if (!activeObject) { setToast('请先选择要粘贴关键帧的物体'); return }
      setCharacterKeyframes(tracks => ({ ...tracks, [activeObject.id]: [...(tracks[activeObject.id] || []).filter(key => key.frame !== currentFrame), { ...next, source: 'manual' }].sort((a, b) => a.frame - b.frame) }))
      setSelectedKeyframe({ kind: 'object', frame: currentFrame, trackId: activeObject.id })
    }
    setToast(`关键帧已粘贴到第 ${currentFrame} 帧`)
  }
  const changeSelectedCameraKey = patch => {
    if (!selectedKeyframeInfo || selectedKeyframeInfo.kind !== 'camera') return
    const frame = selectedKeyframeInfo.frame
    const nextKeyframes = keyframes.map(key => key.frame === frame ? { ...key, ...patch } : key)
    setKeyframes(nextKeyframes)
    setCurrentFrame(frame)
    // Keep the viewport and camera monitor on the keyframe being edited, exactly like seeking.
    setCamera(current => cameraAtFrame(nextKeyframes, frame, current.aspectRatio, current))
  }
  const deleteSelectedKeyframe = () => {
    if (!selectedKeyframeInfo) return
    if (selectedKeyframeInfo.kind === 'camera') deleteKeyframe(selectedKeyframeInfo.frame)
    else if (activeObject?.id === selectedKeyframeInfo.trackId) deleteObjectKeyframe(selectedKeyframeInfo.frame)
  }
  const saveProject = ({ download = false } = {}) => {
    const data = projectData({ settings, objects, camera, lighting, reference, keyframes, objectKeyframes: characterKeyframes, routeTracks, shots, activeShotId })
    const serialized = JSON.stringify(data)
    let cached = true
    try { localStorage.setItem(PROJECT_STORAGE_KEY, serialized) } catch { cached = false }
    if (download) {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      const safeName = settings.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'monoform-project'
      link.download = `${safeName}.monoform.json`
      link.click()
      URL.revokeObjectURL(link.href)
    }
    if (download) setToast(cached ? '工程 JSON 已导出' : '工程已导出，但浏览器自动保存空间不足')
    else setToast(cached ? '工程已保存到浏览器' : '浏览器保存空间不足，请使用“导出工程”备份')
  }
  const handleCaptureImage = async () => {
    if (exportLockRef.current || exporting || capturingImage) return
    exportLockRef.current = true
    setPlaying(false)
    imageCaptureCanvasRef.current = null
    try {
      const { width, height } = exportDimensions
      const backgroundCanvas = await referenceCanvasForExport(reference, width, height)
      setExportReferenceBackground(backgroundCanvas)
      setCapturingImage(true)
      let canvas = null
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await nextPaint()
        canvas = imageCaptureCanvasRef.current
        if (canvas?.width === width && canvas?.height === height) break
      }
      if (!canvas || canvas.width !== width || canvas.height !== height) throw new Error('截图画面初始化失败')
      await nextPaint()
      const blob = await new Promise((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG 生成失败')), 'image/png'))
      // Notify the embedding canvas host so the frame can be inserted directly as a canvas image node.
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'monoform', type: 'export', kind: 'image', blob, width, height }, '*')
      }
      const link = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      link.href = URL.createObjectURL(blob)
      link.download = `monoform-shot-${stamp}-frame-${String(currentFrameRef.current).padStart(3, '0')}.png`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(link.href)
      setToast(`摄像机截图已导出 · ${width} × ${height}`)
    } catch (error) {
      setToast(error?.message || '摄像机截图失败')
    } finally {
      setCapturingImage(false)
      setExportReferenceBackground(null)
      imageCaptureCanvasRef.current = null
      exportLockRef.current = false
    }
  }
  const handleExportMp4 = async () => {
    if (exportLockRef.current || exporting || capturingImage) return
    exportLockRef.current = true
    const nextExportFrameCount = totalFrames
    const originalFrame = currentFrameRef.current
    const originalCamera = keyframes.length ? cameraAtFrame(keyframes, originalFrame, camera.aspectRatio, camera) : camera
    let output

    setPlaying(false)
    setObjectDrafts({})
    setCamera(originalCamera)
    setExportProgress(0)
    exportCanvasRef.current = null

    try {
      if (typeof VideoEncoder === 'undefined') throw new Error('当前浏览器不支持视频编码，请使用最新版 Chrome 或 Edge')
      const {
        BufferTarget, CanvasSource, Mp4OutputFormat, Output,
        QUALITY_HIGH, getFirstEncodableVideoCodec,
      } = await import('mediabunny')
      const { width, height } = exportDimensions
      const backgroundCanvas = await referenceCanvasForExport(reference, width, height)
      setExportReferenceBackground(backgroundCanvas)
      setExporting(true)
      const codec = await getFirstEncodableVideoCodec(['avc', 'av1', 'vp9'], { width, height, quality: QUALITY_HIGH })
      if (!codec) throw new Error('当前设备没有可用的 MP4 视频编码器')

      let canvas = null
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await nextPaint()
        canvas = exportCanvasRef.current
        if (canvas?.width === width && canvas?.height === height) break
      }
      if (!canvas || canvas.width !== width || canvas.height !== height) throw new Error('导出画面初始化失败')

      output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
      const videoSource = new CanvasSource(canvas, {
        codec,
        quality: QUALITY_HIGH,
        keyFrameInterval: 2,
        latencyMode: 'quality',
      })
      output.addVideoTrack(videoSource, { frameRate: fps })
      await output.start()

      for (let sample = 0; sample < nextExportFrameCount; sample += 1) {
        const timelineFrame = Math.min(sample, totalFrames)
        setCurrentFrame(timelineFrame)
        currentFrameRef.current = timelineFrame
        await nextPaint()
        await videoSource.add(sample / fps, 1 / fps, { keyFrame: sample % (fps * 2) === 0 })
        setExportProgress(Math.round((sample + 1) / nextExportFrameCount * 100))
      }

      await output.finalize()
      const buffer = output.target.buffer
      if (!buffer) throw new Error('MP4 文件生成失败')
      const blob = new Blob([buffer], { type: 'video/mp4' })
      // Notify the embedding canvas host so the video can be inserted directly as a canvas video node.
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'monoform', type: 'export', kind: 'video', blob }, '*')
      }
      const link = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      link.href = URL.createObjectURL(blob)
      const safeName = settings.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'monoform-animation'
      link.download = `${safeName}-${stamp}.mp4`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(link.href)
      setToast(`MP4 已导出 · ${width} × ${height} · ${fps} FPS · ${settings.durationSeconds} 秒`)
    } catch (error) {
      if (output && output.state !== 'finalized') await output.cancel().catch(() => {})
      setToast(error?.message || 'MP4 导出失败')
    } finally {
      setCurrentFrame(originalFrame)
      currentFrameRef.current = originalFrame
      setCamera(originalCamera)
      setExporting(false)
      setExportProgress(0)
      setExportReferenceBackground(null)
      exportCanvasRef.current = null
      exportLockRef.current = false
    }
  }
  const loadProject = event => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const loaded = normalizeProjectData(JSON.parse(reader.result))
        if (!loaded) throw new Error('invalid project')
        setSettings(loaded.settings)
        setShots(loaded.shots)
        setActiveShotId(loaded.activeShotId)
        setObjects(loaded.objects)
        setCamera(loaded.camera)
        setLighting(loaded.lighting)
        setReference(loaded.reference)
        setKeyframes(loaded.keyframes)
        setCharacterKeyframes(loaded.objectKeyframes)
        setRouteTracks(loaded.routeTracks || {})
        setRouteEditMode(false)
        setRouteEditPoints([])
        setDrawRoute(false)
        setObjectDrafts({})
        setSelectedKeyframe(null)
        setCurrentFrame(0)
        currentFrameRef.current = 0
        setPlaying(false)
        setSettingsOpen(false)
        setSelectedId(CAMERA_ID)
        setToast(`工程已打开 · ${loaded.shots.length} 个镜头`)
      } catch { setToast('工程文件无法读取') }
    }
    reader.readAsText(file)
    event.target.value = ''
  }
  const resetProject = () => {
    const resetObjects = cloneProjectValue(initialObjects)
    const resetCamera = cloneProjectValue(initialCamera)
    setSettings({ ...DEFAULT_PROJECT_SETTINGS })
    setShots([{ id: 'shot-01', name: '镜头 01', thumbnail: '', fps: DEFAULT_PROJECT_SETTINGS.fps, durationSeconds: DEFAULT_PROJECT_SETTINGS.durationSeconds, loopPlayback: DEFAULT_PROJECT_SETTINGS.loopPlayback, objects: resetObjects, camera: resetCamera, lighting: cloneProjectValue(DEFAULT_LIGHTING), reference: cloneProjectValue(DEFAULT_REFERENCE), keyframes: [], objectKeyframes: {}, routeTracks: {} }])
    setActiveShotId('shot-01')
    setObjects(resetObjects)
    setCamera(resetCamera)
    setLighting(cloneProjectValue(DEFAULT_LIGHTING))
    setReference(cloneProjectValue(DEFAULT_REFERENCE))
    setKeyframes(initialKeyframes)
    setCharacterKeyframes(initialCharacterKeyframes)
    setRouteTracks({})
    setRouteEditMode(false)
    setRouteEditPoints([])
    setDrawRoute(false)
    setObjectDrafts({})
    setSelectedKeyframe(null)
    setCurrentFrame(0)
    currentFrameRef.current = 0
    setPlaying(false)
    setSettingsOpen(false)
    setSelectedId('actor-lead')
    setToast('已新建空关键帧工程 · 可在时间轴右侧设置时长')
  }

  return (
    <main className={`app-shell ${drawRoute ? 'is-route-mode' : ''} ${HAS_CUSTOM_TITLEBAR ? 'has-custom-titlebar' : ''}`} aria-busy={exporting || capturingImage}>
      <header className="topbar">
        <div className="brand-mark">
          <span className="brand-glyph"><img src={BRAND_MARK_URL} alt="" /></span>
          <div><strong>MONOFORM</strong><small>AGENT · 白模预演</small></div>
        </div>
        <nav className="top-actions">
          <button onClick={resetProject}><Plus size={14} /> 新建</button>
          <button onClick={() => loadRef.current?.click()}><FolderOpen size={14} /> 打开</button>
          <button onClick={() => saveProject()}><Save size={14} /> 保存</button>
          <input ref={loadRef} className="visually-hidden" type="file" accept=".json" onChange={loadProject} />
          <span className="top-divider" />
          <ToolButton icon={Undo2} label="撤销" shortcut="Ctrl+Z" onClick={undo} disabled={!historyRef.current.past.length} />
          <ToolButton icon={Redo2} label="重做" shortcut="Ctrl+Y" onClick={redo} disabled={!historyRef.current.future.length} />
        </nav>
        <div className="project-title"><i className={`status-dot ${saveStatus === '保存中…' ? '' : 'live'}`} /><button type="button" onClick={() => setSettingsOpen(true)} title="打开时间轴设置"><span>{settings.name}</span><Settings2 size={12} /></button><small>{activeShot?.name} · {saveStatus}</small></div>
        <div className="export-actions">
          <button className="project-export-button" onClick={() => saveProject({ download: true })} disabled={exporting || capturingImage}><Download size={14} /> 导出工程</button>
          <button className="project-export-button capture-image-button" onClick={handleCaptureImage} disabled={exporting || capturingImage}><FileImage size={14} /> {capturingImage ? '截图中…' : '截图 PNG'}</button>
          <button className="export-button" onClick={handleExportMp4} disabled={exporting || capturingImage}><FileVideo2 size={14} /> {exporting ? `${exportProgress}%` : '导出 MP4'}</button>
        </div>
      </header>

      <div className="workspace">
        <LeftSidebar objects={objects} selectedId={selectedId} onSelect={selectInspector} onAddPerson={addPerson} onAddPrimitive={addPrimitive} onImport={importModel} onToggleVisible={id => updateObjectById(id, { visible: objects.find(item => item.id === id)?.visible === false })} onToggleLock={id => updateObjectById(id, { locked: !objects.find(item => item.id === id)?.locked })} shots={displayedShots} activeShotId={activeShotId} onSelectShot={switchShot} onAddShot={addShot} onDuplicateShot={duplicateShot} onDeleteShot={deleteShot} onRenameShot={renameShot} onCaptureShot={captureShotThumbnail} camera={camera} currentFrame={currentFrame} fps={fps} onUpdateCamera={updateCameraFromUI} onAddCameraKeyframe={addKeyframe} onOpenCameraView={openCameraView} onClearCanvas={clearCanvas} />
        <section className="viewport-shell">
          <div className="viewport-toolbar floating-panel">
            <ToolButton icon={MousePointer2} label="选择" active={!['translate', 'rotate', 'scale'].includes(transformMode)} onClick={() => setTransformMode('select')} shortcut="Q" />
            <span />
            <ToolButton icon={Move3D} label="移动" active={transformMode === 'translate'} onClick={() => setTransformMode('translate')} shortcut="W" />
            <ToolButton icon={RotateCw} label="旋转" active={transformMode === 'rotate'} onClick={() => setTransformMode('rotate')} shortcut="E" />
            <ToolButton icon={BoxSelect} label="缩放" active={transformMode === 'scale'} onClick={() => setTransformMode('scale')} shortcut="R" />
            <ToolButton icon={Move3D} label={routeTracks[activeObject?.id] ? '编辑角色轨迹' : '鼠标画角色轨迹'} active={drawRoute} onClick={onRouteAction} />
            <span />
            <ToolButton icon={Axis3D} label={transformSpace === 'world' ? '世界坐标' : '局部坐标'} active={transformSpace === 'local'} disabled={transformMode === 'select'} onClick={() => setTransformSpace(space => space === 'world' ? 'local' : 'world')} />
            <ToolButton icon={Magnet} label={snapEnabled ? '关闭吸附' : '开启吸附'} active={snapEnabled} disabled={transformMode === 'select'} onClick={() => setSnapEnabled(value => !value)} />
          </div>
          {drawRoute && <div className="route-draw-panel floating-panel"><strong>{routeEditMode ? '编辑角色轨迹' : '画角色轨迹'} · 专用模式</strong><span>{routeEditMode ? '原轨迹保留在视图中，重新拖拽后替换。' : '其他面板已暂时停用。仅保留场景视图和鼠标拖拽。'}</span><label>结束秒数 <input type="number" min={Math.ceil((currentFrame+1)/fps)} max={settings.durationSeconds} step="1" value={routeEndSecond} onChange={event=>setRouteEndSecond(Number(event.target.value))} /></label><label className="route-loop-toggle"><input type="checkbox" checked={routeLoopMotion} onChange={event=>setRouteLoopMotion(event.target.checked)} /><span>关键帧动作循环</span></label>{routeEditMode && <button type="button" className="route-clear-button" onClick={() => clearRouteForObject(selectedId)}>清除当前轨迹</button>}{routeNotice&&<small>{routeNotice}</small>}</div>}
          <div className="viewport-mode-help">
            {transformMode === 'select' && 'Q 选择 / 人物摆姿 · 重叠处优先当前对象 · Alt 选择前层'}
            {transformMode === 'translate' && `W 整体移动 · ${transformSpace === 'world' ? '世界坐标' : '局部坐标'} · ${snapEnabled ? '0.1 格吸附' : '自由移动'}`}
            {transformMode === 'rotate' && `${selectedId === CAMERA_ID ? 'E 摄像机旋转' : 'E 整体旋转'} · ${transformSpace === 'world' ? '世界坐标' : '局部坐标'} · ${snapEnabled ? '5° 吸附' : '自由旋转'}`}
            {transformMode === 'scale' && `R 整体缩放 · ${transformSpace === 'world' ? '世界坐标' : '局部坐标'} · ${snapEnabled ? '0.1 吸附' : '自由缩放'}`}
          </div>
          <div className={`viewport-view-options floating-panel ${viewOptionsCollapsed ? 'is-collapsed' : ''}`}>
            {viewOptionsCollapsed ? (
              <button className="view-options-expand" onClick={() => setViewOptionsCollapsed(false)} title="展开视角工具" aria-label="展开视角工具"><ChevronLeft size={14} /></button>
            ) : (
              <>
                <button className={showGrid ? 'is-active' : ''} onClick={() => setShowGrid(value => !value)}><Grid3X3 size={14} /> 网格</button>
                <button className={lightingPanelOpen ? 'is-active' : ''} onClick={() => { setLightingPanelOpen(value => !value); setCameraAnglePanelOpen(false) }} title="调整当前镜头的环境光和主光"><Sun size={14} /> 光照</button>
                <button className={!cameraView ? 'is-active' : ''} onClick={openEditorView} title="使用固定的编辑观察相机自由布置场景"><RotateCw size={14} /> 编辑视角</button>
                <button className={cameraView ? 'is-active' : ''} onClick={openCameraView} title="切换到场景中主摄像机的实际画面"><Camera size={14} /> 摄像机视角</button>
                {cameraView && <button className={cameraAnglePanelOpen ? 'is-active' : ''} onClick={() => { setCameraAnglePanelOpen(value => !value); setLightingPanelOpen(false) }} title="调整参考图视角中的地面和水平线"><SlidersHorizontal size={14} /> 镜头角度</button>}
                <button><span className="solid-sphere" /> 实体</button>
                <button className="view-options-collapse" onClick={collapseViewOptions} title="收起视角工具" aria-label="收起视角工具"><ChevronRight size={14} /></button>
              </>
            )}
          </div>
          {lightingPanelOpen && <LightingPanel lighting={lighting} onChange={setLighting} onClose={() => setLightingPanelOpen(false)} />}
          {cameraView && cameraAnglePanelOpen && <CameraAnglePanel camera={camera} onChange={patch => setCamera(current => ({ ...current, ...patch }))} onClose={() => setCameraAnglePanelOpen(false)} onLevel={levelCameraHorizon} />}
          <div className="viewport-label"><strong>{cameraView ? '摄像机视角' : '编辑视角'}</strong><span>{cameraView ? `${aspectLabel(displayCamera.aspectRatio)} · 正在查看场景中的主摄像机` : '固定观察相机 · 可查看并调整场景中的主摄像机'}</span></div>
          {sceneReferenceImage && <div className="scene-reference-thumbnail"><img src={sceneReferenceImage} alt="本次场景图原图" /><span>原图对照 · 检查结构、空间和比例</span><button type="button" onClick={() => setSceneReferenceImage('')} aria-label="关闭原图对照">×</button></div>}
          <ViewportAspectPicker value={camera.aspectRatio} onChange={aspectRatio => setCamera(current => ({ ...current, aspectRatio }))} />
          <ReferenceOverlay reference={reference} onChange={setReference} onToast={setToast} cameraMode={cameraView} cameraAspect={previewAspect}>
            <div className="viewport-canvas-layer">
              <MainViewport
                key={cameraView ? 'shot-view' : 'scene-view'}
                cameraView={cameraView}
                cameraAspect={previewAspect}
                editorCameraData={editorView}
                onEditorCameraChange={captureEditorView}
                objects={animatedObjects}
                animationTime={currentFrame / fps}
                selectedId={selectedId}
                activeJoint={selectedJoint}
                onSelect={selectInspector}
                onJointSelect={(objectId, jointId) => { selectInspector(objectId); setSelectedJoint(jointId) }}
                transformMode={transformMode}
                transformSpace={transformSpace}
                snapEnabled={snapEnabled}
                groundRequest={groundRequest}
                onUpdateObject={updateObjectById}
                cameraData={displayCamera}
                onUpdateCamera={updateCameraFromUI}
                lighting={lighting}
                showGrid={showGrid}
                focusRequest={viewFocusRequest}
                referenceVisible={Boolean(reference.image && reference.visible)}
                drawRoute={drawRoute}
                routePoints={routeEditMode ? routeEditPoints : (routeTracks[activeObject?.id]?.visible === false ? [] : (routeTracks[activeObject?.id]?.points || []))}
                routeEditMode={routeEditMode}
                onUpdateRoutePoint={updateRoutePoint}
                onCompleteRoute={finishDrawRoute}
              />
            </div>
          </ReferenceOverlay>
          <div className="navigation-hint"><span><MousePointer2 size={12} /> 点击物体选择</span>{cameraView ? <><span>主摄像机画面</span><span>网格仅辅助 · 不进入导出</span></> : <><span>空白处左键旋转</span><span>右键平移</span><span>滚轮缩放</span></>}</div>
          <div className={`camera-monitor is-${monitorMode}`}>
            <div className="monitor-head"><div><Video size={13} /><strong>主摄像机 01</strong><span>{monitorMode === 'minimized' ? 'CAMERA' : 'CAMERA VIEW'}</span></div><div className="monitor-head-actions">
              {monitorMode === 'minimized' ? <button title="恢复摄像机窗口" onClick={() => setMonitorMode('normal')}><Maximize2 size={13} /></button> : <>
                <button title="选择场景中的主摄像机" onClick={() => selectInspector(CAMERA_ID)}><Camera size={12} /></button>
                <button title="最小化摄像机窗口" onClick={() => setMonitorMode('minimized')}><Minus size={13} /></button>
                <button title={monitorMode === 'expanded' ? '恢复摄像机窗口大小' : '放大摄像机窗口'} onClick={() => setMonitorMode(mode => mode === 'expanded' ? 'normal' : 'expanded')}>{monitorMode === 'expanded' ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
                <button title="切换到摄像机视角" onClick={openCameraView}><ZoomIn size={13} /></button>
              </>}
            </div></div>
            {monitorMode !== 'minimized' && <div className="monitor-frame">
              <div className={`monitor-canvas ${previewAspectClass}`} style={{ '--preview-aspect': previewAspect }}>
                <CameraPreview objects={animatedObjects} animationTime={currentFrame / fps} cameraData={displayCamera} cameraAspect={previewAspect} lighting={lighting} backgroundCanvas={monitorReferenceBackground} onCanvasReady={canvas => { monitorCanvasRef.current = canvas }} />
                <span className="safe-frame" />
                <span className="owner-watermark" aria-label="MONOFORM 品牌标识"><i><img src={BRAND_MARK_URL} alt="" /></i><b>MONOFORM</b></span>
                <span className="monitor-timecode">{timecodeAtFrame(currentFrame, fps)}</span>
                <span className="monitor-focal">{Math.round(displayCamera.focalLength)} mm · {aspectLabel(displayCamera.aspectRatio)}</span>
              </div>
            </div>}
          </div>
        </section>
        <aside className="right-sidebar panel">
          <div className="panel-tabs panel-tabs-right" role="tablist" aria-label="右侧面板">
            <button type="button" role="tab" aria-selected={rightTab === 'inspector'} className={rightTab === 'inspector' ? 'is-active' : ''} onClick={() => setRightTab('inspector')}>属性</button>
            <button type="button" role="tab" aria-selected={rightTab === 'agent'} className={rightTab === 'agent' ? 'is-active' : ''} onClick={() => setRightTab('agent')}>AI 助手</button>
          </div>
          <div className={`right-tab-body ${rightTab === 'inspector' ? '' : 'is-hidden'}`} role="tabpanel">
            <Inspector selected={inspectorSelected} camera={camera} objects={objects} selectedJoint={selectedJoint} customPoses={customPoses} onSelectJoint={setSelectedJoint} onUpdateObject={updateSelected} onUpdateCamera={updateCameraFromUI} onDelete={deleteSelected} onDuplicate={duplicateSelected} onFocus={focusSelected} onToggleLock={() => activeObject && updateSelected({ locked: !activeObject.locked })} onGround={groundSelected} onResetPosition={resetSelectedPosition} onResetRotation={resetSelectedRotation} onResetScale={resetSelectedScale} onSaveCustomPose={saveCustomPose} onApplyCustomPose={applyCustomPose} onDeleteCustomPose={deleteCustomPose} />
          </div>
          <div className={`right-tab-body ${rightTab === 'agent' ? '' : 'is-hidden'}`} role="tabpanel">
            <AgentPanel getSceneContext={getSceneContext} onApplyScene={applySceneFromTool} sceneToolkit={agentSceneToolkit} />
          </div>
        </aside>
        <Timeline
          currentFrame={currentFrame}
          fps={fps}
          totalFrames={totalFrames}
          objects={objects}
          onChangeCameraKeyframe={changeSelectedCameraKey}
          onOpenSettings={() => setSettingsOpen(true)}
          onSeek={seekToFrame}
          playing={playing}
          onTogglePlay={togglePlayback}
          keyframes={keyframes}
          onAddKeyframe={addKeyframe}
          onDeleteKeyframe={deleteKeyframe}
          objectTrack={activeObject ? { id: activeObject.id, name: activeObject.name, type: activeObject.type, bodyType: activeObject.bodyType, keyframes: characterKeyframes[activeObject.id] || [] } : null}
          onAddObjectKeyframe={addObjectKeyframe}
          onDeleteObjectKeyframe={deleteObjectKeyframe}
          selectedKeyframe={selectedKeyframeInfo}
          onSelectKeyframe={setSelectedKeyframe}
          onMoveKeyframe={moveKeyframe}
          onCopyKeyframe={copySelectedKeyframe}
          onPasteKeyframe={pasteKeyframe}
          onDeleteSelectedKeyframe={deleteSelectedKeyframe}
          onChangeInterpolation={changeSelectedInterpolation}
          hasClipboard={Boolean(keyframeClipboard)}
        />
      </div>
      {capturingImage && (
        <div className="export-render-surface" style={{ width: exportDimensions.width, height: exportDimensions.height }} aria-hidden="true">
          <CameraPreview objects={animatedObjects} animationTime={currentFrame / fps} cameraData={displayCamera} cameraAspect={exportDimensions.width / exportDimensions.height} lighting={lighting} exportMode backgroundCanvas={exportReferenceBackground} onCanvasReady={canvas => { imageCaptureCanvasRef.current = canvas }} />
        </div>
      )}
      {exporting && (
        <>
          <div className="export-render-surface" style={{ width: exportDimensions.width, height: exportDimensions.height }} aria-hidden="true">
            <CameraPreview objects={animatedObjects} animationTime={currentFrame / fps} cameraData={displayCamera} cameraAspect={exportDimensions.width / exportDimensions.height} lighting={lighting} exportMode backgroundCanvas={exportReferenceBackground} onCanvasReady={canvas => { exportCanvasRef.current = canvas }} />
          </div>
          <div className="export-progress-overlay" role="status" aria-live="polite">
            <div className="export-progress-card">
              <FileVideo2 size={20} />
              <div className="export-progress-copy"><strong>正在编码 MP4</strong><span>{exportDimensions.width} × {exportDimensions.height} · {fps} FPS · 第 {Math.round(exportProgress / 100 * totalFrames)} / {totalFrames} 帧</span></div>
              <output>{exportProgress}%</output>
              <div className="export-progress-track"><i style={{ width: `${exportProgress}%` }} /></div>
            </div>
          </div>
        </>
      )}
      {settingsOpen && <ProjectSettingsDialog settings={settings} maxKeyframeFrame={maxKeyframeFrame} onApply={applySettings} onClose={() => setSettingsOpen(false)} />}
      {toast && <div className="toast"><span />{toast}</div>}
    </main>
  )
}
