import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Grid, OrbitControls, TransformControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { poseForObject, presetDefinition } from './rig.js'
import { MinimalPersonModel } from './MinimalPersonModel.jsx'
import { normalizeAxisLocks } from './transformValues.js'

const CAMERA_ID = '__shot_camera__'
const BUILT_IN_MODEL_URL = `${import.meta.env.BASE_URL}models/xbot-animated.glb`
const whiteMaterial = { roughness: 0.78, metalness: 0.02 }

function dominantBoneNameFromHit(event) {
  const mesh = event.object
  const face = event.face
  const skinIndex = mesh?.geometry?.attributes?.skinIndex
  const skinWeight = mesh?.geometry?.attributes?.skinWeight
  const skeleton = mesh?.skeleton
  if (!mesh?.isSkinnedMesh || !face || !skinIndex || !skinWeight || !skeleton) return null

  const scores = new Map()
  for (const vertex of [face.a, face.b, face.c]) {
    for (let channel = 0; channel < 4; channel += 1) {
      const index = skinIndex.getComponent(vertex, channel)
      const weight = skinWeight.getComponent(vertex, channel)
      if (weight > 0) scores.set(index, (scores.get(index) || 0) + weight)
    }
  }
  let bestIndex = -1
  let bestScore = -1
  for (const [index, score] of scores) {
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }
  return skeleton.bones[bestIndex]?.name || null
}

const IK_CHAINS = {
  mixamorigLeftHand: ['mixamorigLeftForeArm', 'mixamorigLeftArm'],
  mixamorigRightHand: ['mixamorigRightForeArm', 'mixamorigRightArm'],
  mixamorigLeftFoot: ['mixamorigLeftLeg', 'mixamorigLeftUpLeg'],
  mixamorigRightFoot: ['mixamorigRightLeg', 'mixamorigRightUpLeg'],
}

function ikEffectorForJoint(jointId = '') {
  if (jointId.startsWith('mixamorigLeftHand')) return 'mixamorigLeftHand'
  if (jointId.startsWith('mixamorigRightHand')) return 'mixamorigRightHand'
  if (jointId.startsWith('mixamorigLeftFoot') || jointId.startsWith('mixamorigLeftToe')) return 'mixamorigLeftFoot'
  if (jointId.startsWith('mixamorigRightFoot') || jointId.startsWith('mixamorigRightToe')) return 'mixamorigRightFoot'
  return null
}

function MixamoJointMarker({ bone, jointId, selected, modelRoot, onSelectJoint, onBeginDrag, onDrag, onEndDrag }) {
  const markerRef = useRef(null)
  const worldPosition = useMemo(() => new THREE.Vector3(), [])
  const isFineBone = /Hand|Eye|End/.test(jointId)
  useFrame(() => {
    if (!bone || !markerRef.current || !modelRoot.current) return
    bone.getWorldPosition(worldPosition)
    modelRoot.current.worldToLocal(worldPosition)
    markerRef.current.position.copy(worldPosition)
  })
  return (
    <mesh
      ref={markerRef}
      scale={selected ? 1.25 : 0.72}
      onPointerDown={event => {
        if (onBeginDrag?.(event, jointId)) return
        event.stopPropagation()
        onSelectJoint?.(jointId)
      }}
      onPointerMove={onDrag}
      onPointerUp={onEndDrag}
      onPointerCancel={onEndDrag}
      renderOrder={8}
    >
      <sphereGeometry args={[isFineBone ? 0.012 : 0.022, 12, 8]} />
      <meshBasicMaterial color={selected ? '#ffd469' : '#bf9948'} transparent opacity={selected ? 0.98 : 0.28} depthTest={false} />
    </mesh>
  )
}

function MixamoIKHandle({ bone, jointId, selected, modelRoot, onBeginDrag, onDrag, onEndDrag }) {
  const markerRef = useRef(null)
  const worldPosition = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    if (!bone || !markerRef.current || !modelRoot.current) return
    bone.getWorldPosition(worldPosition)
    modelRoot.current.worldToLocal(worldPosition)
    markerRef.current.position.copy(worldPosition)
  })
  return (
    <group
      ref={markerRef}
      onPointerDown={event => onBeginDrag?.(event, jointId)}
      onPointerMove={onDrag}
      onPointerUp={onEndDrag}
      onPointerCancel={onEndDrag}
    >
      <mesh
        scale={selected ? 1.18 : 1}
        renderOrder={10}
      >
        <octahedronGeometry args={[0.055, 0]} />
        <meshBasicMaterial color={selected ? '#8ee6d0' : '#55bca9'} transparent opacity={0.96} depthTest={false} />
      </mesh>
      <mesh renderOrder={9}>
        <sphereGeometry args={[0.09, 12, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  )
}

function MixamoPersonModel({ pose = 'idle', poseTime, continuousMotion = false, animationTime = 0, rigRoot, joints, footLock = false, color = '#e8e3d8', selected = false, selectedJoint, onSelectJoint, onRotateJoint, onRotateJoints, showBoneGizmo = false, onSurfacePointerDown, onSurfacePointerMove, onSurfacePointerUp }) {
  const gltf = useGLTF(BUILT_IN_MODEL_URL)
  const orbitControls = useThree(state => state.controls)
  const camera = useThree(state => state.camera)
  const viewportSize = useThree(state => state.size)
  const modelRoot = useRef(null)
  const rig = poseForObject({ pose, rigRoot, joints })
  const sampledRotations = useRef(new WeakMap())
  const boneDrag = useRef(null)
  const { scene, bones, bindTransforms, materials, mixer, clips } = useMemo(() => {
    const cloned = skeletonClone(gltf.scene)
    const nextBones = {}
    const nextBindTransforms = new WeakMap()
    const nextMaterials = []

    cloned.traverse(child => {
      if (child.isBone) {
        nextBones[child.name] = child
        nextBindTransforms.set(child, {
          position: child.position.clone(),
          quaternion: child.quaternion.clone(),
          scale: child.scale.clone(),
        })
      }
      if (child.isMesh) {
        child.castShadow = true
        child.receiveShadow = true
        child.frustumCulled = false
        const material = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02 })
        child.material = material
        nextMaterials.push(material)
      }
    })

    return {
      scene: cloned,
      bones: nextBones,
      bindTransforms: nextBindTransforms,
      materials: nextMaterials,
      mixer: new THREE.AnimationMixer(cloned),
      clips: Object.fromEntries(gltf.animations.map(clip => [clip.name, clip])),
    }
  }, [gltf])

  useLayoutEffect(() => {
    mixer.stopAllAction()
    for (const bone of Object.values(bones)) {
      const bind = bindTransforms.get(bone)
      if (!bind) continue
      bone.position.copy(bind.position)
      bone.quaternion.copy(bind.quaternion)
      bone.scale.copy(bind.scale)
    }
    scene.updateMatrixWorld(true)

    const preset = presetDefinition(pose)
    const clip = preset.clip ? clips[preset.clip] : null
    if (clip) {
      const action = mixer.clipAction(clip)
      action.reset().setLoop(THREE.LoopOnce, 0)
      action.clampWhenFinished = true
      action.play()
      const basePhase = THREE.MathUtils.clamp(Number.isFinite(poseTime) ? poseTime : preset.phase, 0, 1)
      const phase = continuousMotion && preset.loopable && preset.duration > 0
        ? ((basePhase + animationTime / preset.duration) % 1 + 1) % 1
        : basePhase
      mixer.setTime(clip.duration * phase)
    }

    const nextSampled = new WeakMap()
    const deltaEuler = new THREE.Euler()
    const deltaQuaternion = new THREE.Quaternion()
    for (const [jointId, bone] of Object.entries(bones)) {
      nextSampled.set(bone, bone.quaternion.clone())
      const rotation = rig.joints[jointId]
      if (!rotation) continue
      deltaEuler.set(rotation[0] || 0, rotation[1] || 0, rotation[2] || 0, 'XYZ')
      deltaQuaternion.setFromEuler(deltaEuler)
      bone.quaternion.multiply(deltaQuaternion).normalize()
    }
    sampledRotations.current = nextSampled
    scene.updateMatrixWorld(true)
  }, [animationTime, bindTransforms, bones, clips, continuousMotion, mixer, pose, poseTime, rig.joints, scene])

  useLayoutEffect(() => {
    const bodyColor = new THREE.Color(color)
    const selectionGlow = new THREE.Color('#4b3511')
    for (const material of materials) {
      material.color.copy(bodyColor)
      material.emissive.copy(selectionGlow)
      material.emissiveIntensity = selected ? 0.16 : 0
      material.needsUpdate = true
    }
  }, [color, materials, selected])

  useEffect(() => () => {
    mixer.stopAllAction()
    mixer.uncacheRoot(scene)
    materials.forEach(material => material.dispose())
  }, [materials, mixer, scene])

  const beginIKDrag = useCallback((event, jointId) => {
    const effectorId = ikEffectorForJoint(jointId)
    const chainIds = IK_CHAINS[effectorId]
    const effector = bones[effectorId]
    if (!selected || !showBoneGizmo || !onRotateJoints || !effector || !chainIds?.every(id => bones[id])) return false
    event.stopPropagation()
    event.nativeEvent?.stopImmediatePropagation?.()
    event.target?.setPointerCapture?.(event.pointerId)
    onSelectJoint?.(effectorId)
    scene.updateMatrixWorld(true)
    const startTarget = effector.getWorldPosition(new THREE.Vector3())
    const distance = Math.max(0.5, camera.position.distanceTo(startTarget))
    const fov = THREE.MathUtils.degToRad(camera.fov || 42)
    const worldPerPixel = 2 * Math.tan(fov / 2) * distance / Math.max(1, viewportSize.height)
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize()
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize()
    boneDrag.current = {
      kind: 'ik',
      pointerId: event.pointerId,
      jointId: effectorId,
      chainIds,
      startX: event.clientX,
      startY: event.clientY,
      startTarget,
      worldPerPixel,
      right,
      up,
      lockHeight: footLock && effectorId.includes('Foot'),
      startQuaternions: Object.fromEntries(chainIds.map(id => [id, bones[id].quaternion.clone()])),
    }
    if (orbitControls) orbitControls.enabled = false
    document.body.style.cursor = 'grabbing'
    return true
  }, [bones, camera, footLock, onRotateJoints, onSelectJoint, orbitControls, scene, selected, showBoneGizmo, viewportSize.height])

  const beginBoneDrag = useCallback((event, jointId) => {
    if (ikEffectorForJoint(jointId) && beginIKDrag(event, jointId)) return true
    if (!selected || !showBoneGizmo || !onRotateJoint || !bones[jointId]) return false
    event.stopPropagation()
    event.nativeEvent?.stopImmediatePropagation?.()
    event.target?.setPointerCapture?.(event.pointerId)
    onSelectJoint?.(jointId)
    const startRotation = rig.joints[jointId] || [0, 0, 0]
    boneDrag.current = {
      kind: 'joint', pointerId: event.pointerId,
      jointId,
      startX: event.clientX,
      startY: event.clientY,
      startRotation: [...startRotation],
      nextRotation: [...startRotation],
    }
    if (orbitControls) orbitControls.enabled = false
    document.body.style.cursor = 'grabbing'
    return true
  }, [beginIKDrag, bones, onRotateJoint, onSelectJoint, orbitControls, rig.joints, selected, showBoneGizmo])

  const dragBone = useCallback(event => {
    const drag = boneDrag.current
    if (!drag || event.pointerId !== drag.pointerId) return
    event.stopPropagation()
    if (drag.kind === 'ik') {
      for (const jointId of drag.chainIds) bones[jointId].quaternion.copy(drag.startQuaternions[jointId])
      scene.updateMatrixWorld(true)
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      const target = drag.startTarget.clone()
        .addScaledVector(drag.right, dx * drag.worldPerPixel)
        .addScaledVector(drag.up, -dy * drag.worldPerPixel)
      if (drag.lockHeight) target.y = drag.startTarget.y

      const effector = bones[drag.jointId]
      const jointPosition = new THREE.Vector3()
      const endPosition = new THREE.Vector3()
      const currentDirection = new THREE.Vector3()
      const targetDirection = new THREE.Vector3()
      const parentWorld = new THREE.Quaternion()
      const worldDelta = new THREE.Quaternion()
      const localDelta = new THREE.Quaternion()
      for (let iteration = 0; iteration < 10; iteration += 1) {
        for (const jointId of drag.chainIds) {
          const joint = bones[jointId]
          joint.getWorldPosition(jointPosition)
          effector.getWorldPosition(endPosition)
          currentDirection.copy(endPosition).sub(jointPosition)
          targetDirection.copy(target).sub(jointPosition)
          if (currentDirection.lengthSq() < 1e-8 || targetDirection.lengthSq() < 1e-8) continue
          currentDirection.normalize()
          targetDirection.normalize()
          worldDelta.setFromUnitVectors(currentDirection, targetDirection)
          joint.parent.getWorldQuaternion(parentWorld)
          localDelta.copy(parentWorld).invert().multiply(worldDelta).multiply(parentWorld)
          joint.quaternion.premultiply(localDelta).normalize()
          scene.updateMatrixWorld(true)
        }
        effector.getWorldPosition(endPosition)
        if (endPosition.distanceToSquared(target) < 0.000025) break
      }
      return
    }
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    const twist = Boolean(event.shiftKey || event.nativeEvent?.shiftKey)
    const nextRotation = twist
      ? [drag.startRotation[0], drag.startRotation[1], drag.startRotation[2] + dx * 0.012]
      : [drag.startRotation[0] - dy * 0.012, drag.startRotation[1] + dx * 0.012, drag.startRotation[2]]
    const bone = bones[drag.jointId]
    const sampled = sampledRotations.current.get(bone)
    if (!bone || !sampled) return
    const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(...nextRotation, 'XYZ'))
    bone.quaternion.copy(sampled).multiply(delta).normalize()
    scene.updateMatrixWorld(true)
    drag.nextRotation = nextRotation
  }, [bones, scene])

  const endBoneDrag = useCallback(event => {
    const drag = boneDrag.current
    if (!drag || event.pointerId !== drag.pointerId) return
    event.stopPropagation()
    event.target?.releasePointerCapture?.(event.pointerId)
    boneDrag.current = null
    if (orbitControls) orbitControls.enabled = true
    document.body.style.cursor = ''
    if (drag.kind === 'ik') {
      const rotations = {}
      const inverseSampled = new THREE.Quaternion()
      const delta = new THREE.Quaternion()
      const euler = new THREE.Euler()
      for (const jointId of drag.chainIds) {
        const bone = bones[jointId]
        const sampled = sampledRotations.current.get(bone)
        if (!sampled) continue
        inverseSampled.copy(sampled).invert()
        delta.copy(inverseSampled).multiply(bone.quaternion).normalize()
        euler.setFromQuaternion(delta, 'XYZ')
        rotations[jointId] = [euler.x, euler.y, euler.z]
      }
      onRotateJoints?.(rotations)
    } else {
      onRotateJoint?.(drag.jointId, drag.nextRotation)
    }
  }, [bones, onRotateJoint, onRotateJoints, orbitControls])

  const beginBoneDragFromSurface = useCallback(event => {
    if (!selected || !showBoneGizmo) return
    const jointId = dominantBoneNameFromHit(event)
    if (jointId) beginBoneDrag(event, jointId)
  }, [beginBoneDrag, selected, showBoneGizmo])

  const handleSurfacePointerDown = useCallback(event => {
    if (showBoneGizmo) beginBoneDragFromSurface(event)
    else onSurfacePointerDown?.(event)
  }, [beginBoneDragFromSurface, onSurfacePointerDown, showBoneGizmo])
  const handleSurfacePointerMove = useCallback(event => {
    if (showBoneGizmo) dragBone(event)
    else onSurfacePointerMove?.(event)
  }, [dragBone, onSurfacePointerMove, showBoneGizmo])
  const handleSurfacePointerUp = useCallback(event => {
    if (showBoneGizmo) endBoneDrag(event)
    else onSurfacePointerUp?.(event)
  }, [endBoneDrag, onSurfacePointerUp, showBoneGizmo])

  useEffect(() => () => {
    if (boneDrag.current) {
      document.body.style.cursor = ''
      if (orbitControls) orbitControls.enabled = true
    }
  }, [orbitControls])

  return (
    <group position={rig.root}>
      <group ref={modelRoot}>
        <primitive
          object={scene}
          onPointerDown={handleSurfacePointerDown}
          onPointerMove={handleSurfacePointerMove}
          onPointerUp={handleSurfacePointerUp}
          onPointerCancel={handleSurfacePointerUp}
        />
        {selected && showBoneGizmo && Object.entries(bones).map(([jointId, bone]) => (
          <MixamoJointMarker
            key={jointId}
            bone={bone}
            jointId={jointId}
            selected={selectedJoint === jointId}
            modelRoot={modelRoot}
            onSelectJoint={onSelectJoint}
            onBeginDrag={beginBoneDrag}
            onDrag={dragBone}
            onEndDrag={endBoneDrag}
          />
        ))}
        {selected && showBoneGizmo && Object.keys(IK_CHAINS).map(jointId => (
          <MixamoIKHandle
            key={`ik-${jointId}`}
            bone={bones[jointId]}
            jointId={jointId}
            selected={selectedJoint === jointId}
            modelRoot={modelRoot}
            onBeginDrag={beginIKDrag}
            onDrag={dragBone}
            onEndDrag={endBoneDrag}
          />
        ))}
      </group>
    </group>
  )
}

class ModelErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function StudioPerson(props) {
  const fallback = <mesh position={[0, 0.9, 0]} castShadow><capsuleGeometry args={[0.28, 1.25, 8, 18]} /><meshStandardMaterial color={props.color || '#e8e3d8'} {...whiteMaterial} /></mesh>
  return (
    <ModelErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <MixamoPersonModel {...props} />
      </Suspense>
    </ModelErrorBoundary>
  )
}

function ImportedModel({ url, selected }) {
  const gltf = useGLTF(url)
  const scene = useMemo(() => skeletonClone(gltf.scene), [gltf.scene])
  useLayoutEffect(() => {
    scene.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true
        child.receiveShadow = true
        if (selected && child.material) {
          child.material = child.material.clone()
          child.material.emissive = new THREE.Color('#312813')
          child.material.emissiveIntensity = 0.22
        }
      }
    })
  }, [scene, selected])
  return <primitive object={scene} />
}

function ArchPrimitive({ color }) {
  const shape = useMemo(() => {
    const outer = new THREE.Shape()
    outer.moveTo(-0.5, -0.5)
    outer.lineTo(0.5, -0.5)
    outer.lineTo(0.5, 0.5)
    outer.lineTo(-0.5, 0.5)
    outer.closePath()
    const opening = new THREE.Path()
    opening.moveTo(-0.29, -0.5)
    opening.lineTo(-0.29, -0.08)
    opening.absarc(0, -0.08, 0.29, Math.PI, 0, true)
    opening.lineTo(0.29, -0.5)
    opening.closePath()
    outer.holes.push(opening)
    return outer
  }, [])
  const settings = useMemo(() => ({ depth: 0.36, bevelEnabled: true, bevelSize: 0.018, bevelThickness: 0.018, bevelSegments: 2, curveSegments: 28 }), [])
  return (
    <mesh position={[0, 0, -0.18]} castShadow receiveShadow>
      <extrudeGeometry args={[shape, settings]} />
      <meshStandardMaterial color={color} {...whiteMaterial} />
    </mesh>
  )
}

function RoofPrimitive({ color }) {
  const shape = useMemo(() => {
    const triangle = new THREE.Shape()
    triangle.moveTo(-0.5, -0.5)
    triangle.lineTo(0.5, -0.5)
    triangle.lineTo(0, 0.5)
    triangle.closePath()
    return triangle
  }, [])
  const settings = useMemo(() => ({ depth: 1, bevelEnabled: false }), [])
  return <mesh position={[0, 0, -0.5]} castShadow receiveShadow><extrudeGeometry args={[shape, settings]} /><meshStandardMaterial color={color} {...whiteMaterial} /></mesh>
}

function SimplePart({ shape = 'box', color }) {
  if (shape === 'sphere') return <mesh castShadow receiveShadow><sphereGeometry args={[0.5, 20, 14]} /><meshStandardMaterial color={color} {...whiteMaterial} /></mesh>
  if (shape === 'cylinder') return <mesh castShadow receiveShadow><cylinderGeometry args={[0.5, 0.5, 1, 20]} /><meshStandardMaterial color={color} {...whiteMaterial} /></mesh>
  if (shape === 'arch') return <ArchPrimitive color={color} />
  return <mesh castShadow receiveShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial color={color} {...whiteMaterial} /></mesh>
}

function AssemblyModel({ parts = [], color }) {
  return (
    <group>
      {parts.map((part, index) => (
        <group
          key={index}
          position={part.position || [0, 0, 0]}
          rotation={(part.rotationDegrees || [0, 0, 0]).map(value => THREE.MathUtils.degToRad(value))}
          scale={part.scale || [1, 1, 1]}
        >
          <SimplePart shape={part.shape} color={color} />
        </group>
      ))}
    </group>
  )
}

function StairsModel({ color }) {
  const steps = 7
  return <group>{Array.from({ length: steps }, (_, index) => {
    const height = (index + 1) / steps
    return <group key={index} position={[0, -0.5 + height / 2, -0.5 + (index + 0.5) / steps]} scale={[1, height, 1 / steps]}><SimplePart color={color} /></group>
  })}</group>
}

function TableModel({ color }) {
  return <group><group position={[0, 0.34, 0]} scale={[1, 0.14, 0.82]}><SimplePart color={color} /></group>{[-0.41, 0.41].flatMap(x => [-0.31, 0.31].map(z => <group key={`${x}-${z}`} position={[x, -0.08, z]} scale={[0.1, 0.72, 0.1]}><SimplePart color={color} /></group>))}</group>
}

function ChairModel({ color }) {
  return <group><group position={[0, 0.02, 0]} scale={[0.82, 0.13, 0.78]}><SimplePart color={color} /></group><group position={[0, 0.3, 0.34]} scale={[0.82, 0.58, 0.12]}><SimplePart color={color} /></group>{[-0.32, 0.32].flatMap(x => [-0.29, 0.29].map(z => <group key={`${x}-${z}`} position={[x, -0.27, z]} scale={[0.09, 0.48, 0.09]}><SimplePart color={color} /></group>))}</group>
}

function SofaModel({ color }) {
  return <group><group position={[0, -0.17, 0]} scale={[1, 0.42, 0.82]}><SimplePart color={color} /></group><group position={[0, 0.22, 0.32]} rotation={[-0.12, 0, 0]} scale={[1, 0.62, 0.18]}><SimplePart color={color} /></group><group position={[-0.45, 0.08, 0]} scale={[0.12, 0.38, 0.82]}><SimplePart color={color} /></group><group position={[0.45, 0.08, 0]} scale={[0.12, 0.38, 0.82]}><SimplePart color={color} /></group></group>
}

function DoorModel({ color }) {
  return <group><group position={[-0.46, 0, 0]} scale={[0.09, 1, 0.16]}><SimplePart color={color} /></group><group position={[0.46, 0, 0]} scale={[0.09, 1, 0.16]}><SimplePart color={color} /></group><group position={[0, 0.46, 0]} scale={[0.92, 0.09, 0.16]}><SimplePart color={color} /></group><group position={[0, -0.02, 0]} scale={[0.78, 0.86, 0.07]}><SimplePart color={color} /></group><group position={[0.27, -0.02, -0.07]} scale={[0.045, 0.045, 0.045]}><SimplePart shape="sphere" color="#625c50" /></group></group>
}

function WindowModel({ color }) {
  return <group><group position={[-0.46, 0, 0]} scale={[0.08, 1, 0.14]}><SimplePart color={color} /></group><group position={[0.46, 0, 0]} scale={[0.08, 1, 0.14]}><SimplePart color={color} /></group><group position={[0, 0.46, 0]} scale={[1, 0.08, 0.14]}><SimplePart color={color} /></group><group position={[0, -0.46, 0]} scale={[1, 0.08, 0.14]}><SimplePart color={color} /></group><group scale={[0.06, 0.86, 0.08]}><SimplePart color={color} /></group><group scale={[0.86, 0.06, 0.08]}><SimplePart color={color} /></group></group>
}

function TreeModel({ color }) {
  return <group><group position={[0, -0.23, 0]} scale={[0.2, 0.55, 0.2]}><SimplePart shape="cylinder" color="#766b57" /></group><group position={[0, 0.2, 0]} scale={[0.78, 0.65, 0.78]}><SimplePart shape="sphere" color={color} /></group><group position={[-0.25, 0.04, 0.08]} scale={[0.48, 0.45, 0.48]}><SimplePart shape="sphere" color={color} /></group><group position={[0.25, 0.03, -0.08]} scale={[0.48, 0.43, 0.48]}><SimplePart shape="sphere" color={color} /></group></group>
}

function VehicleModel({ color }) {
  return <group><group position={[0, -0.08, 0]} scale={[1, 0.42, 0.78]}><SimplePart color={color} /></group><group position={[0.08, 0.22, -0.03]} scale={[0.52, 0.34, 0.66]}><SimplePart color={color} /></group>{[-0.34, 0.34].flatMap(x => [-0.32, 0.32].map(z => <group key={`${x}-${z}`} position={[x, -0.34, z]} rotation={[0, 0, Math.PI / 2]} scale={[0.22, 0.13, 0.22]}><SimplePart shape="cylinder" color="#343432" /></group>))}</group>
}

function PrimitiveModel({ type, color, selected, parts = [] }) {
  const materialColor = selected ? '#f3dba5' : color
  if (type === 'sphere') return <SimplePart shape="sphere" color={materialColor} />
  if (type === 'cylinder') return <SimplePart shape="cylinder" color={materialColor} />
  if (type === 'plane') return <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow><planeGeometry args={[1, 1]} /><meshStandardMaterial color={materialColor} roughness={0.9} side={THREE.DoubleSide} /></mesh>
  if (type === 'arch') return <ArchPrimitive color={materialColor} />
  if (type === 'stairs') return <StairsModel color={materialColor} />
  if (type === 'table') return <TableModel color={materialColor} />
  if (type === 'chair') return <ChairModel color={materialColor} />
  if (type === 'sofa') return <SofaModel color={materialColor} />
  if (type === 'door') return <DoorModel color={materialColor} />
  if (type === 'window') return <WindowModel color={materialColor} />
  if (type === 'tree') return <TreeModel color={materialColor} />
  if (type === 'vehicle') return <VehicleModel color={materialColor} />
  if (type === 'roof') return <RoofPrimitive color={materialColor} />
  if (type === 'assembly' && parts.length) return <AssemblyModel parts={parts} color={materialColor} />
  return <SimplePart color={materialColor} />
}

function smoothDepthValues(values, width, height, passes) {
  let current = values
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float32Array(current.length)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        let count = 0
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            const sampleX = x + offsetX
            const sampleY = y + offsetY
            if (sampleX >= 0 && sampleX < width && sampleY >= 0 && sampleY < height) {
              sum += current[sampleY * width + sampleX]
              count += 1
            }
          }
        }
        next[y * width + x] = sum / count
      }
    }
    current = next
  }
  return current
}

function DepthMeshModel({ url, settings = {}, color, selected }) {
  const [geometry, setGeometry] = useState(null)
  const invert = settings.invert ?? false
  const near = Math.max(0.05, Number(settings.near ?? 0.8))
  const far = Math.max(near + 0.1, Number(settings.far ?? 6))
  const fov = THREE.MathUtils.clamp(Number(settings.fov ?? 60), 20, 120)
  const density = THREE.MathUtils.clamp(Math.round(Number(settings.density ?? 64)), 16, 128)
  const smoothing = THREE.MathUtils.clamp(Math.round(Number(settings.smoothing ?? 1)), 0, 4)

  useEffect(() => {
    let cancelled = false
    const image = new Image()
    image.onload = () => {
      const imageAspect = image.width / Math.max(1, image.height)
      const columns = imageAspect >= 1 ? density : Math.max(16, Math.round(density * imageAspect))
      const rows = imageAspect >= 1 ? Math.max(16, Math.round(density / imageAspect)) : density
      const canvas = document.createElement('canvas')
      canvas.width = columns
      canvas.height = rows
      const context = canvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(image, 0, 0, columns, rows)
      const pixels = context.getImageData(0, 0, columns, rows).data
      let depthValues = new Float32Array(columns * rows)
      for (let index = 0; index < depthValues.length; index += 1) {
        const pixel = index * 4
        depthValues[index] = (pixels[pixel] * 0.2126 + pixels[pixel + 1] * 0.7152 + pixels[pixel + 2] * 0.0722) / 255
      }
      depthValues = smoothDepthValues(depthValues, columns, rows, smoothing)

      const positions = new Float32Array(columns * rows * 3)
      const fieldOfView = THREE.MathUtils.degToRad(fov)
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < columns; x += 1) {
          const index = y * columns + x
          const normalizedDepth = invert ? 1 - depthValues[index] : depthValues[index]
          const distance = near + normalizedDepth * (far - near)
          const halfHeight = Math.tan(fieldOfView / 2) * distance
          const halfWidth = halfHeight * imageAspect
          positions[index * 3] = (x / Math.max(1, columns - 1) * 2 - 1) * halfWidth
          positions[index * 3 + 1] = (1 - y / Math.max(1, rows - 1) * 2) * halfHeight
          positions[index * 3 + 2] = -(distance - near)
        }
      }

      const indices = []
      for (let y = 0; y < rows - 1; y += 1) {
        for (let x = 0; x < columns - 1; x += 1) {
          const topLeft = y * columns + x
          const topRight = topLeft + 1
          const bottomLeft = topLeft + columns
          const bottomRight = bottomLeft + 1
          indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight)
        }
      }

      const nextGeometry = new THREE.BufferGeometry()
      nextGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      nextGeometry.setIndex(indices)
      nextGeometry.computeVertexNormals()
      nextGeometry.computeBoundingBox()
      nextGeometry.computeBoundingSphere()
      if (!cancelled) setGeometry(nextGeometry)
      else nextGeometry.dispose()
    }
    image.src = url
    return () => { cancelled = true }
  }, [url, invert, near, far, fov, density, smoothing])

  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!geometry) return <mesh><planeGeometry args={[2.5, 1.4, 10, 6]} /><meshStandardMaterial color="#7f7b72" wireframe /></mesh>
  return (
    <mesh geometry={geometry} castShadow receiveShadow={false}>
      <meshStandardMaterial color={selected ? '#f3dba5' : color || '#c9c4b8'} roughness={0.86} metalness={0.01} side={THREE.DoubleSide} />
    </mesh>
  )
}

function sceneObjectIdFromIntersection(intersection) {
  let object = intersection?.object
  while (object && !object.userData?.sceneObjectId) object = object.parent
  return object?.userData?.sceneObjectId || null
}

function shouldKeepCurrentSelection(event, selectedId, selected, transformMode) {
  if (selected || !selectedId) return false
  if (transformMode !== 'select') return true
  if (event.altKey || event.nativeEvent?.altKey) return false
  return event.intersections?.some(intersection => sceneObjectIdFromIntersection(intersection) === selectedId)
}

function SceneObject({ data, selected, selectedId, activeJoint, transformMode, transformSpace = 'world', snapEnabled = true, groundRequest, onSelect, onUpdate, onJointSelect, animationTime = 0, preview = false }) {
  const groupRef = useRef(null)
  const objectRotateDrag = useRef(null)
  const scaleTransformStart = useRef(null)
  const appliedGroundRequest = useRef(null)
  const orbitControls = useThree(state => state.controls)
  const positionAxisLocks = useMemo(() => normalizeAxisLocks(data.positionAxisLocks), [data.positionAxisLocks])
  const rotationAxisLocks = useMemo(() => normalizeAxisLocks(data.rotationAxisLocks), [data.rotationAxisLocks])
  const scaleAxisLocks = useMemo(() => normalizeAxisLocks(data.scaleAxisLocks), [data.scaleAxisLocks])
  const activeAxisLocks = transformMode === 'translate' ? positionAxisLocks : transformMode === 'rotate' ? rotationAxisLocks : scaleAxisLocks
  const stateAnimationTime = Math.max(0, animationTime - (Number.isFinite(data.motionStartTime) ? data.motionStartTime : 0))
  useEffect(() => {
    if (!groundRequest || groundRequest.id !== data.id || !groupRef.current || data.locked || positionAxisLocks[1] || preview) return
    const requestKey = `${groundRequest.id}:${groundRequest.nonce}`
    if (appliedGroundRequest.current === requestKey) return
    const object = groupRef.current
    object.updateWorldMatrix(true, true)
    const bounds = new THREE.Box3().setFromObject(object)
    if (!Number.isFinite(bounds.min.y)) return
    appliedGroundRequest.current = requestKey
    object.position.y -= bounds.min.y
    onUpdate(data.id, { position: object.position.toArray() })
  }, [data.id, data.locked, groundRequest?.id, groundRequest?.nonce, onUpdate, positionAxisLocks, preview])
  const syncTransform = useCallback(() => {
    const object = groupRef.current
    if (!object) return
    let nextScale = object.scale.toArray()
    if (transformMode === 'scale' && scaleTransformStart.current) {
      const baseline = scaleTransformStart.current
      const locks = scaleAxisLocks
      if (data.proportionalScale) {
        const changedAxis = nextScale
          .map((value, axis) => ({ axis, change: locks[axis] ? -1 : Math.abs(value / Math.max(0.0001, baseline[axis]) - 1) }))
          .sort((left, right) => right.change - left.change)[0]
        const factor = changedAxis?.change > 0.00001 ? nextScale[changedAxis.axis] / Math.max(0.0001, baseline[changedAxis.axis]) : 1
        nextScale = baseline.map((value, axis) => locks[axis] ? value : Math.max(0.05, value * factor))
      } else nextScale = nextScale.map((value, axis) => locks[axis] ? baseline[axis] : Math.max(0.05, value))
      object.scale.fromArray(nextScale)
    }
    onUpdate(data.id, {
      position: object.position.toArray(),
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: nextScale,
    })
  }, [data.id, data.proportionalScale, onUpdate, scaleAxisLocks, transformMode])
  const beginObjectInteraction = useCallback(event => {
    if (shouldKeepCurrentSelection(event, selectedId, selected, transformMode)) return
    event.stopPropagation()
    onSelect(data.id)
    if (data.locked) return
    if (!selected || transformMode !== 'rotate' || !groupRef.current || rotationAxisLocks.every(Boolean)) return
    event.nativeEvent?.stopImmediatePropagation?.()
    event.target?.setPointerCapture?.(event.pointerId)
    objectRotateDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rotation: [groupRef.current.rotation.x, groupRef.current.rotation.y, groupRef.current.rotation.z],
    }
    if (orbitControls) orbitControls.enabled = false
    document.body.style.cursor = 'grabbing'
  }, [data.id, data.locked, onSelect, orbitControls, rotationAxisLocks, selected, selectedId, transformMode])
  const rotateObjectFromSurface = useCallback(event => {
    const drag = objectRotateDrag.current
    const object = groupRef.current
    if (!drag || !object || event.pointerId !== drag.pointerId) return
    event.stopPropagation()
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    const roll = Boolean(event.shiftKey || event.nativeEvent?.shiftKey)
    const nextRotation = [
      roll ? drag.rotation[0] : drag.rotation[0] + dy * 0.01,
      roll ? drag.rotation[1] : drag.rotation[1] + dx * 0.01,
      roll ? drag.rotation[2] + dx * 0.01 : drag.rotation[2],
    ]
    object.rotation.set(...nextRotation.map((value, axis) => rotationAxisLocks[axis] ? drag.rotation[axis] : value))
  }, [rotationAxisLocks])
  const endObjectInteraction = useCallback(event => {
    const drag = objectRotateDrag.current
    if (!drag || event.pointerId !== drag.pointerId) return
    event.stopPropagation()
    event.target?.releasePointerCapture?.(event.pointerId)
    objectRotateDrag.current = null
    if (orbitControls) orbitControls.enabled = true
    document.body.style.cursor = ''
    syncTransform()
  }, [orbitControls, syncTransform])
  useEffect(() => () => {
    if (objectRotateDrag.current) {
      document.body.style.cursor = ''
      if (orbitControls) orbitControls.enabled = true
    }
  }, [orbitControls])
  const content = (
    <group
      ref={groupRef}
      position={data.position}
      rotation={data.rotation}
      scale={data.scale}
      visible={data.visible !== false}
      userData={{ sceneObjectId: data.id }}
      onPointerDown={preview ? undefined : beginObjectInteraction}
      onPointerMove={preview ? undefined : rotateObjectFromSurface}
      onPointerUp={preview ? undefined : endObjectInteraction}
      onPointerCancel={preview ? undefined : endObjectInteraction}
    >
      {data.type === 'person' ? (
        data.bodyType === 'minimal' ? (
          <MinimalPersonModel color={data.color} faceText={data.faceText} selected={selected} />
        ) : (
          <StudioPerson
            pose={data.pose}
            poseTime={data.poseTime}
            continuousMotion={data.continuousMotion}
            animationTime={stateAnimationTime}
            rigRoot={data.rigRoot}
            joints={data.joints}
            footLock={data.footLock}
            color={data.color}
            selected={selected}
            selectedJoint={activeJoint}
            showBoneGizmo={!preview && transformMode === 'select'}
            onSelectJoint={jointId => onJointSelect?.(data.id, jointId)}
            onRotateJoint={(jointId, rotation) => onUpdate(data.id, {
              joints: { ...(data.joints || {}), [jointId]: rotation },
            })}
            onRotateJoints={rotations => onUpdate(data.id, {
              joints: { ...(data.joints || {}), ...rotations },
            })}
            onSurfacePointerDown={beginObjectInteraction}
            onSurfacePointerMove={rotateObjectFromSurface}
            onSurfacePointerUp={endObjectInteraction}
          />
        )
      ) : data.type === 'depthMesh' && data.depthMapUrl ? (
        <DepthMeshModel url={data.depthMapUrl} settings={data.depthSettings} color={data.color} selected={selected} />
      ) : data.type === 'model' && data.url ? (
        <Suspense fallback={<mesh position={[0, 0.5, 0]}><boxGeometry /><meshStandardMaterial color="#7f7b72" wireframe /></mesh>}><ImportedModel url={data.url} selected={selected} /></Suspense>
      ) : (
        <PrimitiveModel type={data.type} color={data.color || '#c7c2b7'} selected={selected} parts={data.parts} />
      )}
    </group>
  )

  return (
    <>
      {content}
      {selected && !data.locked && !preview && transformMode !== 'select' && !activeAxisLocks.every(Boolean) && (
        <TransformControls
          object={groupRef}
          mode={transformMode}
          space={transformSpace}
          size={0.8}
          showX={!activeAxisLocks[0]}
          showY={!activeAxisLocks[1]}
          showZ={!activeAxisLocks[2]}
          translationSnap={snapEnabled ? 0.1 : null}
          rotationSnap={snapEnabled ? Math.PI / 36 : null}
          scaleSnap={snapEnabled ? 0.1 : null}
          onMouseDown={() => { if (transformMode === 'scale' && groupRef.current) scaleTransformStart.current = groupRef.current.scale.toArray() }}
          onObjectChange={syncTransform}
          onMouseUp={() => { syncTransform(); scaleTransformStart.current = null }}
        />
      )}
    </>
  )
}

function CameraModel({ data, selected, selectedId, transformMode, transformSpace = 'world', snapEnabled = true, onSelect, onUpdate }) {
  const groupRef = useRef(null)
  const positionAxisLocks = useMemo(() => normalizeAxisLocks(data.positionAxisLocks), [data.positionAxisLocks])
  const rotationAxisLocks = useMemo(() => normalizeAxisLocks(data.rotationAxisLocks), [data.rotationAxisLocks])
  const activeAxisLocks = transformMode === 'rotate' ? rotationAxisLocks : positionAxisLocks
  const syncTransform = useCallback(() => {
    if (!groupRef.current) return
    onUpdate({
      position: groupRef.current.position.toArray(),
      rotation: [groupRef.current.rotation.x, groupRef.current.rotation.y, groupRef.current.rotation.z],
    })
  }, [onUpdate])
  useLayoutEffect(() => {
    if (!groupRef.current) return
    groupRef.current.position.fromArray(data.position)
    groupRef.current.rotation.set(...data.rotation, 'XYZ')
  }, [data.position, data.rotation])
  const selectCamera = event => {
    if (shouldKeepCurrentSelection(event, selectedId, selected, transformMode)) return
    event.stopPropagation()
    onSelect(CAMERA_ID)
  }
  const rig = (
    <group ref={groupRef} position={data.position} rotation={data.rotation} userData={{ sceneObjectId: CAMERA_ID }} onPointerDown={selectCamera}>
      <mesh castShadow>
        <boxGeometry args={[0.52, 0.34, 0.42]} />
        <meshStandardMaterial color={selected ? '#eabf62' : '#3d3c38'} roughness={0.48} metalness={0.35} />
      </mesh>
      <mesh position={[0, 0, -0.34]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.18, 0.23, 0.32, 20]} />
        <meshStandardMaterial color="#232322" roughness={0.4} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0, -0.82]} rotation={[Math.PI / 2, 0, Math.PI / 4]} raycast={() => null}>
        <coneGeometry args={[0.36, 0.9, 4, 1, true]} />
        <meshBasicMaterial color={selected ? '#eabf62' : '#8e8a80'} wireframe transparent opacity={selected ? 0.72 : 0.28} depthWrite={false} />
      </mesh>
      <mesh position={[-0.18, 0.28, 0]}>
        <cylinderGeometry args={[0.13, 0.13, 0.12, 20]} />
        <meshStandardMaterial color="#33322f" />
      </mesh>
      <mesh position={[0.18, 0.28, 0]}>
        <cylinderGeometry args={[0.13, 0.13, 0.12, 20]} />
        <meshStandardMaterial color="#33322f" />
      </mesh>
      <mesh position={[0, -0.42, 0.15]}>
        <boxGeometry args={[0.07, 0.58, 0.07]} />
        <meshStandardMaterial color="#4b4944" />
      </mesh>
    </group>
  )
  return (
    <>
      {rig}
      {selected && ['translate', 'rotate'].includes(transformMode) && !activeAxisLocks.every(Boolean) && (
        <TransformControls
          object={groupRef}
          mode={transformMode}
          space={transformSpace}
          size={0.8}
          showX={!activeAxisLocks[0]}
          showY={!activeAxisLocks[1]}
          showZ={!activeAxisLocks[2]}
          translationSnap={snapEnabled ? 0.1 : null}
          rotationSnap={snapEnabled ? Math.PI / 36 : null}
          onObjectChange={syncTransform}
          onMouseUp={syncTransform}
        />
      )}
    </>
  )
}

const DEFAULT_STUDIO_LIGHTING = {
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

function StudioLights({ lighting = DEFAULT_STUDIO_LIGHTING }) {
  const azimuth = THREE.MathUtils.degToRad(lighting.keyAzimuth ?? DEFAULT_STUDIO_LIGHTING.keyAzimuth)
  const elevation = THREE.MathUtils.degToRad(lighting.keyElevation ?? DEFAULT_STUDIO_LIGHTING.keyElevation)
  const horizontal = Math.cos(elevation) * 10
  const height = Math.sin(elevation) * 10
  const keyPosition = [Math.sin(azimuth) * horizontal, height, Math.cos(azimuth) * horizontal]
  const fillPosition = [-keyPosition[0] * 0.85, Math.max(2.5, height * 0.42), -keyPosition[2] * 0.85]
  return (
    <>
      <hemisphereLight intensity={lighting.ambientIntensity ?? DEFAULT_STUDIO_LIGHTING.ambientIntensity} color={lighting.ambientColor || DEFAULT_STUDIO_LIGHTING.ambientColor} groundColor="#343536" />
      <directionalLight castShadow position={keyPosition} intensity={lighting.keyIntensity ?? DEFAULT_STUDIO_LIGHTING.keyIntensity} color={lighting.keyColor || DEFAULT_STUDIO_LIGHTING.keyColor} shadow-mapSize={[2048, 2048]} shadow-camera-left={-10} shadow-camera-right={10} shadow-camera-top={10} shadow-camera-bottom={-10} />
      <directionalLight position={fillPosition} intensity={lighting.fillIntensity ?? DEFAULT_STUDIO_LIGHTING.fillIntensity} color={lighting.fillColor || DEFAULT_STUDIO_LIGHTING.fillColor} />
    </>
  )
}

function RendererExposure({ value = DEFAULT_STUDIO_LIGHTING.exposure }) {
  const { gl } = useThree()
  useEffect(() => {
    gl.toneMappingExposure = value
  }, [gl, value])
  return null
}

function Ground({ showGrid = true, showSurface = true }) {
  return (
    <>
      {showSurface && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.025, 0]} receiveShadow>
          <planeGeometry args={[60, 60]} />
          <meshStandardMaterial color="#4b4b48" roughness={0.96} />
        </mesh>
      )}
      {showGrid && <Grid position={[0, 0.002, 0]} args={[30, 30]} cellSize={0.5} cellThickness={0.5} cellColor="#777771" sectionSize={5} sectionThickness={0.8} sectionColor="#9b8c68" fadeDistance={24} fadeStrength={1} infiniteGrid />}
    </>
  )
}

function ViewFocusController({ request }) {
  const { camera, controls } = useThree()
  useEffect(() => {
    if (!request || !controls) return
    const target = new THREE.Vector3(...request.position)
    target.y += request.height || 0
    const direction = camera.position.clone().sub(controls.target).normalize()
    if (!Number.isFinite(direction.x) || direction.lengthSq() < 0.001) direction.set(1, 0.65, 1).normalize()
    controls.target.copy(target)
    camera.position.copy(target).addScaledVector(direction, request.distance || 5)
    controls.update()
  }, [camera, controls, request])
  return null
}

function EditorCameraReporter({ enabled, onChange }) {
  const { camera, controls } = useThree()
  useEffect(() => {
    if (!enabled || !controls || !onChange) return undefined
    let frame = 0
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => onChange({
        position: camera.position.toArray(),
        rotation: [camera.rotation.x, camera.rotation.y, camera.rotation.z],
        target: controls.target.toArray(),
      }))
    }
    controls.addEventListener('change', report)
    report()
    return () => {
      cancelAnimationFrame(frame)
      controls.removeEventListener('change', report)
    }
  }, [camera, controls, enabled, onChange])
  return null
}

function EditorScene({ objects, selectedId, activeJoint, onSelect, onJointSelect, transformMode, transformSpace, snapEnabled, groundRequest, onUpdateObject, cameraData, cameraAspect, onUpdateCamera, editorCameraData, onEditorCameraChange, lighting, showGrid, focusRequest, drawRoute = false, referenceVisible = false, cameraView = false, animationTime = 0 }) {
  return (
    <>
      {!referenceVisible && <color attach="background" args={['#555653']} />}
      <fog attach="fog" args={['#555653', 18, 42]} />
      <RendererExposure value={lighting?.exposure} />
      <StudioLights lighting={lighting} />
      <Ground showGrid={showGrid} showSurface={!referenceVisible} />
      {objects.map(object => <SceneObject key={object.id} data={object} selected={selectedId === object.id} selectedId={selectedId} activeJoint={activeJoint} transformMode={transformMode} transformSpace={transformSpace} snapEnabled={snapEnabled} groundRequest={groundRequest} onSelect={onSelect} onJointSelect={onJointSelect} onUpdate={onUpdateObject} animationTime={animationTime} />)}
      {!cameraView && <CameraModel data={cameraData} selected={selectedId === CAMERA_ID} selectedId={selectedId} transformMode={transformMode} transformSpace={transformSpace} snapEnabled={snapEnabled} onSelect={onSelect} onUpdate={onUpdateCamera} />}
      <ContactShadows position={[0, 0.01, 0]} opacity={0.42} scale={18} blur={2.4} far={9} />
      {cameraView ? <PreviewCameraController cameraData={cameraData} cameraAspect={cameraAspect} /> : <OrbitControls makeDefault enabled={!drawRoute} target={editorCameraData?.target || [0, 1, 0]} minDistance={0.5} maxDistance={300} minPolarAngle={0.01} maxPolarAngle={Math.PI - 0.01} enablePan />}
      <EditorCameraReporter enabled={!cameraView} onChange={onEditorCameraChange} />
      {!cameraView && <ViewFocusController request={focusRequest} />}
    </>
  )
}

function PreviewCameraController({ cameraData, cameraAspect }) {
  const { camera, size } = useThree()
  useFrame(() => {
    camera.position.fromArray(cameraData.position)
    camera.rotation.set(...cameraData.rotation, 'XYZ')
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(24 / (2 * cameraData.focalLength)))
    const nextAspect = Number.isFinite(cameraAspect) && cameraAspect > 0 ? cameraAspect : size.width / Math.max(1, size.height)
    if (Math.abs(camera.fov - fov) > 0.01 || Math.abs(camera.aspect - nextAspect) > 0.0001) {
      camera.fov = fov
      camera.aspect = nextAspect
      camera.updateProjectionMatrix()
    }
  })
  return null
}

function CanvasBackground({ canvas }) {
  const texture = useMemo(() => {
    if (!canvas) return null
    const next = new THREE.CanvasTexture(canvas)
    next.colorSpace = THREE.SRGBColorSpace
    next.needsUpdate = true
    return next
  }, [canvas])
  useEffect(() => () => texture?.dispose(), [texture])
  return texture ? <primitive attach="background" object={texture} /> : <color attach="background" args={['#9b9c98']} />
}

function PreviewScene({ objects, cameraData, cameraAspect, lighting, backgroundCanvas = null, animationTime = 0 }) {
  return (
    <>
      <CanvasBackground canvas={backgroundCanvas} />
      <fog attach="fog" args={['#9b9c98', 18, 38]} />
      <RendererExposure value={lighting?.exposure} />
      <StudioLights lighting={lighting} />
      <Ground showGrid={false} showSurface={!backgroundCanvas} />
      {objects.map(object => <SceneObject key={object.id} data={object} animationTime={animationTime} preview />)}
      <ContactShadows position={[0, 0.01, 0]} opacity={0.35} scale={18} blur={2.2} far={9} />
      <PreviewCameraController cameraData={cameraData} cameraAspect={cameraAspect} />
    </>
  )
}

function RoutePreviewLine({points=[]}) {
  if(points.length<2)return null
  const vectors=points.map(p=>new THREE.Vector3(p[0],.08,p[2]))
  const geometry=new THREE.BufferGeometry().setFromPoints(vectors)
  const distances=new Float32Array(vectors.length)
  for(let index=1;index<vectors.length;index+=1) distances[index]=distances[index-1]+vectors[index].distanceTo(vectors[index-1])
  geometry.setAttribute('lineDistance',new THREE.BufferAttribute(distances,1))
  return <line geometry={geometry} renderOrder={20}><lineDashedMaterial color="#ffe17e" dashSize={.32} gapSize={.18} linewidth={2} depthTest={false} /></line>
}
function RouteArrow({from,to,index}) {
  const start=new THREE.Vector3(from[0],.1,from[2]),end=new THREE.Vector3(to[0],.1,to[2]),dir=end.clone().sub(start);const len=dir.length();if(len<.01)return null
  dir.normalize();const mid=start.clone().lerp(end,.5);return <group key={index} position={mid} rotation={[0,Math.atan2(dir.x,dir.z),0]}><mesh rotation={[Math.PI/2,0,0]} renderOrder={21}><coneGeometry args={[.1,.28,4]} /><meshBasicMaterial color="#fff0a6" depthTest={false} /></mesh></group>
}
function RoutePreview({points=[]}) {return <group>{points.length>1&&<RoutePreviewLine points={points}/>} {points.slice(0,-1).map((p,i)=><RouteArrow key={i} from={p} to={points[i+1]} index={i}/>)}</group>}

export function MainViewport(props) {
  const editorCamera = props.editorCameraData || {}
  const cameraSettings = props.cameraView
    ? { position: props.cameraData.position, rotation: props.cameraData.rotation, fov: 42, near: 0.05, far: 200 }
    : {
        position: editorCamera.position || [8.5, 6.4, 9.5],
        ...(editorCamera.rotation ? { rotation: editorCamera.rotation } : {}),
        fov: 42,
        near: 0.05,
        far: 200,
      }
  const cameraRef=useRef(null)
  const canvasRef=useRef(null)
  const pathRef=useRef(null)
  const routeOverlayRef=useRef(null)
  const [routePreviewScreen,setRoutePreviewScreen]=useState([])
  const [routeOverlaySize,setRouteOverlaySize]=useState({width:1,height:1})
  const [routeDragIndex,setRouteDragIndex]=useState(null)
  const projectRoutePoints = useCallback(points => {
    const overlay=routeOverlayRef.current
    const camera=cameraRef.current
    if(!overlay || !camera)return []
    const rect=overlay.getBoundingClientRect()
    camera.updateMatrixWorld?.()
    return points.map(point => {
      const projected=new THREE.Vector3(point[0],point[1],point[2]).project(camera)
      return [(projected.x+1)*0.5*rect.width,(1-projected.y)*0.5*rect.height]
    })
  },[])
  const worldPointFromScreen = useCallback((event => {
    const overlay=routeOverlayRef.current
    const camera=cameraRef.current
    if(!overlay || !camera)return null
    const rect=overlay.getBoundingClientRect()
    const x=event.clientX-rect.left
    const y=event.clientY-rect.top
    const pointer=new THREE.Vector2(x/rect.width*2-1,-y/rect.height*2+1)
    const ray=new THREE.Raycaster()
    ray.setFromCamera(pointer,camera)
    const hit=new THREE.Vector3()
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit) ? hit.toArray() : null
  }),[])
  const editableRouteScreen=props.routeEditMode ? projectRoutePoints(props.routePoints||[]) : []
  useEffect(() => {
    if(!props.drawRoute || props.cameraView){setRoutePreviewScreen([]);pathRef.current=null;return undefined}
    const overlay=routeOverlayRef.current
    if(!overlay)return undefined
    const sampleAt=event=>{
      const rect=overlay.getBoundingClientRect()
      if(!rect.width||!rect.height)return null
      const x=event.clientX-rect.left,y=event.clientY-rect.top
      const nx=x/rect.width,ny=y/rect.height
      const pointer=new THREE.Vector2(nx*2-1,-ny*2+1)
      let world=null
      if(cameraRef.current){
        const ray=new THREE.Raycaster();ray.setFromCamera(pointer,cameraRef.current)
        const hit=new THREE.Vector3();world=ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),hit)
      }
      // Keep drawing usable even during the first render before the editor camera is ready.
      if(!world)world=new THREE.Vector3((nx-.5)*12,0,(ny-.5)*-12)
      return {world:world.toArray(),screen:[x,y],size:{width:rect.width,height:rect.height}}
    }
    const onDown=event=>{
      if(event.button!==0)return
      const sample=sampleAt(event);if(!sample)return
      pathRef.current={id:'mouse',points:[sample.world]}
      setRouteOverlaySize(sample.size);setRoutePreviewScreen([sample.screen])
      event.preventDefault()
    }
    const onMove=event=>{
      const route=pathRef.current;if(!route||route.id!=='mouse'||!event.buttons)return
      const sample=sampleAt(event);if(!sample)return
      const last=route.points.at(-1)
      if(Math.hypot(sample.world[0]-last[0],sample.world[2]-last[2])>.12){route.points.push(sample.world);setRouteOverlaySize(sample.size);setRoutePreviewScreen(current=>[...current,sample.screen])}
    }
    const onUp=event=>{
      const route=pathRef.current;if(!route||route.id!=='mouse')return
      pathRef.current=null;event.preventDefault();props.onCompleteRoute?.(route.points)
    }
    const onCancel=()=>{pathRef.current=null}
    const onContextMenu=event=>event.preventDefault()
    overlay.addEventListener('mousedown',onDown);window.addEventListener('mousemove',onMove);window.addEventListener('mouseup',onUp);window.addEventListener('blur',onCancel);overlay.addEventListener('contextmenu',onContextMenu)
    return()=>{overlay.removeEventListener('mousedown',onDown);window.removeEventListener('mousemove',onMove);window.removeEventListener('mouseup',onUp);window.removeEventListener('blur',onCancel);overlay.removeEventListener('contextmenu',onContextMenu);pathRef.current=null}
  },[props.drawRoute,props.cameraView,props.onCompleteRoute])
  useEffect(() => {
    if(!props.routeEditMode || routeDragIndex===null)return undefined
    const move=event=>{
      const point=worldPointFromScreen(event)
      if(!point)return
      props.onUpdateRoutePoint?.(routeDragIndex,point)
    }
    const up=()=>setRouteDragIndex(null)
    window.addEventListener('mousemove',move)
    window.addEventListener('mouseup',up)
    return()=>{window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up)}
  },[props.routeEditMode,routeDragIndex,worldPointFromScreen,props.onUpdateRoutePoint])
  const svgPoints=routePreviewScreen.map(([x,y])=>`${x},${y}`).join(' ')
  const editSvgPoints=editableRouteScreen.map(([x,y])=>`${x},${y}`).join(' ')
  return (
    <div className="route-canvas-wrapper" style={{touchAction:props.drawRoute?'none':'auto',cursor:props.drawRoute?'crosshair':'auto'}}>
    <Canvas style={{pointerEvents:props.drawRoute?'none':'auto'}} shadows="basic" dpr={[1, 1.75]} camera={cameraSettings} onCreated={({gl,camera})=>{canvasRef.current=gl.domElement;cameraRef.current=camera}} onPointerMissed={() => {if(!props.drawRoute)props.onSelect(null)}} gl={{ alpha: true, antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.88 }}>
      <EditorScene {...props} />
      {props.routePoints?.length > 1 && <RoutePreview points={props.routePoints} />}
    </Canvas>
    {props.drawRoute && <div ref={routeOverlayRef} className="route-input-overlay"><svg className="route-preview-svg" width="100%" height="100%" viewBox={`0 0 ${routeOverlaySize.width} ${routeOverlaySize.height}`} preserveAspectRatio="none"><defs><marker id="route-arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#fff0a6" /></marker></defs><polyline points={props.routeEditMode ? editSvgPoints : svgPoints} fill="none" stroke="#ffe17e" strokeWidth="3" strokeDasharray="10 7" strokeLinecap="round" strokeLinejoin="round" markerMid="url(#route-arrowhead)" markerEnd="url(#route-arrowhead)" />{!props.routeEditMode&&<><circle cx={routePreviewScreen[0]?.[0]||0} cy={routePreviewScreen[0]?.[1]||0} r="5" fill="#fff0a6" /><circle cx={routePreviewScreen.at(-1)?.[0]||0} cy={routePreviewScreen.at(-1)?.[1]||0} r="4" fill="#ffe17e" /></>}{props.routeEditMode&&editableRouteScreen.map(([x,y],index)=><circle key={index} cx={x} cy={y} r={index===0||index===editableRouteScreen.length-1?6:5} className="route-edit-handle" onMouseDown={event=>{event.preventDefault();event.stopPropagation();setRouteDragIndex(index)}} />)}</svg></div>}
    </div>
  )
}

export function CameraPreview({ objects, cameraData, cameraAspect, lighting, backgroundCanvas = null, animationTime = 0, onCanvasReady, exportMode = false }) {
  return (
    <Canvas
      shadows="basic"
      dpr={exportMode ? 1 : [1, 1.5]}
      camera={{ position: cameraData.position, fov: 40, aspect: cameraAspect, near: 0.05, far: 200 }}
      gl={{ antialias: true, preserveDrawingBuffer: exportMode || Boolean(onCanvasReady), toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 0.9 }}
      onCreated={({ gl }) => onCanvasReady?.(gl.domElement)}
    >
      <PreviewScene objects={objects} cameraData={cameraData} cameraAspect={cameraAspect} lighting={lighting} backgroundCanvas={backgroundCanvas} animationTime={animationTime} />
    </Canvas>
  )
}
