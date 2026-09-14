import { pathSegmentClearances, type Pt } from './geometry.js';

export type Standard = 'low_shank' | 'high_shank' | 'slant_shank' | 'snap_on';

/** 各压脚杆制式的名义安装高度（mm） */
export const STANDARD_HEIGHT_MM: Record<Standard, number> = {
  low_shank: 12.7,
  high_shank: 25.4,
  slant_shank: 16.5,
  snap_on: 12.7,
};

/** 机器侧安装接口的固有公差（mm） */
export const MACHINE_INTERFACE_TOLERANCE_MM = 0.2;
/** 针板座名义高度（mm），以机器针板座平面为 0 */
export const PLATE_SEAT_HEIGHT_MM = 0;
/** 转换柄串联的最大节数 */
export const MAX_ADAPTERS = 2;

export interface MachineRec {
  id: string;
  code: string;
  name?: string;
  presserBarStandard: Standard;
  needleRangeMm: { min: number; max: number };
  maxSwingMm: number;
  feedMode: string;
  version: number;
}

interface AccessoryBase {
  id: string;
  code: string;
  name?: string;
  version: number;
}

export interface FootRec extends AccessoryBase {
  kind: 'foot';
  mountStandard: Standard;
  openingContour: Pt[];
  mountingHeightMm: number;
  toleranceMm: number;
  needleTypes: string[];
  allowedStitches: string[];
  feedModes?: string[];
}

export interface PlateRec extends AccessoryBase {
  kind: 'plate';
  openingContour: Pt[];
  mountingHeightMm: number;
  toleranceMm: number;
  needleTypes: string[];
  allowedStitches: string[];
  feedModes?: string[];
}

export interface AdapterRec extends AccessoryBase {
  kind: 'adapter';
  fromStandard: Standard;
  toStandard: Standard;
  heightOffsetMm: number;
  toleranceMm: number;
}

export type AccessoryRec = FootRec | PlateRec | AdapterRec;

/** 一次试配请求的归一化输入 */
export interface FitRequest {
  stitch: string;
  needleType: string;
  needleRadiusMm: number;
  path: Pt[];
}

export interface CollisionInfo {
  /** 最早发生碰撞的针位下标（针路段起点） */
  earliestNeedleIndex: number;
  /** 碰撞针位坐标 */
  needlePosition: Pt;
  /** 责任边界：哪个配件的哪条轮廓边 */
  responsibleBoundary: {
    accessoryKind: 'foot' | 'plate';
    accessoryId: string;
    accessoryCode: string;
    edgeIndex: number;
  };
  /** 余量（mm，负值表示侵入量） */
  marginMm: number;
}

export interface ComboFailure {
  reason:
    | 'mount_chain_missing'
    | 'mount_chain_ambiguous'
    | 'stitch_not_allowed'
    | 'needle_type_incompatible'
    | 'feed_mode_incompatible'
    | 'height_incompatible'
    | 'envelope_collision';
  message: string;
  accessoryId?: string;
  accessoryKind?: string;
  collision?: CollisionInfo;
}

export interface ComboMetrics {
  adapterCount: number;
  /** 安装链上最大的高度偏差（mm） */
  maxHeightDeviationMm: number;
  /** 压脚/针板两者中的最小净距（mm，已扣除针半径与公差） */
  minClearanceMm: number;
  footClearanceMm: number;
  plateClearanceMm: number;
}

export type EvalResult =
  | { ok: true; metrics: ComboMetrics }
  | { ok: false; failures: ComboFailure[] };

const r4 = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * 从针型字符串解析针径（mm）。
 * 支持 "90/14"、"NM 90"、"90" 等常见写法；NM 号即针径的 100 倍。
 */
export function parseNeedleDiameterMm(needleType: string): number | null {
  const m =
    /(\d{2,3})\s*\/\s*\d{1,2}/.exec(needleType) ??
    /(?:nm|NM)\s*(\d{2,3})/.exec(needleType) ??
    /^(\d{2,3})$/.exec(needleType.trim());
  if (!m) return null;
  const nm = Number(m[1]);
  if (nm < 60 || nm > 130) return null;
  return nm / 100;
}

/**
 * 在配件库中搜索机器制式 -> 压脚制式的转换链（0..MAX_ADAPTERS 节）。
 * 返回所有不同的链；试配要求链唯一（恰好一条）。
 */
export function findAdapterChains(
  from: Standard,
  to: Standard,
  adapters: AdapterRec[],
  maxLen: number = MAX_ADAPTERS,
): AdapterRec[][] {
  const results: AdapterRec[][] = [];
  const seen = new Set<string>();
  const queue: Array<{ std: Standard; chain: AdapterRec[] }> = [{ std: from, chain: [] }];
  while (queue.length > 0) {
    const { std, chain } = queue.shift()!;
    if (std === to) {
      const key = chain.map((a) => a.id).join('|');
      if (!seen.has(key)) {
        seen.add(key);
        results.push(chain);
      }
      continue; // 到达目标即停，不再绕环
    }
    if (chain.length >= maxLen) continue;
    for (const a of adapters) {
      if (a.fromStandard !== std) continue;
      if (chain.some((u) => u.id === a.id)) continue;
      queue.push({ std: a.toStandard, chain: [...chain, a] });
    }
  }
  return results;
}

/** 校验针路是否落在机器能力范围内（针位范围 + 最大摆幅） */
export function checkMachineEnvelope(
  machine: MachineRec,
  path: Pt[],
): { ok: true } | { ok: false; reason: string; details: Record<string, number> } {
  const xs = path.map((p) => p.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  if (minX < machine.needleRangeMm.min - 1e-9 || maxX > machine.needleRangeMm.max + 1e-9) {
    return {
      ok: false,
      reason: 'path_out_of_needle_range',
      details: {
        pathMinXmm: r4(minX),
        pathMaxXmm: r4(maxX),
        machineMinXmm: machine.needleRangeMm.min,
        machineMaxXmm: machine.needleRangeMm.max,
      },
    };
  }
  const swing = maxX - minX;
  if (swing > machine.maxSwingMm + 1e-9) {
    return {
      ok: false,
      reason: 'path_exceeds_max_swing',
      details: { pathSwingMm: r4(swing), machineMaxSwingMm: machine.maxSwingMm },
    };
  }
  return { ok: true };
}

/**
 * 评估一个“压脚 + 针板 + 转换链”组合。
 * 尺寸一律按区间最不利端判定：开口轮廓向内收缩公差、安装高度取区间端点。
 */
export function evaluateCombination(
  machine: MachineRec,
  foot: FootRec,
  plate: PlateRec,
  adapters: AdapterRec[],
  req: FitRequest,
): EvalResult {
  const failures: ComboFailure[] = [];

  // —— 线迹 / 针型 / 送料方式相容性 ——
  for (const acc of [foot, plate] as const) {
    if (!acc.allowedStitches.includes(req.stitch)) {
      failures.push({
        reason: 'stitch_not_allowed',
        accessoryId: acc.id,
        accessoryKind: acc.kind,
        message: `配件 ${acc.code} 不允许线迹 "${req.stitch}"`,
      });
    }
    if (!acc.needleTypes.includes(req.needleType)) {
      failures.push({
        reason: 'needle_type_incompatible',
        accessoryId: acc.id,
        accessoryKind: acc.kind,
        message: `配件 ${acc.code} 不适用针型 "${req.needleType}"`,
      });
    }
    if (acc.feedModes && acc.feedModes.length > 0 && !acc.feedModes.includes(machine.feedMode)) {
      failures.push({
        reason: 'feed_mode_incompatible',
        accessoryId: acc.id,
        accessoryKind: acc.kind,
        message: `配件 ${acc.code} 不支持送料方式 "${machine.feedMode}"`,
      });
    }
  }

  // —— 安装高度相容（区间最不利端） ——
  const adapterOffset = adapters.reduce((s, a) => s + a.heightOffsetMm, 0);
  const adapterTol = adapters.reduce((s, a) => s + a.toleranceMm, 0);
  const requiredFootHeight = STANDARD_HEIGHT_MM[machine.presserBarStandard] + adapterOffset;
  const footDeviation = Math.abs(foot.mountingHeightMm - requiredFootHeight);
  const footAllowed = foot.toleranceMm + adapterTol + MACHINE_INTERFACE_TOLERANCE_MM;
  if (footDeviation > footAllowed + 1e-9) {
    failures.push({
      reason: 'height_incompatible',
      accessoryId: foot.id,
      accessoryKind: 'foot',
      message: `压脚 ${foot.code} 安装高度偏差 ${r4(footDeviation)}mm 超出允许 ${r4(footAllowed)}mm`,
    });
  }
  const plateDeviation = Math.abs(plate.mountingHeightMm - PLATE_SEAT_HEIGHT_MM);
  const plateAllowed = plate.toleranceMm + MACHINE_INTERFACE_TOLERANCE_MM;
  if (plateDeviation > plateAllowed + 1e-9) {
    failures.push({
      reason: 'height_incompatible',
      accessoryId: plate.id,
      accessoryKind: 'plate',
      message: `针板 ${plate.code} 安装高度偏差 ${r4(plateDeviation)}mm 超出允许 ${r4(plateAllowed)}mm`,
    });
  }

  // —— 扫掠包络：针路按针半径膨胀后须同时落在压脚与针板开口内 ——
  const footSegs = pathSegmentClearances(req.path, foot.openingContour);
  const plateSegs = pathSegmentClearances(req.path, plate.openingContour);
  const footRequired = req.needleRadiusMm + foot.toleranceMm;
  const plateRequired = req.needleRadiusMm + plate.toleranceMm;
  const footMarginMin = Math.min(...footSegs.map((s) => s.signedClearanceMm)) - footRequired;
  const plateMarginMin = Math.min(...plateSegs.map((s) => s.signedClearanceMm)) - plateRequired;

  if (footMarginMin < 0 || plateMarginMin < 0) {
    // 沿针路顺序找最早碰撞针位
    for (let i = 0; i < footSegs.length; i++) {
      const fm = footSegs[i]!.signedClearanceMm - footRequired;
      const pm = plateSegs[i]!.signedClearanceMm - plateRequired;
      if (fm < 0 || pm < 0) {
        const useFoot = fm <= pm;
        const seg = useFoot ? footSegs[i]! : plateSegs[i]!;
        const acc: FootRec | PlateRec = useFoot ? foot : plate;
        failures.push({
          reason: 'envelope_collision',
          accessoryId: acc.id,
          accessoryKind: acc.kind,
          message: `针路在第 ${i} 针位与${useFoot ? '压脚' : '针板'} ${acc.code} 的开口边界碰撞`,
          collision: {
            earliestNeedleIndex: i,
            needlePosition: seg.point,
            responsibleBoundary: {
              accessoryKind: acc.kind,
              accessoryId: acc.id,
              accessoryCode: acc.code,
              edgeIndex: seg.edgeIndex,
            },
            marginMm: r4(useFoot ? fm : pm),
          },
        });
        break;
      }
    }
  }

  if (failures.length > 0) return { ok: false, failures };

  return {
    ok: true,
    metrics: {
      adapterCount: adapters.length,
      maxHeightDeviationMm: r4(Math.max(footDeviation, plateDeviation)),
      minClearanceMm: r4(Math.min(footMarginMin, plateMarginMin)),
      footClearanceMm: r4(footMarginMin),
      plateClearanceMm: r4(plateMarginMin),
    },
  };
}

export interface Candidate {
  footId: string;
  footCode: string;
  plateId: string;
  plateCode: string;
  adapterIds: string[];
  adapterCodes: string[];
  metrics: ComboMetrics;
}

export interface TrialFitFailure extends ComboFailure {
  footId: string;
  footCode: string;
  plateId: string;
  plateCode: string;
  adapterIds: string[];
}

export interface TrialFitResult {
  candidates: Candidate[];
  failures: TrialFitFailure[];
}

/**
 * 枚举全部“压脚 × 针板”组合：安装链唯一且高度相容、
 * 扫掠包络同时落在压脚与针板开口内者进入候选。
 */
export function runTrialFit(
  machine: MachineRec,
  accessories: AccessoryRec[],
  req: FitRequest,
): TrialFitResult {
  const feet = accessories.filter((a): a is FootRec => a.kind === 'foot');
  const plates = accessories.filter((a): a is PlateRec => a.kind === 'plate');
  const adapters = accessories.filter((a): a is AdapterRec => a.kind === 'adapter');

  const candidates: Candidate[] = [];
  const failures: TrialFitFailure[] = [];

  for (const foot of feet) {
    for (const plate of plates) {
      const combo = { footId: foot.id, footCode: foot.code, plateId: plate.id, plateCode: plate.code };
      const chains = findAdapterChains(machine.presserBarStandard, foot.mountStandard, adapters);
      if (chains.length === 0) {
        failures.push({
          ...combo,
          adapterIds: [],
          reason: 'mount_chain_missing',
          message: `机器制式 ${machine.presserBarStandard} 与压脚 ${foot.code}（${foot.mountStandard}）之间没有可用的转换链`,
        });
        continue;
      }
      if (chains.length > 1) {
        failures.push({
          ...combo,
          adapterIds: [],
          reason: 'mount_chain_ambiguous',
          message: `机器与压脚 ${foot.code} 之间存在 ${chains.length} 条不同的安装链，无法唯一确定`,
        });
        continue;
      }
      const chain = chains[0]!;
      const res = evaluateCombination(machine, foot, plate, chain, req);
      if (res.ok) {
        candidates.push({
          ...combo,
          adapterIds: chain.map((a) => a.id),
          adapterCodes: chain.map((a) => a.code),
          metrics: res.metrics,
        });
      } else {
        for (const f of res.failures) {
          failures.push({ ...combo, adapterIds: chain.map((a) => a.id), ...f });
        }
      }
    }
  }

  candidates.sort(compareCandidates);
  return { candidates, failures };
}

/**
 * 候选定解顺序：
 * 1. 转换件更少者优先；2. 最大高度偏差更小者优先；
 * 3. 最小净距更大者优先；4. 配件编号序列字典序。
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.metrics.adapterCount !== b.metrics.adapterCount) {
    return a.metrics.adapterCount - b.metrics.adapterCount;
  }
  if (a.metrics.maxHeightDeviationMm !== b.metrics.maxHeightDeviationMm) {
    return a.metrics.maxHeightDeviationMm - b.metrics.maxHeightDeviationMm;
  }
  if (a.metrics.minClearanceMm !== b.metrics.minClearanceMm) {
    return b.metrics.minClearanceMm - a.metrics.minClearanceMm;
  }
  const seqA = [a.footCode, a.plateCode, ...a.adapterCodes];
  const seqB = [b.footCode, b.plateCode, ...b.adapterCodes];
  for (let i = 0; i < Math.max(seqA.length, seqB.length); i++) {
    const c = (seqA[i] ?? '').localeCompare(seqB[i] ?? '', undefined, { numeric: true });
    if (c !== 0) return c;
  }
  return 0;
}
