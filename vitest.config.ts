import { defineConfig } from "vitest/config";

// Plain Node config: unit tests for pure logic + the DB layer (via node:sqlite), no Workers runtime.
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
