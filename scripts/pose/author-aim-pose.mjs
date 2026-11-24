// Authoring helper for the `aim_pistol` rig preset in src/rig.js.
//
// The runtime applies pose joints as additive euler deltas on top of the
// embedded animation clip (see MixamoPersonModel in src/Viewport.jsx), so a
// believable two-handed aim is a small optimisation problem: blade the torso
// slightly, put the dominant hand in front of the chest at eye height, support
// it with the other hand, and keep the head turned to the lens. Coordinate
// descent against the real skeleton solves it offline in a couple of seconds and
// prints the numbers to paste into rig.js.
//
// Usage: node scripts/pose/author-aim-pose.mjs
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

// GLTFLoader expects browser globals even when it only parses a local GLB.
globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, init = {}) { this.type = type; Object.assign(this, init) }
}
globalThis.FileReader ??= class FileReader {
  result = null
  onloadend = null
  readAsArrayBuffer(blob) {
    return blob.arrayBuffer().then(result => {
      this.result = result
      queueMicrotask(() => this.onloadend?.({ target: this }))
      return result
    })
  }
}

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const MODEL_PATH = path.join(ROOT, 'public', 'models', 'xbot-animated.glb')
const CLIP_NAME = 'idle'
const CLIP_PHASE = 0.08

// The torso is bladed like a shooter's stance and the head turns back to the
// lens. These are fixed so the solver only has to place the aiming arm.
const TORSO_DEGREES = {
  mixamorigSpine1: [0, 10, 0],
  mixamorigSpine2: [0, 6, 0],
  mixamorigHead: [0, -16, 0],
}
const ARM_JOINTS = [
  'mixamorigRightShoulder', 'mixamorigRightArm', 'mixamorigRightForeArm', 'mixamorigRightHand',
]

// Model-local metres. Without a weapon prop the pose has to read from the
// silhouette alone: one straight arm reaches at the lens at chest/shoulder
// height (in front of the right shoulder so it does not cover the face), the
// other stays relaxed at the hip.
const TARGETS = {
  rightHand: new THREE.Vector3(-0.12, 1.38, 0.51),
}
const FORWARD = new THREE.Vector3(0, 0, 1)
const SCHEDULE = [40, 24, 14, 8, 5, 3, 2, 1, 0.6, 0.3, 0.15, 0.08]

const buffer = fs.readFileSync(MODEL_PATH)
const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', resolve, reject))
const scene = gltf.scene
const bones = {}
scene.traverse(node => { if (node.isBone) bones[node.name] = node })

const mixer = new THREE.AnimationMixer(scene)
const clip = THREE.AnimationClip.findByName(gltf.animations, CLIP_NAME)
if (!clip) throw new Error(`Animation clip ${CLIP_NAME} was not found`)
const action = mixer.clipAction(clip)
action.reset().setLoop(THREE.LoopOnce, 0)
action.clampWhenFinished = true
action.play()
mixer.setTime(clip.duration * CLIP_PHASE)
scene.updateMatrixWorld(true)

const base = new Map(Object.entries(bones).map(([name, bone]) => [name, bone.quaternion.clone()]))
const delta = Object.fromEntries([...Object.keys(TORSO_DEGREES), ...ARM_JOINTS].map(id => [id, [0, 0, 0]]))
for (const [id, degrees] of Object.entries(TORSO_DEGREES)) delta[id] = [...degrees]
const euler = new THREE.Euler()
const quaternion = new THREE.Quaternion()
const worldPosition = name => bones[name].getWorldPosition(new THREE.Vector3())

const restore = () => {
  for (const [name, bone] of Object.entries(bones)) bone.quaternion.copy(base.get(name))
  scene.updateMatrixWorld(true)
}

const apply = () => {
  restore()
  for (const [id, degrees] of Object.entries(delta)) {
    if (!degrees.some(value => Math.abs(value) > 1e-9)) continue
    euler.set(
      THREE.MathUtils.degToRad(degrees[0]),
      THREE.MathUtils.degToRad(degrees[1]),
      THREE.MathUtils.degToRad(degrees[2]),
      'XYZ',
    )
    bones[id].quaternion.multiply(quaternion.setFromEuler(euler)).normalize()
  }
  scene.updateMatrixWorld(true)
}

const distanceToSegment = (point, start, end) => {
  const direction = end.clone().sub(start)
  const length = direction.lengthSq()
  if (!length) return point.distanceTo(start)
  const t = THREE.MathUtils.clamp(point.clone().sub(start).dot(direction) / length, 0, 1)
  return point.distanceTo(start.clone().addScaledVector(direction, t))
}

function cost() {
  apply()
  const rightShoulder = worldPosition('mixamorigRightArm')
  const rightHand = worldPosition('mixamorigRightHand')
  const rightElbow = worldPosition('mixamorigRightForeArm')
  const head = worldPosition('mixamorigHead')
  const rightDirection = rightHand.clone().sub(rightElbow).normalize()
  let value = rightHand.distanceToSquared(TARGETS.rightHand) * 40
  value += (1 - rightDirection.dot(FORWARD)) * 1.4
  // Keep the aiming arm nearly straight: the elbow belongs on the line to the
  // hand, which reads as "pointing at the lens" instead of "hands clasped".
  value += distanceToSegment(rightElbow, rightShoulder, rightHand) * 1.5
  // The hand should stay clear of the face in the final framing.
  if (rightHand.distanceTo(head) < 0.34) value += (0.34 - rightHand.distanceTo(head)) * 3
  // Clavicles barely move in a real aiming pose; keep them from smuggling reach.
  value += delta.mixamorigRightShoulder.reduce((sum, angle) => sum + Math.max(0, Math.abs(angle) - 20) * 0.06, 0)
  for (const degrees of Object.values(delta)) {
    value += degrees.reduce((sum, angle) => sum + Math.max(0, Math.abs(angle) - 80) * 0.004, 0)
  }
  return value
}

let best = cost()
for (const step of SCHEDULE) {
  let improved = true
  while (improved) {
    improved = false
    for (const id of ARM_JOINTS) {
      for (let axis = 0; axis < 3; axis += 1) {
        for (const sign of [1, -1]) {
          const previous = delta[id][axis]
          delta[id][axis] = previous + step * sign
          const next = cost()
          if (next < best - 1e-9) {
            best = next
            improved = true
          } else {
            delta[id][axis] = previous
          }
        }
      }
    }
  }
}

apply()
const joints = {}
for (const [id, degrees] of Object.entries(delta)) {
  if (!degrees.some(value => Math.abs(value) > 1e-6)) continue
  joints[id] = degrees.map(value => Number(THREE.MathUtils.degToRad(value).toFixed(4)))
}
const rightHand = worldPosition('mixamorigRightHand')
const rightGap = rightHand.distanceTo(TARGETS.rightHand)
const rightElbow = worldPosition('mixamorigRightForeArm')

console.log(`cost ${best.toFixed(4)} · aiming hand off by ${(rightGap * 100).toFixed(1)} cm · elbow (${rightElbow.x.toFixed(2)}, ${rightElbow.y.toFixed(2)}, ${rightElbow.z.toFixed(2)})`)
console.log(JSON.stringify(joints, null, 2))
if (rightGap > 0.08) {
  console.error('Hand targets were not reached; adjust TARGETS before baking the preset.')
  process.exitCode = 1
}
