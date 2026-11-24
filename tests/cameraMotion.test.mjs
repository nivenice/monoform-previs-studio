import test from 'node:test'
import assert from 'node:assert/strict'
import { shotPreset, solveFollowCamera, solveSubjectCamera } from '../src/cameraMotion.js'

test('follow camera re-solves position and rotation from actor frame state', () => {
  const camera = solveFollowCamera({ position: [0, 0, 0], rotation: [0, 0, 0] }, { aspectRatio: '16:9' }, { shot: 'medium' })
  const moved = solveFollowCamera({ position: [4, 0, -2], rotation: [0, Math.PI / 2, 0] }, { aspectRatio: '16:9' }, { shot: 'medium' })
  assert.notDeepEqual(camera.position, moved.position)
  assert.notDeepEqual(camera.rotation, moved.rotation)
  assert.equal(camera.focalLength, shotPreset('medium').focalLength)
})

test('shot presets carry predictable focal length and distance', () => {
  assert.ok(shotPreset('wide').distance > shotPreset('close').distance)
  assert.ok(shotPreset('wide').focalLength < shotPreset('close').focalLength)
})

test('front follow has level horizon and camera can orbit to back without losing target', () => {
  const actor = {position:[2,0,-3],rotation:[0,Math.PI/2,0]}
  const front = solveFollowCamera(actor,{aspectRatio:'16:9'},{shot:'medium',distance:5,orbitDegrees:0,sideOffset:0})
  const back = solveFollowCamera(actor,{aspectRatio:'16:9'},{shot:'medium',distance:5,orbitDegrees:180,sideOffset:0})
  assert.ok(Math.abs(front.position[0]-7)<1e-6)
  assert.ok(Math.abs(back.position[0]+3)<1e-6)
  assert.equal(front.rotation[2],0)
  assert.equal(back.rotation[2],0)
  assert.ok(Number.isFinite(back.rotation[0]) && Number.isFinite(back.rotation[1]))
})

test('follow distance changes radius even with a saved legacy offset; lateral offset moves framing', () => {
  const actor={position:[0,0,0],rotation:[0,0,0]}
  const near=solveFollowCamera(actor,{}, {distance:3,offset:[0,2,5],sideOffset:0})
  const far=solveFollowCamera(actor,{}, {distance:8,offset:[0,2,5],sideOffset:1})
  assert.equal(near.position[2],3)
  assert.equal(far.position[2],8)
  assert.equal(far.position[0],1)
})

test('follow framing scales with subject height, including elevated roots', () => {
  const base={position:[0,2,0],rotation:[0,0,0],scale:[1,1,1],bodyType:'standard'}
  const tall={...base,scale:[1,3,1]}
  const a=solveFollowCamera(base,{}, {shot:'medium',distance:5.2,height:2.8,lookHeight:1.25})
  const b=solveFollowCamera(tall,{}, {shot:'medium',distance:5.2,height:2.8,lookHeight:1.25})
  assert.ok(Math.abs((b.position[2]-tall.position[2])/(a.position[2]-base.position[2])-3)<1e-6)
  assert.ok(Math.abs((b.position[1]-tall.position[1])/(a.position[1]-base.position[1])-3)<1e-6)
  assert.equal(a.position[1],2+2.8)
})

test('subject framing puts 0° in front, 90° on the subject left and stays fixed while the subject turns', () => {
  const actor = { position: [1, 0, -2], rotation: [0, 0, 0] }
  const front = solveSubjectCamera(actor, { azimuthDegrees: 0, distance: 4, height: 1.6, lookHeight: 1.2, focalLength: 45 })
  assert.equal(front.position[0], 1)
  assert.equal(front.position[1], 1.6)
  assert.equal(front.position[2], 2)
  assert.ok(Math.abs(front.rotation[0] - Math.atan2(-0.4, 4)) < 1e-6)

  const left = solveSubjectCamera(actor, { azimuthDegrees: 90, distance: 4, height: 1.6, lookHeight: 1.2 })
  assert.ok(Math.abs(left.position[0] - 5) < 1e-9)
  assert.ok(Math.abs(left.position[2] + 2) < 1e-9)

  const turned = solveSubjectCamera({ ...actor, rotation: [0, Math.PI / 2, 0] }, { azimuthDegrees: 0, distance: 4 })
  assert.ok(Math.abs(turned.position[0] - 5) < 1e-9)
  assert.equal(turned.focalLength, 45)
  assert.equal(turned.aspectRatio, '16:9')

  const clamped = solveSubjectCamera(actor, { distance: 0.1, focalLength: 400, height: 99, lookHeight: 99 })
  assert.equal(clamped.position[1], 20)
  assert.equal(clamped.focalLength, 120)
  assert.ok(Math.abs(clamped.position[2] + 1.2) < 1e-9)
})
