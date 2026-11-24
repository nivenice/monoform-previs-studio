import test from 'node:test'
import assert from 'node:assert/strict'
import { JOINT_DEFINITIONS, RIG_PRESETS, normalizePoseId, poseCanLoop, presetJoints, presetPhase, presetRoot } from '../src/rig.js'

const jointIds = new Set(JOINT_DEFINITIONS.map(joint => joint.id))

test('the aim pistol preset is a real, loopable pose with arm-only offsets', () => {
  assert.equal(normalizePoseId('aim_pistol'), 'aim_pistol')
  assert.equal(RIG_PRESETS.aim_pistol.label, '举枪瞄准')
  assert.equal(RIG_PRESETS.aim_pistol.clip, 'idle')
  assert.equal(poseCanLoop('aim_pistol'), true)
  assert.equal(presetPhase('aim_pistol'), 0.08)
  assert.deepEqual(presetRoot('aim_pistol'), [0, 0, 0])

  const joints = presetJoints('aim_pistol')
  for (const id of Object.keys(RIG_PRESETS.aim_pistol.joints)) {
    assert.ok(jointIds.has(id), `${id} must be a known skeleton joint`)
  }
  // The aiming arm reaches at the lens and the torso blades towards it.
  assert.ok(Math.hypot(...joints.mixamorigRightArm) > 0.3)
  assert.ok(Math.abs(joints.mixamorigSpine1[1]) > 0.1)
  assert.ok(Math.sign(joints.mixamorigHead[1]) !== Math.sign(joints.mixamorigSpine1[1]))
  // The support arm and the legs stay on the neutral idle deltas so the
  // silhouette reads as a standing aim rather than a two-handed crouch.
  assert.deepEqual(joints.mixamorigLeftArm, [0, 0, 0])
  assert.deepEqual(joints.mixamorigLeftForeArm, [0, 0, 0])
  assert.deepEqual(joints.mixamorigLeftUpLeg, [0, 0, 0])
})

test('every preset points at a baked clip or the bind pose', () => {
  for (const [id, preset] of Object.entries(RIG_PRESETS)) {
    assert.equal(normalizePoseId(id), id)
    assert.ok(preset.label.length > 0)
    assert.ok(preset.clip === null || typeof preset.clip === 'string')
    assert.ok(preset.phase >= 0 && preset.phase <= 1)
  }
})
