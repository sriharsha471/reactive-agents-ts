// Run: bun test packages/llm-provider/tests/llm-config-lazy-env.test.ts --timeout 15000
//
// D-2026-09-08-O regression. Two invariants:
//   1. A key placed in process.env AFTER the package is imported is still the
//      key the provider uses (env is read at layer build, not module import).
//   2. A compat provider (xai/groq) with no key of its own must NOT construct an
//      SDK client — the `openai` SDK's own fallback is OPENAI_API_KEY, which
//      would ship an OpenAI key to a third-party host.
import { describe, it, expect, mock, beforeAll, afterEach } from "bun:test";
import { Effect } from "effect";

let capturedCtor: { apiKey?: string; baseURL?: string } | null = null;

mock.module("openai", () => ({
  default: class MockOpenAI {
    constructor(opts: { apiKey?: string; baseURL?: string }) {
      capturedCtor = opts;
    }
    chat = {
      completions: {
        create: mock(async () => ({
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "grok-3-mini",
        })),
      },
    };
    embeddings = { create: mock(async () => ({ data: [] })) };
  },
}));

const savedEnv = { XAI_API_KEY: process.env.XAI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };

let mod: typeof import("../src/index.js");

beforeAll(async () => {
  // Simulate "imported before dotenv ran": no xai key at import time.
  delete process.env.XAI_API_KEY;
  mod = await import("../src/index.js");
});

afterEach(() => {
  capturedCtor = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const completeVia = (layer: ReturnType<typeof mod.createLLMProviderLayer>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* mod.LLMService;
      return yield* llm.complete({ model: "grok-3-mini", messages: [{ role: "user", content: "hi" }], maxTokens: 16 });
    }).pipe(Effect.provide(layer), Effect.either),
  );

describe("provider config reads env lazily (D-2026-09-08-O)", () => {
  it("uses an XAI_API_KEY set after import", async () => {
    process.env.XAI_API_KEY = "xai-set-after-import";
    const result = await completeVia(mod.createLLMProviderLayer("xai", undefined, "grok-3-mini"));
    expect(result._tag).toBe("Right");
    expect(capturedCtor?.apiKey).toBe("xai-set-after-import");
  });

  it("never constructs an xai client with another provider's key", async () => {
    delete process.env.XAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-must-not-leak";
    const result = await completeVia(mod.createLLMProviderLayer("xai", undefined, "grok-3-mini"));
    expect(result._tag).toBe("Left");
    // The SDK must not even be constructed — construction is where the fallback happens.
    expect(capturedCtor).toBeNull();
    if (result._tag === "Left") expect(String((result.left as { message?: string }).message)).toContain("XAI_API_KEY");
  });

  it("LLMConfigFromEnv layer reflects env at build time", async () => {
    process.env.XAI_API_KEY = "xai-layer-build";
    const cfg = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* mod.LLMConfig;
      }).pipe(Effect.provide(mod.LLMConfigFromEnv)),
    );
    expect(cfg.xaiApiKey).toBe("xai-layer-build");
  });
});
