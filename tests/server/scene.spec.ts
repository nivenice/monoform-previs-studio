import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePerspectiveResponse,
  normalizeScene,
  repairSceneGeometry,
  validateSceneStructure,
} from '../../server/scene'

function validRaw(): any {
  return {
    version: 2,
    title: '场景',
    walls: [],
    rooms: [],
    creations: [{ id: 'c1', a: { x: 0, y: 0 }, b: { x: 2, y: 3 }, baseZ: 0, height: 2, color: '#dddddd' }],
    actors: [],
    props: [],
    lights: [],
    sun: { enabled: true, visible: false, azimuth: 308, elevation: 53 },
    groundColor: '#e5e5e5',
    roofEnabled: false,
    previs: {
      camera: { position: [0, -8, 3], target: [0, 0, 1], fov: 45 },
      imageComposition: { aspect: '16:9', groundLine: 0.65, horizonY: 0.45 },
      evidence: [{ name: '主要结构', parts: ['c1'], screen: { bbox: [0, 0, 100, 100] } }],
    },
  }
}

test('normalizeScene unwraps workflow.scene and fills defaults', () => {
  const longTitle = '长'.repeat(100)
  const scene = normalizeScene({ workflow: { scene: { title: longTitle } } })
  assert.equal(scene.version, 2)
  assert.equal(scene.title.length, 80)
  assert.deepEqual(scene.walls, [])
  assert.deepEqual(scene.creations, [])
  assert.equal(scene.groundColor, '#e5e5e5')
  assert.equal(scene.roofEnabled, false)
  assert.deepEqual(scene.sun, { enabled: true, visible: false, azimuth: 308, elevation: 53 })
})

test('normalizeScene also unwraps a direct scene property', () => {
  const scene = normalizeScene({ scene: { title: '直接' } })
  assert.equal(scene.title, '直接')
})

test('normalizeScene rejects non-objects', () => {
  assert.throws(() => normalizeScene('not a scene'), /不是场景对象/)
})

test('a valid perspective scene has no warnings', () => {
  const { scene, warnings } = normalizePerspectiveResponse(validRaw())
  assert.equal(warnings.length, 0)
  assert.equal(scene.creations.length, 1)
})

test('missing camera or main evidence is rejected instead of replacing the project', () => {
  const noCamera = validRaw()
  delete noCamera.previs.camera
  assert.throws(() => normalizePerspectiveResponse(noCamera), /缺少相机或主体结构证据/)

  const noEvidence = validRaw()
  noEvidence.previs.evidence = []
  assert.throws(() => normalizePerspectiveResponse(noEvidence), /缺少相机或主体结构证据/)
})

test('missing imageComposition stays a review warning', () => {
  const raw = validRaw()
  delete raw.previs.imageComposition
  const { warnings } = normalizePerspectiveResponse(raw)
  assert.ok(warnings.some(warning => warning.includes('缺少 imageComposition')))
})

test('structure validation reports duplicate ids, bad rectangles and heights', () => {
  const raw = validRaw()
  raw.walls = [{ id: 'c1', a: { x: -1, y: 0 }, b: { x: 1, y: 0 }, height: 2 }]
  raw.creations = [{ id: 'c1', a: { x: 5, y: 0 }, b: { x: 1, y: 2 }, baseZ: 0, height: 99 }]
  const warnings = validateSceneStructure(normalizeScene(raw))
  assert.ok(warnings.some(warning => warning.includes('ID重复')))
  assert.ok(warnings.some(warning => warning.includes('不是有效矩形')))
  assert.ok(warnings.some(warning => warning.includes('高度必须')))
})

test('floating blocks, unknown evidence parts and missing bbox are warnings', () => {
  const raw = validRaw()
  raw.creations.push({ id: 'c2', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, baseZ: 3, height: 1 })
  raw.previs.evidence = [{ name: '主要结构', parts: ['c1', 'missing'], screen: {} }]
  const warnings = validateSceneStructure(normalizeScene(raw))
  assert.ok(warnings.some(warning => warning.includes('悬空')))
  assert.ok(warnings.some(warning => warning.includes('引用了不存在的部件')))
  assert.ok(warnings.some(warning => warning.includes('缺少 screen.bbox')))
})

test('non-object creations are reported and skipped', () => {
  const raw = validRaw()
  raw.creations = [null, 'broken']
  const warnings = validateSceneStructure(normalizeScene(raw))
  assert.equal(warnings.filter(warning => warning.includes('非对象项')).length, 1)
})

test('geometry repair widens proxies and records corrections', () => {
  const raw = validRaw()
  raw.creations = [{ id: 'c1', a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, baseZ: 0, height: 0 }]
  const { scene, warnings } = normalizePerspectiveResponse(raw)
  assert.equal(warnings.length, 0)
  assert.deepEqual(scene.previs?.corrections, [
    'c1.b.x: zero-width proxy widened to 0.5',
    'c1.b.y: zero-depth proxy widened to 0.5',
    'c1.height: non-positive proxy raised to 0.5',
  ])
  assert.equal((scene.creations[0] as any).b.x, 0.5)
  assert.equal((scene.creations[0] as any).b.y, 0.5)
  assert.equal((scene.creations[0] as any).height, 0.5)
})

test('repairSceneGeometry returns an empty list for valid geometry', () => {
  const scene = normalizeScene(validRaw())
  assert.deepEqual(repairSceneGeometry(scene), [])
})
