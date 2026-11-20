import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { MINIMAL_FACE_STYLE, MINIMAL_PERSON_DIMENSIONS, fitFaceTextSize, normalizeFaceText } from './minimalPerson.js'

const DIMENSIONS = MINIMAL_PERSON_DIMENSIONS
const FACE_HALF_ANGLE = THREE.MathUtils.degToRad(DIMENSIONS.faceHalfAngleDegrees)
const HEAD_CENTER_Y = DIMENSIONS.bodyHeight - DIMENSIONS.headOverlap + DIMENSIONS.headRadius
const FACE_RADIUS = DIMENSIONS.headRadius * DIMENSIONS.faceSurfaceScale
const FACE_PHI_START = Math.PI / 2 - FACE_HALF_ANGLE
const FACE_PHI_LENGTH = FACE_HALF_ANGLE * 2
const FACE_THETA_START = Math.PI / 2 - FACE_HALF_ANGLE
const FACE_THETA_LENGTH = FACE_HALF_ANGLE * 2
const FACE_FONT_FAMILY = '"Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif'
const faceFont = size => `700 ${size}px ${FACE_FONT_FAMILY}`

function createFaceTexture(faceText) {
  const size = MINIMAL_FACE_STYLE.canvasSize
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = MINIMAL_FACE_STYLE.panelColor
  context.fillRect(0, 0, size, size)
  context.strokeStyle = MINIMAL_FACE_STYLE.rimColor
  context.lineWidth = MINIMAL_FACE_STYLE.rimWidth
  const inset = MINIMAL_FACE_STYLE.rimInset + MINIMAL_FACE_STYLE.rimWidth / 2
  context.strokeRect(inset, inset, size - inset * 2, size - inset * 2)
  const label = normalizeFaceText(faceText)
  if (label) {
    const measure = (text, fontSize) => {
      context.font = faceFont(fontSize)
      return context.measureText(text).width
    }
    const fontSize = fitFaceTextSize(label, measure, size * MINIMAL_FACE_STYLE.maxTextWidthRatio)
    context.font = faceFont(fontSize)
    context.fillStyle = MINIMAL_FACE_STYLE.inkColor
    context.textAlign = 'center'
    context.textBaseline = 'alphabetic'
    const metrics = context.measureText(label)
    const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.72
    const descent = metrics.actualBoundingBoxDescent || fontSize * 0.18
    context.fillText(label, size / 2, size / 2 + (ascent - descent) / 2)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

export function MinimalPersonModel({ color = '#e8e3d8', faceText = '', selected = false }) {
  const faceTexture = useMemo(() => createFaceTexture(faceText), [faceText])
  useEffect(() => () => faceTexture?.dispose(), [faceTexture])
  const materialProps = {
    color: color || '#e8e3d8',
    roughness: 0.78,
    metalness: 0.02,
    emissive: selected ? '#312813' : '#000000',
    emissiveIntensity: selected ? 0.22 : 0,
  }
  return (
    <group>
      <mesh castShadow receiveShadow position={[0, DIMENSIONS.bodyHeight / 2, 0]}>
        <cylinderGeometry args={[DIMENSIONS.bodyRadius, DIMENSIONS.bodyRadius, DIMENSIONS.bodyHeight, 32]} />
        <meshStandardMaterial {...materialProps} />
      </mesh>
      <mesh castShadow receiveShadow position={[0, HEAD_CENTER_Y, 0]}>
        <sphereGeometry args={[DIMENSIONS.headRadius, 32, 24]} />
        <meshStandardMaterial {...materialProps} />
      </mesh>
      <mesh position={[0, HEAD_CENTER_Y, 0]}>
        <sphereGeometry args={[FACE_RADIUS, 32, 24, FACE_PHI_START, FACE_PHI_LENGTH, FACE_THETA_START, FACE_THETA_LENGTH]} />
        <meshStandardMaterial color={faceTexture ? '#ffffff' : MINIMAL_FACE_STYLE.panelColor} map={faceTexture || null} roughness={0.85} metalness={0} />
      </mesh>
    </group>
  )
}
