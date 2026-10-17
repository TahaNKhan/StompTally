import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, DbMetrics } from "./db";

// Request-scoped, not a shared global cache: concurrent users cannot share credentials or metrics.
export const requestDb = new AsyncLocalStorage<{ db: Db; metrics: DbMetrics }>();
