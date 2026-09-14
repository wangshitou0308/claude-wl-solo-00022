import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 纯 WASM SQLite（sql.js），无原生编译依赖。
 * 启动时把数据文件读入内存；每次写操作后整体落盘（数据量小，开销可忽略）。
 */

const file = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'sewfit.sqlite');

/** 兼容 better-sqlite3 的最小语句接口 */
export interface Stmt {
  run(...params: unknown[]): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(...params: unknown[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all(...params: unknown[]): any[];
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}

type SqlParam = string | number | Uint8Array | null;

function toParams(params: unknown[]): SqlParam[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'string' || typeof p === 'number') return p;
    if (typeof p === 'boolean') return p ? 1 : 0;
    throw new Error(`不支持的 SQL 参数类型: ${typeof p}`);
  });
}

class SqlJsStmt implements Stmt {
  constructor(
    private readonly db: SqlJsDatabase,
    private readonly sql: string,
    private readonly onWrite: () => void,
  ) {}

  run(...params: unknown[]): void {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(toParams(params));
      stmt.step();
    } finally {
      stmt.free();
    }
    this.onWrite();
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(toParams(params));
      if (stmt.step()) return stmt.getAsObject() as Record<string, unknown>;
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    const stmt = this.db.prepare(this.sql);
    try {
      stmt.bind(toParams(params));
      const rows: Array<Record<string, unknown>> = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
      return rows;
    } finally {
      stmt.free();
    }
  }
}

class SqlJsDb implements Db {
  constructor(private readonly inner: SqlJsDatabase) {}

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  prepare(sql: string): Stmt {
    return new SqlJsStmt(this.inner, sql, () => persist());
  }
}

let inner: SqlJsDatabase | null = null;

class SqlJsDbProxy implements Db {
  private get real(): SqlJsDb {
    if (!inner) throw new Error('数据库尚未初始化');
    return new SqlJsDb(inner);
  }
  exec(sql: string): void {
    this.real.exec(sql);
  }
  prepare(sql: string): Stmt {
    return this.real.prepare(sql);
  }
}

/** 数据库句柄（initDb 完成后可用；路由处理均在初始化之后执行） */
export const db: Db = new SqlJsDbProxy();

export function persist(): void {
  if (!inner || file === ':memory:') return;
  const data = inner.export();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export async function initDb(): Promise<void> {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const SQL = await initSqlJs();
  inner =
    file !== ':memory:' && existsSync(file)
      ? new SQL.Database(new Uint8Array(readFileSync(file)))
      : new SQL.Database();

  inner.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id          TEXT PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      name        TEXT,
      standard    TEXT NOT NULL,
      needle_min  REAL NOT NULL,
      needle_max  REAL NOT NULL,
      max_swing   REAL NOT NULL,
      feed_mode   TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accessories (
      id          TEXT PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      kind        TEXT NOT NULL,
      name        TEXT,
      payload     TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY,
      machine_id         TEXT NOT NULL,
      status             TEXT NOT NULL,            -- in_progress | completed | expired
      inputs             TEXT NOT NULL,            -- 创建时的输入快照（JSON）
      machine_version    INTEGER NOT NULL,
      accessory_versions TEXT NOT NULL,            -- { accessoryId: version }
      metrics            TEXT NOT NULL,            -- 方案指标（JSON）
      steps_confirmed    INTEGER NOT NULL DEFAULT 0,
      snapshot           TEXT,                     -- 完成时冻结的完整快照（JSON）
      solution_hash      TEXT,                     -- 完成时冻结的方案哈希
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      completed_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS session_steps (
      session_id   TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      step         TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS counters (
      prefix TEXT PRIMARY KEY,
      value  INTEGER NOT NULL
    );
  `);
  persist();
}
