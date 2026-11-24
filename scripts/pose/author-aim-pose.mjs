// Authoring helper for the `aim_pistol` rig preset in src/rig.js.
//
// The runtime applies pose joints as additive euler deltas on top of the
// embedded animation clip (see MixamoPersonModel in src/Viewport.jsx), so a
// believable two-handed aim is a small optimisation problem: find deltas for the
// arm chain that put both hands in front of the chest with the forearms pointing
// forward, without moving the torso. Coordinate descent against the real
// skeleton solves it offline in a couple of seconds and prints the numbers to
// paste into rig.js.
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

// Hands in front of the chest, forearms pointing along +Z (the character faces
// +Z at yaw 0). Values are model-local metres taken from the idle bind pose.
const TARGETS = {
  rightHand: new THREE.Vector3(0.015, 1.365, 0.50),
  leftHand: new THREE.Vector3(0.135, 1.315, 0.40),
}
const FORWARD = new THREE.Vector3(0, 0, 1)
const JOINT_IDS = [
  'mixamorigRightShoulder', 'mixamorigRightArm', 'mixamorigRightForeArm', 'mixamorigRightHand',
  'mixamorigLeftShoulder', 'mixamorigLeftArm', 'mixamorigLeftForeArm', 'mixamorigLeftHand',
]
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
const delta = Object.fromEntries(JOINT_IDS.map(id => [id, [0, 0, 0]]))
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

function cost() {
  apply()
  const rightHand = worldPosition('mixamorigRightHand')
  const leftHand = worldPosition('mixamorigLeftHand')
  const rightElbow = worldPosition('mixamorigRightForeArm')
  const leftElbow = worldPosition('mixamorigLeftForeArm')
  const rightDirection = rightHand.clone().sub(rightElbow).normalize()
  const leftDirection = leftHand.clone().sub(leftElbow).normalize()
  let value = rightHand.distanceToSquared(TARGETS.rightHand) * 24
  value += leftHand.distanceToSquared(TARGETS.leftHand) * 14
  value += (1 - rightDirection.dot(FORWARD)) * 0.9
  value += (1 - leftDirection.dot(FORWARD)) * 0.5
  // Keep the elbows out of the torso and slightly forward of the chest.
  if (rightElbow.x > -0.18) value += (rightElbow.x + 0.18) * 10
  if (leftElbow.x < 0.18) value += (0.18 - leftElbow.x) * 10
  if (rightElbow.z < 0.12) value += (0.12 - rightElbow.z) * 6
  if (leftElbow.z < 0.08) value += (0.08 - leftElbow.z) * 6
  for (const degrees of Object.values(delta)) {
    value += degrees.reduce((sum, angle) => sum + Math.max(0, Math.abs(angle) - 75) * 0.004, 0)
  }
  return value
}

let best = cost()
for (const step of SCHEDULE) {
  let improved = true
  while (improved) {
    improved = false
    for (const id of JOINT_IDS) {
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
const leftHand = worldPosition('mixamorigLeftHand')
const rightGap = rightHand.distanceTo(TARGETS.rightHand)
const leftGap = leftHand.distanceTo(TARGETS.leftHand)

console.log(`cost ${best.toFixed(4)} · right hand off by ${(rightGap * 100).toFixed(1)} cm · left hand off by ${(leftGap * 100).toFixed(1)} cm`)
console.log(JSON.stringify(joints, null, 2))
if (Math.max(rightGap, leftGap) > 0.06) {
  console.error('Hand targets were not reached; adjust TARGETS before baking the preset.')
  process.exitCode = 1
}
