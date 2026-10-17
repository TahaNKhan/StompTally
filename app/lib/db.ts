// Minimal DB interface implemented by D1 in prod and node:sqlite in tests.

export interface Db {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
  batch(stmts: { sql: string; params: unknown[] }[]): Promise<void>;
}

export function d1Db(d1: D1Database): Db {
  return {
    async all<T>(sql: string, ...params: unknown[]) {
      const r = await d1.prepare(sql).bind(...params).all<T>();
      return r.results;
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return (await d1.prepare(sql).bind(...params).first<T>()) ?? null;
    },
    async run(sql: string, ...params: unknown[]) {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: r.meta.changes ?? 0 };
    },
    async batch(stmts) {
      if (stmts.length === 0) return;
      await d1.batch(stmts.map((s) => d1.prepare(s.sql).bind(...s.params)));
    },
  };
}

export const stmt = (sql: string, ...params: unknown[]) => ({ sql, params });
