// Builds the compact, read-only rig snapshot handed to the animator subagent.
// It deliberately keeps the object transform, camera and keyframe bookkeeping
// out of the payload: the subagent only needs the target, the joint state and
// the frame range it is allowed to write.
import { JOINT_GROUPS, RIG_BONE_PARENTS, RIG_PRESETS, presetJoints } from './rig.js'
import { SceneCommandError } from './agentSceneCommands.js'
import { readCharacterState, resolveRange, toDegrees } from './rigAgentCommands.js'

const MAX_CONTEXT_LENGTH = 15000
const REFERENCE_POSES = ['aim_pistol', 'crouch', 'squat_full']

const referencePoses = () => REFERENCE_POSES
  .filter(id => RIG_PRESETS[id])
  .map(id => ({
    id,
    label: RIG_PRESETS[id].label,
    jointsDegrees: toDegrees(presetJoints(id)),
  }))

const poseList = () => Object.entries(RIG_PRESETS).map(([id, preset]) => ({
  id,
  label: preset.label,
  clip: preset.clip || null,
  phase: preset.phase,
  loopable: Boolean(preset.loopable && preset.duration > 0),
}))

const boneGroups = () => JOINT_GROUPS.map(group => ({
  group: group.label,
  bones: group.joints.map(joint => ({
    id: joint.id,
    label: joint.label,
    parent: RIG_BONE_PARENTS[joint.id] || null,
  })),
}))

export function buildRigAgentContext(state, person, options = {}) {
  const { startFrame, endFrame } = options
  const range = resolveRange(state, startFrame, endFrame)
  const read = readCharacterState(state, person.id)
  const context = {
    target: read.target,
    timeline: read.timeline,
    range: { startFrame: range.start, endFrame: range.end, totalFrames: range.totalFrames },
    ...(options.basePose ? { basePoseHint: String(options.basePose) } : {}),
    base: read.base,
    current: read.current,
    keyframes: read.keyframes.slice(-24),
    poses: poseList(),
    customPoses: (Array.isArray(state.customPoses) ? state.customPoses : []).map(item => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
    })).filter(item => item.id && item.name),
    referencePoses: referencePoses(),
    bones: boneGroups(),
    conventions: {
      up: 'Y',
      forwardAtYaw0: '+Z',
      angleUnit: 'degree',
      rotation: 'additive local Euler XYZ, multiplied on top of the clip sampled at poseTime',
      interpolation: 'same pose clip and same poseTime are required for smooth joint interpolation',
    },
    limits: {
      maxFramesPerCall: 24,
      maxRounds: 5,
      startFrame: range.start,
      endFrame: range.end,
    },
  }
  let json = JSON.stringify(context)
  if (json.length > MAX_CONTEXT_LENGTH) {
    context.keyframes = context.keyframes.slice(-8)
    json = JSON.stringify(context)
  }
  if (json.length > MAX_CONTEXT_LENGTH) {
    context.keyframes = []
    delete context.referencePoses
    json = JSON.stringify(context)
  }
  if (json.length > MAX_CONTEXT_LENGTH) {
    delete context.customPoses
    context.bones = context.bones.map(group => ({
      group: group.group,
      bones: group.bones.map(bone => ({ id: bone.id, label: bone.label })),
    }))
    json = JSON.stringify(context)
  }
  if (json.length > MAX_CONTEXT_LENGTH) {
    throw new SceneCommandError('角色状态过大，无法交给骨骼动画师；请先清理关键帧或减少自定义姿势')
  }
  return { json, context, range }
}
