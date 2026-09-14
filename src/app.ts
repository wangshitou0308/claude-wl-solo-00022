import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './errors.js';
import {
  accessoryCreateSchema,
  confirmStepSchema,
  machineCreateSchema,
  sessionCreateSchema,
  trialFitCreateSchema,
  SESSION_STEPS,
  type SessionStep,
} from './schemas.js';
import {
  checkMachineEnvelope,
  evaluateCombination,
  findAdapterChains,
  parseNeedleDiameterMm,
  runTrialFit,
  type AccessoryRec,
  type AdapterRec,
  type FitRequest,
  type FootRec,
  type MachineRec,
  type PlateRec,
} from './domain.js';
import { polygonSelfIntersects } from './geometry.js';

const now = () => new Date().toISOString();

// ---------- 行类型与映射 ----------

interface MachineRow {
  id: string;
  code: string;
  name: string | null;
  standard: MachineRec['presserBarStandard'];
  needle_min: number;
  needle_max: number;
  max_swing: number;
  feed_mode: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface AccessoryRow {
  id: string;
  code: string;
  kind: 'foot' | 'plate' | 'adapter';
  name: string | null;
  payload: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  machine_id: string;
  status: 'in_progress' | 'completed' | 'expired';
  inputs: string;
  machine_version: number;
  accessory_versions: string;
  metrics: string;
  steps_confirmed: number;
  snapshot: string | null;
  solution_hash: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function machineFromRow(r: MachineRow): MachineRec & { createdAt: string; updatedAt: string } {
  return {
    id: r.id,
    code: r.code,
    name: r.name ?? undefined,
    presserBarStandard: r.standard,
    needleRangeMm: { min: r.needle_min, max: r.needle_max },
    maxSwingMm: r.max_swing,
    feedMode: r.feed_mode,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function accessoryFromRow(
  r: AccessoryRow,
): AccessoryRec & { createdAt: string; updatedAt: string } {
  const payload = JSON.parse(r.payload) as Record<string, unknown>;
  return {
    id: r.id,
    code: r.code,
    kind: r.kind,
    name: r.name ?? undefined,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...payload,
  } as AccessoryRec & { createdAt: string; updatedAt: string };
}

function getMachineRow(id: string): MachineRow {
  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as MachineRow | undefined;
  if (!row) throw new HttpError(404, 'MACHINE_NOT_FOUND', `机器 ${id} 不存在`);
  return row;
}

function getAccessoryRow(id: string): AccessoryRow {
  const row = db.prepare('SELECT * FROM accessories WHERE id = ?').get(id) as
    | AccessoryRow
    | undefined;
  if (!row) throw new HttpError(404, 'ACCESSORY_NOT_FOUND', `配件 ${id} 不存在`);
  return row;
}

function getSessionRow(id: string): SessionRow {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  if (!row) throw new HttpError(404, 'SESSION_NOT_FOUND', `试装会话 ${id} 不存在`);
  return row;
}

function nextCode(prefix: string): string {
  const row = db
    .prepare(
      `INSERT INTO counters (prefix, value) VALUES (?, 1)
       ON CONFLICT (prefix) DO UPDATE SET value = value + 1
       RETURNING value`,
    )
    .get(prefix) as { value: number };
  return `${prefix}-${String(row.value).padStart(4, '0')}`;
}

function ensureCodeFree(table: 'machines' | 'accessories', code: string): void {
  const dup = db.prepare(`SELECT 1 FROM ${table} WHERE code = ?`).get(code);
  if (dup) throw new HttpError(409, 'CODE_CONFLICT', `编号 "${code}" 已被占用`);
}

// ---------- 会话新鲜度与过期 ----------

function sessionFresh(row: SessionRow): boolean {
  const m = db.prepare('SELECT version FROM machines WHERE id = ?').get(row.machine_id) as
    | { version: number }
    | undefined;
  if (!m || m.version !== row.machine_version) return false;
  const vers = JSON.parse(row.accessory_versions) as Record<string, number>;
  for (const [id, v] of Object.entries(vers)) {
    const a = db.prepare('SELECT version FROM accessories WHERE id = ?').get(id) as
      | { version: number }
      | undefined;
    if (!a || a.version !== v) return false;
  }
  return true;
}

/** 配件或机器变更后，使引用了旧版本的未完成会话过期 */
function expireStaleSessions(): void {
  const rows = db
    .prepare(`SELECT * FROM sessions WHERE status = 'in_progress'`)
    .all() as SessionRow[];
  const ts = now();
  for (const row of rows) {
    if (!sessionFresh(row)) {
      db.prepare(`UPDATE sessions SET status = 'expired', updated_at = ? WHERE id = ?`).run(
        ts,
        row.id,
      );
    }
  }
}

/** 访问会话时的惰性过期检查 */
function requireFreshSession(id: string): SessionRow {
  const row = getSessionRow(id);
  if (row.status === 'in_progress' && !sessionFresh(row)) {
    db.prepare(`UPDATE sessions SET status = 'expired', updated_at = ? WHERE id = ?`).run(
      now(),
      id,
    );
    row.status = 'expired';
  }
  return row;
}

// ---------- 其它辅助 ----------

function resolveNeedleRadiusMm(needleType: string, explicitDiameterMm?: number): number {
  if (explicitDiameterMm !== undefined) return explicitDiameterMm / 2;
  const d = parseNeedleDiameterMm(needleType);
  if (d === null) {
    throw new HttpError(
      422,
      'NEEDLE_DIAMETER_UNKNOWN',
      `无法从针型 "${needleType}" 解析针径，请显式提供 needleDiameterMm`,
    );
  }
  return d / 2;
}

function buildFitRequest(body: {
  stitch: string;
  needleType: string;
  needleDiameterMm?: number | undefined;
  needlePath: Array<{ x: number; y: number }>;
}): FitRequest {
  return {
    stitch: body.stitch,
    needleType: body.needleType,
    needleRadiusMm: resolveNeedleRadiusMm(body.needleType, body.needleDiameterMm),
    path: body.needlePath,
  };
}

function assertPathWithinMachine(machine: MachineRec, req: FitRequest): void {
  const check = checkMachineEnvelope(machine, req.path);
  if (!check.ok) {
    throw new HttpError(422, check.reason.toUpperCase(), '针路超出机器能力范围', check.details);
  }
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

function sessionToApi(row: SessionRow): Record<string, unknown> {
  const steps = db
    .prepare('SELECT seq, step, confirmed_at FROM session_steps WHERE session_id = ? ORDER BY seq')
    .all(row.id) as Array<{ seq: number; step: SessionStep; confirmed_at: string }>;
  return {
    id: row.id,
    machineId: row.machine_id,
    status: row.status,
    steps: steps.map((s) => ({ step: s.step, confirmedAt: s.confirmed_at })),
    nextStep:
      row.status === 'in_progress' ? (SESSION_STEPS[steps.length] ?? null) : null,
    inputs: JSON.parse(row.inputs),
    metrics: JSON.parse(row.metrics),
    snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
    solutionHash: row.solution_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

// ---------- 应用 ----------

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: '请求参数不合法', details: err.issues },
      });
    }
    if (err instanceof HttpError) {
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (typeof e.statusCode === 'number' && e.statusCode < 500) {
      return reply
        .code(e.statusCode)
        .send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message ?? '请求错误' } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: '内部错误' } });
  });

  app.get('/', async () => ({
    service: 'sewfit-api',
    description: '家用缝纫机配件防撞试配 API',
    endpoints: [
      'POST /machines',
      'GET /machines',
      'GET /machines/:id',
      'PUT /machines/:id',
      'POST /accessories',
      'GET /accessories',
      'GET /accessories/:id',
      'PUT /accessories/:id',
      'POST /trial-fits',
      'POST /sessions',
      'GET /sessions',
      'GET /sessions/:id',
      'POST /sessions/:id/confirmations',
      'POST /sessions/:id/undo',
    ],
  }));

  app.get('/health', async () => ({ ok: true }));

  // ---------- 机器 ----------

  app.post('/machines', async (req, reply) => {
    const body = machineCreateSchema.parse(req.body);
    const code = body.code ?? nextCode('M');
    ensureCodeFree('machines', code);
    const id = randomUUID();
    const ts = now();
    db.prepare(
      `INSERT INTO machines (id, code, name, standard, needle_min, needle_max, max_swing, feed_mode, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      code,
      body.name ?? null,
      body.presserBarStandard,
      body.needleRangeMm.min,
      body.needleRangeMm.max,
      body.maxSwingMm,
      body.feedMode,
      ts,
      ts,
    );
    reply.code(201);
    return machineFromRow(getMachineRow(id));
  });

  app.get('/machines', async () => {
    const rows = db.prepare('SELECT * FROM machines ORDER BY code').all() as MachineRow[];
    return rows.map(machineFromRow);
  });

  app.get<{ Params: { id: string } }>('/machines/:id', async (req) =>
    machineFromRow(getMachineRow(req.params.id)),
  );

  app.put<{ Params: { id: string } }>('/machines/:id', async (req) => {
    const row = getMachineRow(req.params.id);
    const body = machineCreateSchema.parse(req.body);
    const code = body.code ?? row.code;
    if (code !== row.code) ensureCodeFree('machines', code);
    const ts = now();
    db.prepare(
      `UPDATE machines SET code = ?, name = ?, standard = ?, needle_min = ?, needle_max = ?,
         max_swing = ?, feed_mode = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    ).run(
      code,
      body.name ?? null,
      body.presserBarStandard,
      body.needleRangeMm.min,
      body.needleRangeMm.max,
      body.maxSwingMm,
      body.feedMode,
      ts,
      row.id,
    );
    expireStaleSessions();
    return machineFromRow(getMachineRow(row.id));
  });

  // ---------- 配件 ----------

  app.post('/accessories', async (req, reply) => {
    const body = accessoryCreateSchema.parse(req.body);
    if ((body.kind === 'foot' || body.kind === 'plate') && polygonSelfIntersects(body.openingContour)) {
      throw new HttpError(422, 'CONTOUR_SELF_INTERSECTS', '开口轮廓多边形自交，请检查顶点顺序');
    }
    if (body.kind === 'adapter' && body.fromStandard === body.toStandard) {
      throw new HttpError(422, 'ADAPTER_SAME_STANDARD', '转换柄的输入与输出制式不能相同');
    }
    const code = body.code ?? nextCode(body.kind === 'foot' ? 'F' : body.kind === 'plate' ? 'P' : 'A');
    ensureCodeFree('accessories', code);
    const id = randomUUID();
    const ts = now();
    const { kind, code: _c, name: _n, ...payload } = body;
    db.prepare(
      `INSERT INTO accessories (id, code, kind, name, payload, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, code, body.kind, body.name ?? null, JSON.stringify(payload), ts, ts);
    reply.code(201);
    return accessoryFromRow(getAccessoryRow(id));
  });

  app.get<{ Querystring: { kind?: string } }>('/accessories', async (req) => {
    const kind = req.query.kind;
    const rows = (
      kind
        ? db.prepare('SELECT * FROM accessories WHERE kind = ? ORDER BY code').all(kind)
        : db.prepare('SELECT * FROM accessories ORDER BY code').all()
    ) as AccessoryRow[];
    return rows.map(accessoryFromRow);
  });

  app.get<{ Params: { id: string } }>('/accessories/:id', async (req) =>
    accessoryFromRow(getAccessoryRow(req.params.id)),
  );

  app.put<{ Params: { id: string } }>('/accessories/:id', async (req) => {
    const row = getAccessoryRow(req.params.id);
    const body = accessoryCreateSchema.parse(req.body);
    if (body.kind !== row.kind) {
      throw new HttpError(422, 'KIND_IMMUTABLE', `配件类型不可变更（当前为 ${row.kind}）`);
    }
    if ((body.kind === 'foot' || body.kind === 'plate') && polygonSelfIntersects(body.openingContour)) {
      throw new HttpError(422, 'CONTOUR_SELF_INTERSECTS', '开口轮廓多边形自交，请检查顶点顺序');
    }
    if (body.kind === 'adapter' && body.fromStandard === body.toStandard) {
      throw new HttpError(422, 'ADAPTER_SAME_STANDARD', '转换柄的输入与输出制式不能相同');
    }
    const code = body.code ?? row.code;
    if (code !== row.code) ensureCodeFree('accessories', code);
    const ts = now();
    const { kind: _k, code: _c, name: _n, ...payload } = body;
    db.prepare(
      `UPDATE accessories SET code = ?, name = ?, payload = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(code, body.name ?? null, JSON.stringify(payload), ts, row.id);
    expireStaleSessions();
    return accessoryFromRow(getAccessoryRow(row.id));
  });

  // ---------- 防撞试配 ----------

  app.post('/trial-fits', async (req) => {
    const body = trialFitCreateSchema.parse(req.body);
    const machine = machineFromRow(getMachineRow(body.machineId));
    const fit = buildFitRequest(body);
    assertPathWithinMachine(machine, fit);

    const accessories = (
      db.prepare('SELECT * FROM accessories ORDER BY code').all() as AccessoryRow[]
    ).map(accessoryFromRow);

    const { candidates, failures } = runTrialFit(machine, accessories, fit);
    return {
      machineId: machine.id,
      stitch: fit.stitch,
      needleType: fit.needleType,
      needleRadiusMm: fit.needleRadiusMm,
      candidates: candidates.map((c, i) => ({
        rank: i + 1,
        foot: { id: c.footId, code: c.footCode },
        plate: { id: c.plateId, code: c.plateCode },
        adapters: c.adapterIds.map((id, j) => ({ id, code: c.adapterCodes[j]! })),
        adapterCount: c.metrics.adapterCount,
        maxHeightDeviationMm: c.metrics.maxHeightDeviationMm,
        minClearanceMm: c.metrics.minClearanceMm,
        footClearanceMm: c.metrics.footClearanceMm,
        plateClearanceMm: c.metrics.plateClearanceMm,
      })),
      failures,
    };
  });

  // ---------- 试装会话 ----------

  app.post('/sessions', async (req, reply) => {
    const body = sessionCreateSchema.parse(req.body);
    const machine = machineFromRow(getMachineRow(body.machineId));
    const fit = buildFitRequest(body);
    assertPathWithinMachine(machine, fit);

    const foot = accessoryFromRow(getAccessoryRow(body.footId));
    const plate = accessoryFromRow(getAccessoryRow(body.plateId));
    if (foot.kind !== 'foot') throw new HttpError(422, 'NOT_A_FOOT', `${body.footId} 不是压脚`);
    if (plate.kind !== 'plate') throw new HttpError(422, 'NOT_A_PLATE', `${body.plateId} 不是针板`);
    if (new Set(body.adapterIds).size !== body.adapterIds.length) {
      throw new HttpError(422, 'ADAPTER_DUPLICATED', '转换柄列表中存在重复');
    }
    const givenAdapters = body.adapterIds.map((id) => {
      const a = accessoryFromRow(getAccessoryRow(id));
      if (a.kind !== 'adapter') throw new HttpError(422, 'NOT_AN_ADAPTER', `${id} 不是转换柄`);
      return a as AdapterRec;
    });

    // 安装链必须唯一，且与调用方给出的转换柄序列一致
    const allAdapters = (
      db.prepare(`SELECT * FROM accessories WHERE kind = 'adapter'`).all() as AccessoryRow[]
    ).map(accessoryFromRow) as AdapterRec[];
    const chains = findAdapterChains(machine.presserBarStandard, foot.mountStandard, allAdapters);
    if (chains.length === 0) {
      throw new HttpError(409, 'MOUNT_CHAIN_MISSING', '机器与压脚之间没有可用的安装链');
    }
    if (chains.length > 1) {
      throw new HttpError(
        409,
        'MOUNT_CHAIN_AMBIGUOUS',
        `存在 ${chains.length} 条不同的安装链，无法唯一确定`,
        { chains: chains.map((c) => c.map((a) => a.id)) },
      );
    }
    const chain = chains[0]!;
    if (chain.map((a) => a.id).join('|') !== givenAdapters.map((a) => a.id).join('|')) {
      throw new HttpError(409, 'ADAPTER_CHAIN_MISMATCH', '给出的转换柄序列与唯一安装链不一致', {
        expectedAdapterIds: chain.map((a) => a.id),
      });
    }

    const res = evaluateCombination(machine, foot as FootRec, plate as PlateRec, chain, fit);
    if (!res.ok) {
      throw new HttpError(409, 'COMBINATION_INFEASIBLE', '该组合不可行，无法创建试装会话', {
        failures: res.failures,
      });
    }

    // 同一机器的针路/方案变更：使其它未完成会话过期
    const ts = now();
    db.prepare(
      `UPDATE sessions SET status = 'expired', updated_at = ? WHERE machine_id = ? AND status = 'in_progress'`,
    ).run(ts, machine.id);

    const id = randomUUID();
    const inputs = {
      machineId: machine.id,
      footId: foot.id,
      plateId: plate.id,
      adapterIds: chain.map((a) => a.id),
      stitch: fit.stitch,
      needleType: fit.needleType,
      needleRadiusMm: fit.needleRadiusMm,
      needlePath: fit.path,
    };
    const accessoryVersions: Record<string, number> = {
      [foot.id]: foot.version,
      [plate.id]: plate.version,
    };
    for (const a of chain) accessoryVersions[a.id] = a.version;

    db.prepare(
      `INSERT INTO sessions (id, machine_id, status, inputs, machine_version, accessory_versions, metrics, steps_confirmed, created_at, updated_at)
       VALUES (?, ?, 'in_progress', ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      id,
      machine.id,
      JSON.stringify(inputs),
      machine.version,
      JSON.stringify(accessoryVersions),
      JSON.stringify(res.metrics),
      ts,
      ts,
    );
    reply.code(201);
    return sessionToApi(getSessionRow(id));
  });

  app.get<{ Querystring: { status?: string; machineId?: string } }>('/sessions', async (req) => {
    expireStaleSessions();
    const { status, machineId } = req.query;
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: string[] = [];
    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    }
    if (machineId) {
      sql += ' AND machine_id = ?';
      params.push(machineId);
    }
    sql += ' ORDER BY created_at DESC';
    const rows = db.prepare(sql).all(...params) as SessionRow[];
    return rows.map(sessionToApi);
  });

  app.get<{ Params: { id: string } }>('/sessions/:id', async (req) =>
    sessionToApi(requireFreshSession(req.params.id)),
  );

  app.post<{ Params: { id: string } }>('/sessions/:id/confirmations', async (req, reply) => {
    const row = requireFreshSession(req.params.id);
    if (row.status === 'expired') {
      throw new HttpError(409, 'SESSION_EXPIRED', '会话已过期（配件或针路已变更）');
    }
    if (row.status === 'completed') {
      throw new HttpError(409, 'SESSION_COMPLETED', '会话已完成并冻结，不可再确认');
    }
    const { step } = confirmStepSchema.parse(req.body);
    const confirmed = (
      db
        .prepare('SELECT step FROM session_steps WHERE session_id = ? ORDER BY seq')
        .all(row.id) as Array<{ step: SessionStep }>
    ).map((s) => s.step);
    const expected = SESSION_STEPS[confirmed.length];
    if (step !== expected) {
      throw new HttpError(
        409,
        'STEP_OUT_OF_ORDER',
        `当前应确认步骤 "${expected}"，收到 "${step}"`,
        { expectedStep: expected, confirmedSteps: confirmed },
      );
    }
    // 通电步骤前必须已完成手轮检查（顺序约束的显式兜底）
    if (step === 'low_speed_sew' && !confirmed.includes('handwheel_full_turn')) {
      throw new HttpError(409, 'HANDWHEEL_REQUIRED', '未完成手轮完整转一周检查，不得进入通电步骤');
    }

    const ts = now();
    db.prepare(
      'INSERT INTO session_steps (session_id, seq, step, confirmed_at) VALUES (?, ?, ?, ?)',
    ).run(row.id, confirmed.length, step, ts);

    const isLast = confirmed.length + 1 === SESSION_STEPS.length;
    if (isLast) {
      // 完成：冻结输入快照与方案哈希
      const inputs = JSON.parse(row.inputs) as {
        footId: string;
        plateId: string;
        adapterIds: string[];
        [k: string]: unknown;
      };
      const snapshot = {
        frozenAt: ts,
        inputs,
        machine: machineFromRow(getMachineRow(row.machine_id)),
        foot: accessoryFromRow(getAccessoryRow(inputs.footId)),
        plate: accessoryFromRow(getAccessoryRow(inputs.plateId)),
        adapters: inputs.adapterIds.map((aid) => accessoryFromRow(getAccessoryRow(aid))),
        metrics: JSON.parse(row.metrics),
      };
      const solutionHash = createHash('sha256')
        .update(
          stableStringify({
            inputs,
            metrics: JSON.parse(row.metrics),
            machineVersion: row.machine_version,
            accessoryVersions: JSON.parse(row.accessory_versions),
          }),
        )
        .digest('hex');
      db.prepare(
        `UPDATE sessions SET status = 'completed', steps_confirmed = steps_confirmed + 1,
           snapshot = ?, solution_hash = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      ).run(JSON.stringify(snapshot), solutionHash, ts, ts, row.id);
    } else {
      db.prepare(
        'UPDATE sessions SET steps_confirmed = steps_confirmed + 1, updated_at = ? WHERE id = ?',
      ).run(ts, row.id);
    }
    reply.code(201);
    return sessionToApi(getSessionRow(row.id));
  });

  app.post<{ Params: { id: string } }>('/sessions/:id/undo', async (req) => {
    const row = requireFreshSession(req.params.id);
    if (row.status === 'expired') {
      throw new HttpError(409, 'SESSION_EXPIRED', '会话已过期（配件或针路已变更）');
    }
    if (row.status === 'completed') {
      throw new HttpError(409, 'SESSION_COMPLETED', '会话已完成并冻结，不可撤回');
    }
    const last = db
      .prepare('SELECT seq, step FROM session_steps WHERE session_id = ? ORDER BY seq DESC LIMIT 1')
      .get(row.id) as { seq: number; step: SessionStep } | undefined;
    if (!last) {
      throw new HttpError(409, 'NOTHING_TO_UNDO', '尚无已确认的步骤可撤回');
    }
    db.prepare('DELETE FROM session_steps WHERE session_id = ? AND seq = ?').run(row.id, last.seq);
    db.prepare(
      'UPDATE sessions SET steps_confirmed = steps_confirmed - 1, updated_at = ? WHERE id = ?',
    ).run(now(), row.id);
    return { undone: last.step, session: sessionToApi(getSessionRow(row.id)) };
  });

  return app;
}
