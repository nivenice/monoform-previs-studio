// Prints the Markdown bone-axis table embedded in server/agent/rigPrompt.ts.
// The runtime applies joints as additive local Euler deltas on top of the
// sampled clip, so a direction probe at idle@0.08 is the most useful reference
// for the animator subagent. Re-run after replacing the baked GLB and paste the
// output into RIG_AXIS_GUIDE.
//
// Usage: node scripts/pose/rig-axis-guide.mjs
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { JOINT_DEFINITIONS } from '../../src/rig.js'

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
const PROBE_DEGREES = 15

const SELECTED = new Set([
  'mixamorigHips', 'mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigHead',
  ...['Left', 'Right'].flatMap(side => ['Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase']
    .map(part => `mixamorig${side}${part}`)),
  ...['Left', 'Right'].flatMap(side => ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']
    .map(finger => `mixamorig${side}Hand${finger}1`)),
])

const LABELS = Object.fromEntries(JOINT_DEFINITIONS.map(joint => [joint.id, joint.label]))
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
const children = {}
scene.traverse(node => {
  if (node.isBone && node.parent?.isBone) (children[node.parent.name] ||= []).push(node.name)
})
const restore = () => {
  for (const [name, bone] of Object.entries(bones)) bone.quaternion.copy(base.get(name))
  scene.updateMatrixWorld(true)
}
const worldPosition = name => bones[name].getWorldPosition(new THREE.Vector3())
const directionLabel = vector => {
  const parts = []
  if (Math.abs(vector.x) > 0.25) parts.push(vector.x > 0 ? '左' : '右')
  if (Math.abs(vector.y) > 0.25) parts.push(vector.y > 0 ? '上' : '下')
  if (Math.abs(vector.z) > 0.25) parts.push(vector.z > 0 ? '前' : '后')
  return parts.join('') || '微动'
}

console.log('| 骨骼 id | 名称 | +X（15°） | +Y（15°） | +Z（15°） |')
console.log('| --- | --- | --- | --- | --- |')
for (const id of SELECTED) {
  if (!bones[id]) continue
  const childName = (children[id] || []).find(name => name !== 'mixamorigHeadTop_End' && !name.includes('Eye')) || (children[id] || [])[0]
  if (!childName) {
    console.log(`| ${id} | ${LABELS[id] || ''} | 无子骨骼 | | |`)
    continue
  }
  restore()
  const start = worldPosition(childName)
  const labels = []
  for (let axis = 0; axis < 3; axis += 1) {
    restore()
    const euler = new THREE.Euler(0, 0, 0, 'XYZ')
    euler[['x', 'y', 'z'][axis]] = THREE.MathUtils.degToRad(PROBE_DEGREES)
    bones[id].quaternion.multiply(new THREE.Quaternion().setFromEuler(euler)).normalize()
    scene.updateMatrixWorld(true)
    const direction = worldPosition(childName).sub(start).normalize()
    labels.push(directionLabel(direction))
  }
  console.log(`| ${id} | ${LABELS[id] || ''} | ${labels[0]} | ${labels[1]} | ${labels[2]} |`)
}
