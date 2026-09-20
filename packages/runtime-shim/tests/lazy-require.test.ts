import { test, expect, mock, afterAll } from "bun:test";

// Reproduces the real workerd failure: `createRequire(import.meta.url)` throws
// because `import.meta.url` is `undefined` under workerd's bundled output.
// Mocking createRequire to throw unconditionally simulates that exactly —
// any module that calls it at top-level scope will fail to even import.

const realModuleExports = { ...(await import("node:module")) };

afterAll(() => {
  mock.module("node:module", () => realModuleExports);
});

mock.module("node:module", () => ({
  ...realModuleExports,
  createRequire: () => {
    throw new TypeError(
      "The argument 'path' must be a file URL object, a file URL string, or an absolute path string.. Received 'undefined'",
    );
  },
}));

const modules = ["fs", "hash", "database", "spawn", "serve", "glob"] as const;

for (const name of modules) {
  test(`${name}.ts does not call createRequire at import time`, async () => {
    // Cache-bust so each test gets a fresh module evaluation under the mock.
    await import(`../src/${name}.ts?bust=${Date.now()}-${Math.random()}`);
  });
}

test("index.ts barrel does not call createRequire at import time", async () => {
  await import(`../src/index.ts?bust=${Date.now()}-${Math.random()}`);
});
