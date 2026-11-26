// 人物体型只有两种：带骨骼的标准人物，以及静态占位的极简模型。
// 旧工程里的 tall / broad / female / male 都按标准人物打开，避免升级后工程失效。
export const BODY_TYPE_STANDARD = 'standard'
export const BODY_TYPE_MINIMAL = 'minimal'

export const PERSON_BODY_TYPES = [
  [BODY_TYPE_STANDARD, '标准人物'],
  [BODY_TYPE_MINIMAL, '极简模型'],
]

export const normalizeBodyType = value =>
  String(value ?? '').toLowerCase() === BODY_TYPE_MINIMAL ? BODY_TYPE_MINIMAL : BODY_TYPE_STANDARD

export const isMinimalBody = object => normalizeBodyType(object?.bodyType) === BODY_TYPE_MINIMAL

export const isRiggedPerson = object =>
  object?.type === 'person' && normalizeBodyType(object?.bodyType) === BODY_TYPE_STANDARD
