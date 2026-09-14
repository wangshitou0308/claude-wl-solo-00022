import { z } from 'zod';

/** 压脚杆制式 */
export const STANDARDS = ['low_shank', 'high_shank', 'slant_shank', 'snap_on'] as const;

const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const machineCreateSchema = z.object({
  code: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  /** 压脚杆制式 */
  presserBarStandard: z.enum(STANDARDS),
  /** 针位范围（mm，相对针板中心，横向） */
  needleRangeMm: z
    .object({ min: z.number().finite(), max: z.number().finite() })
    .refine((r) => r.max >= r.min, { message: 'needleRangeMm.max 必须不小于 min' }),
  /** 最大摆幅（mm） */
  maxSwingMm: z.number().positive().max(20),
  /** 送料方式，如 drop_feed / walking_foot_feed 等，由调用方约定 */
  feedMode: z.string().trim().min(1).max(40),
});

export type MachineCreate = z.infer<typeof machineCreateSchema>;

const contourSchema = z
  .array(pointSchema)
  .min(3, '开口轮廓至少需要 3 个顶点')
  .max(200);

const compatFields = {
  /** 安装高度名义值（mm）：压脚为柄高，针板为板面相对针板座高度 */
  mountingHeightMm: z.number().finite().min(-50).max(100),
  /** 尺寸误差（mm，±），同时作用于开口轮廓与安装高度 */
  toleranceMm: z.number().min(0).max(5).default(0.1),
  /** 适用针型，如 ["90/14", "universal"] */
  needleTypes: z.array(z.string().trim().min(1)).min(1).max(50),
  /** 允许线迹，如 ["straight", "zigzag"] */
  allowedStitches: z.array(z.string().trim().min(1)).min(1).max(50),
  /** 适用送料方式；缺省或空数组表示不限 */
  feedModes: z.array(z.string().trim().min(1)).max(20).optional(),
};

const codeField = z.string().trim().min(1).max(64).optional();
const nameField = z.string().trim().min(1).max(120).optional();

export const accessoryCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('foot'),
    code: codeField,
    name: nameField,
    /** 压脚安装柄的制式 */
    mountStandard: z.enum(STANDARDS),
    /** 针孔/槽开口轮廓（多边形顶点，mm） */
    openingContour: contourSchema,
    ...compatFields,
  }),
  z.object({
    kind: z.literal('plate'),
    code: codeField,
    name: nameField,
    openingContour: contourSchema,
    ...compatFields,
  }),
  z.object({
    kind: z.literal('adapter'),
    code: codeField,
    name: nameField,
    fromStandard: z.enum(STANDARDS),
    toStandard: z.enum(STANDARDS),
    /** 转换柄引入的高度修正（mm） */
    heightOffsetMm: z.number().finite().min(-50).max(50).default(0),
    toleranceMm: z.number().min(0).max(5).default(0.1),
  }),
]);

export type AccessoryCreate = z.infer<typeof accessoryCreateSchema>;

export const trialFitCreateSchema = z.object({
  machineId: z.string().min(1),
  /** 本次线迹，如 "zigzag" */
  stitch: z.string().trim().min(1).max(40),
  /** 针型，如 "90/14"；无法解析针径时需提供 needleDiameterMm */
  needleType: z.string().trim().min(1).max(60),
  needleDiameterMm: z.number().positive().max(2).optional(),
  /** 连续针路（落针点序列，mm，相对针板中心） */
  needlePath: z.array(pointSchema).min(1).max(1000),
});

export type TrialFitCreate = z.infer<typeof trialFitCreateSchema>;

export const sessionCreateSchema = trialFitCreateSchema.extend({
  footId: z.string().min(1),
  plateId: z.string().min(1),
  adapterIds: z.array(z.string().min(1)).max(2).default([]),
});

export type SessionCreate = z.infer<typeof sessionCreateSchema>;

/** 试装会话步骤（顺序固定） */
export const SESSION_STEPS = [
  'power_off', // 断电
  'needle_up', // 抬针
  'swap_parts', // 换件
  'handwheel_full_turn', // 手轮完整转一周
  'low_speed_sew', // 低速试缝（通电步骤）
] as const;

export type SessionStep = (typeof SESSION_STEPS)[number];

export const confirmStepSchema = z.object({
  step: z.enum(SESSION_STEPS),
});
