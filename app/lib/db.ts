// Minimal DB interface implemented by D1 in prod and node:sqlite in tests.
// Every method call is exactly ONE network round trip on D1. Page loaders use one `first()` with aggregated datasets.

export type Stmt = { sql: string; params: unknown[] };

export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  /** Several writes in one round trip (D1 runs a batch as a transaction). */
  batch(stmts: Stmt[]): Promise<void>;
  /** Several reads in one round trip. Returns the rows of each statement, in order. */
  query(stmts: Stmt[]): Promise<any[][]>;
}

export type DbMetrics = { calls: number; statements: number; durationMs: number };

export function d1Db(d1: D1Database, metrics?: DbMetrics): Db {
  const timed = async <T>(statements: number, fn: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    if (metrics) { metrics.calls++; metrics.statements += statements; }
    try { return await fn(); }
    finally { if (metrics) metrics.durationMs += performance.now() - start; }
  };
  const prep = (s: Stmt) => d1.prepare(s.sql).bind(...s.params);
  return {
    async all<T>(sql: string, ...params: unknown[]) {
      const r = await timed(1, () => d1.prepare(sql).bind(...params).all<T>());
      return r.results;
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (await timed(1, () => d1.prepare(sql).bind(...params).first<T>())) ?? null;
    },
    async run(sql: string, ...params: unknown[]) {
      const r = await timed(1, () => d1.prepare(sql).bind(...params).run());
      return { changes: r.meta.changes ?? 0 };
    },
    async batch(stmts) {
      if (stmts.length === 0) return;
      await timed(stmts.length, () => d1.batch(stmts.map(prep)));
    },
    async query(stmts) {
      if (stmts.length === 0) return [];
      const rs = await timed(stmts.length, () => d1.batch(stmts.map(prep)));
      return rs.map((r) => r.results as any[]);
    },
  };
}

export const stmt = (sql: string, ...params: unknown[]): Stmt => ({ sql, params });
