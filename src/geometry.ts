/**
 * 平面几何：针路（折线）相对开口轮廓（多边形）的净距计算。
 * 判定原理：针路折线按针半径膨胀后仍落在开口内
 *   <=> 折线到多边形边界的最小有符号距离 >= 针半径 + 尺寸公差。
 */

export interface Pt {
  x: number;
  y: number;
}

const EPS = 1e-9;

/** 点到线段的最短距离 */
export function distPtSeg(p: Pt, a: Pt, b: Pt): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > EPS) {
    t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Pt, b: Pt, p: Pt): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

/** 两线段是否相交（含共线接触） */
export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (
    ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) &&
    ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))
  ) {
    return true;
  }
  if (Math.abs(o1) <= EPS && onSegment(a, b, c)) return true;
  if (Math.abs(o2) <= EPS && onSegment(a, b, d)) return true;
  if (Math.abs(o3) <= EPS && onSegment(c, d, a)) return true;
  if (Math.abs(o4) <= EPS && onSegment(c, d, b)) return true;
  return false;
}

/** 线段到线段的最短距离（相交为 0） */
export function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    distPtSeg(a, c, d),
    distPtSeg(b, c, d),
    distPtSeg(c, a, b),
    distPtSeg(d, a, b),
  );
}

export interface Edge {
  a: Pt;
  b: Pt;
}

export function polygonEdges(poly: Pt[]): Edge[] {
  const edges: Edge[] = [];
  for (let i = 0; i < poly.length; i++) {
    edges.push({ a: poly[i]!, b: poly[(i + 1) % poly.length]! });
  }
  return edges;
}

/** 点在多边形内（边界上视为在内） */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  for (const e of polygonEdges(poly)) {
    if (distPtSeg(p, e.a, e.b) < EPS) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    if (
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点到多边形边界的最短距离 */
export function pointToPolygonDist(p: Pt, poly: Pt[]): number {
  let d = Infinity;
  for (const e of polygonEdges(poly)) {
    d = Math.min(d, distPtSeg(p, e.a, e.b));
  }
  return d;
}

/** 多边形是否自交（非相邻边相交） */
export function polygonSelfIntersects(poly: Pt[]): boolean {
  const edges = polygonEdges(poly);
  const n = edges.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // 相邻边（含首尾相邻）跳过
      if (j === i || j === (i + 1) % n || i === (j + 1) % n) continue;
      if (segmentsIntersect(edges[i]!.a, edges[i]!.b, edges[j]!.a, edges[j]!.b)) {
        return true;
      }
    }
  }
  return false;
}

/** 单段针路相对开口轮廓的净距结果 */
export interface SegmentClearance {
  /** 针路段序号（即该段起点在针路中的针位下标） */
  index: number;
  /** 有符号净距：段完全在开口内为正，压线或越界为非正 */
  signedClearanceMm: number;
  /** 距离最近的轮廓边序号 */
  edgeIndex: number;
  /** 该段上距边界最近的针位点 */
  point: Pt;
}

/**
 * 逐段计算针路折线相对多边形开口的有符号净距。
 * 段与边界相交（针扫过边界）时净距记 0；段在开口外时为负。
 */
export function pathSegmentClearances(path: Pt[], poly: Pt[]): SegmentClearance[] {
  const edges = polygonEdges(poly);
  const segs: Array<{ a: Pt; b: Pt }> = [];
  if (path.length === 1) {
    segs.push({ a: path[0]!, b: path[0]! });
  } else {
    for (let i = 0; i < path.length - 1; i++) {
      segs.push({ a: path[i]!, b: path[i + 1]! });
    }
  }
  return segs.map((s, index) => {
    let dMin = Infinity;
    let edgeIndex = -1;
    let crosses = false;
    edges.forEach((e, ei) => {
      if (segmentsIntersect(s.a, s.b, e.a, e.b)) crosses = true;
      const d = segSegDist(s.a, s.b, e.a, e.b);
      if (d < dMin) {
        dMin = d;
        edgeIndex = ei;
      }
    });
    const inA = pointInPolygon(s.a, poly);
    const inB = pointInPolygon(s.b, poly);
    const signed = crosses ? 0 : inA && inB ? dMin : -dMin;
    // 报告用：取段上距边界最近的针位点（越界端优先）
    let point: Pt;
    if (!inA && inB) {
      point = s.a;
    } else if (inA && !inB) {
      point = s.b;
    } else {
      point =
        pointToPolygonDist(s.a, poly) <= pointToPolygonDist(s.b, poly) ? s.a : s.b;
    }
    return { index, signedClearanceMm: signed, edgeIndex, point };
  });
}
