// Tests for the delegate plugin. Stdlib only: node:test + node:assert.
// Run with: node --test index.test.ts
// Pure helpers are tested directly; orchestration (execute paths) is
// tested with a mocked plugin context. Background event-notify needs the
// OpenCode runtime and is intentionally not covered here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.ts";
import {
  depthKey,
  eventSessionID,
  kidsKey,
  pendingKey,
  positiveInt,
  resolveOptions,
  strArg,
  textOfMessage,
  truncate,
} from "./src/pure.ts";
import type { PluginContext, ToolDefinition } from "./src/types.ts";

describe("positiveInt", () => {
  it("accepts positive numbers and numeric strings", () => {
    assert.equal(positiveInt(3, 99), 3);
    assert.equal(positiveInt("7", 99), 7);
  });
  it("falls back on zero, negatives, NaN and garbage", () => {
    for (const raw of [0, -1, NaN, "abc", "", null, undefined, {}, [], 1.5]) {
      assert.equal(positiveInt(raw, 99), 99);
    }
  });
});

describe("resolveOptions", () => {
  const ENV_KEYS = ["DELEGATE_MAX_DEPTH", "DELEGATE_TIMEOUT_SECONDS", "DELEGATE_MAX_RESULT_CHARS"] as const;

  function withCleanEnv(fn: () => void) {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of ENV_KEYS) delete process.env[k];
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("returns defaults when nothing is set", () => {
    withCleanEnv(() => {
      assert.deepEqual(resolveOptions(undefined), { maxDepth: 3, timeoutSeconds: 300, maxResultChars: 4000 });
    });
  });
  it("honors the options object", () => {
    withCleanEnv(() => {
      assert.deepEqual(resolveOptions({ maxDepth: 5, timeoutSeconds: 60, maxResultChars: 100 }), {
        maxDepth: 5,
        timeoutSeconds: 60,
        maxResultChars: 100,
      });
    });
  });
  it("honors env vars and ignores invalid values", () => {
    withCleanEnv(() => {
      process.env.DELEGATE_MAX_DEPTH = "2";
      process.env.DELEGATE_TIMEOUT_SECONDS = "bogus";
      const o = resolveOptions({});
      assert.equal(o.maxDepth, 2);
      assert.equal(o.timeoutSeconds, 300);
    });
  });
});

describe("strArg", () => {
  it("trims non-empty strings, null otherwise", () => {
    assert.equal(strArg("  hi  "), "hi");
    assert.equal(strArg(""), null);
    assert.equal(strArg("   "), null);
    assert.equal(strArg(undefined), null);
    assert.equal(strArg(42), null);
  });
});

describe("truncate", () => {
  it("leaves short text untouched", () => {
    assert.equal(truncate("abc", 10, "…[t]"), "abc");
  });
  it("cuts long text and appends the tail", () => {
    assert.equal(truncate("abcdef", 4, "…[t]"), "abcd\n…[t]");
  });
});

describe("textOfMessage", () => {
  it("handles string content", () => {
    assert.equal(textOfMessage({ type: "assistant", content: "hello" }), "hello");
  });
  it("joins text blocks and skips the rest", () => {
    const msg = { content: [{ type: "text", text: "a" }, { type: "image", text: "x" }, { type: "text", text: "b" }] };
    assert.equal(textOfMessage(msg), "a\nb");
  });
  it("returns empty string for missing content", () => {
    assert.equal(textOfMessage(null), "");
    assert.equal(textOfMessage({}), "");
  });
});

describe("eventSessionID", () => {
  it("reads session ids from known shapes", () => {
    assert.equal(eventSessionID({ data: { sessionID: "s1" } }), "s1");
    assert.equal(eventSessionID({ data: { info: { sessionID: "s2" } } }), "s2");
    assert.equal(eventSessionID({ data: { info: { id: "s3" } } }), "s3");
    assert.equal(eventSessionID({ type: "session.idle", data: { id: "s4" } }), "s4");
    assert.equal(eventSessionID({ sessionID: "s5" }), "s5");
  });
  it("returns undefined for unknown shapes", () => {
    assert.equal(eventSessionID(null), undefined);
    assert.equal(eventSessionID({ type: "other", data: { id: "s6" } }), undefined);
    assert.equal(eventSessionID({}), undefined);
  });
});

describe("storage keys", () => {
  it("uses stable prefixes", () => {
    assert.equal(depthKey("abc"), "depth:abc");
    assert.equal(pendingKey("abc"), "delegate:pending:abc");
    assert.equal(kidsKey("abc"), "delegate:kids:abc");
  });
});

// --- Orchestration tests with a mocked context ---

interface MockOverrides {
  options?: unknown;
  get?: (sessionID: string) => unknown;
  wait?: (sessionID: string) => Promise<unknown>;
  contextMessages?: unknown;
  ids?: string[];
}

function makeCtx(overrides: MockOverrides = {}) {
  const store = new Map<string, unknown>();
  const prompted: Array<{ sessionID: string; text: string }> = [];
  let toolDef: ToolDefinition | null = null;
  let n = 0;
  const ctx: PluginContext = {
    options: overrides.options ?? {},
    storage: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => {
        store.set(k, v);
      },
      remove: async (k: string) => {
        store.delete(k);
      },
      scan: async ({ prefix }: { prefix: string }) => ({
        entries: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
      }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) =>
        (overrides.get?.(sessionID) ?? {}) as { parentID?: unknown },
      context: async () => overrides.contextMessages ?? [{ type: "assistant", content: "done" }],
      create: async () => {
        const id = overrides.ids ? overrides.ids[n++] : `child-${++n}`;
        return { id };
      },
      prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
        prompted.push({ sessionID, text });
      },
      wait: async ({ sessionID }: { sessionID: string }) => overrides.wait?.(sessionID) ?? undefined,
      interrupt: async () => undefined,
      synthetic: async () => undefined,
      hook: async () => ({ dispose: async () => {} }),
    },
    tool: {
      transform: async (fn: (draft: { add: (t: ToolDefinition) => void }) => void) => {
        fn({ add: (t: ToolDefinition) => { toolDef = t; } });
        return { dispose: async () => {} };
      },
    },
    skill: {
      transform: async (fn: (editor: { add: (s: never) => void }) => void) => {
        fn({ add: () => {} });
        return { dispose: async () => {} };
      },
    },
    event: {
      subscribe: () => (async function* (): AsyncGenerator<never> {})(),
    },
  };
  const tool = (): ToolDefinition => {
    if (!toolDef) throw new Error("tool was not registered");
    return toolDef;
  };
  return { ctx, store, prompted, tool };
}

describe("execute: ownership", () => {
  it("rejects waitOnly/resume for foreign children", async () => {
    const { ctx, tool } = makeCtx();
    const dispose = await plugin.setup(ctx);
    try {
      const t = tool();
      const waitOnly = await t.execute({ task: "x", sessionID: "nope", waitOnly: true }, { sessionID: "p" });
      assert.match(waitOnly.content, /not a child/);
      assert.match(waitOnly.content, /collect/);
      const resume = await t.execute({ task: "x", sessionID: "nope" }, { sessionID: "p" });
      assert.match(resume.content, /not a child/);
      assert.match(resume.content, /resume/);
    } finally {
      await dispose();
    }
  });
});

describe("execute: nesting limit", () => {
  it("rejects when the session is already at max depth", async () => {
    const { ctx, store, tool } = makeCtx({ options: { maxDepth: 3 } });
    store.set(depthKey("deep"), 3);
    const dispose = await plugin.setup(ctx);
    try {
      const out = await tool().execute({ task: "x" }, { sessionID: "deep" });
      assert.match(out.content, /nesting limit/);
    } finally {
      await dispose();
    }
  });
});

describe("execute: happy path", () => {
  it("returns the child result with its session id and records the kid", async () => {
    const { ctx, store, prompted, tool } = makeCtx();
    const dispose = await plugin.setup(ctx);
    try {
      const out = await tool().execute({ task: "do it", title: "t" }, { sessionID: "p" });
      assert.match(out.content, /done/);
      assert.match(out.content, /childSessionID: child-1/);
      assert.deepEqual(prompted, [{ sessionID: "child-1", text: "do it" }]);
      assert.deepEqual(store.get(kidsKey("p")), ["child-1"]);
    } finally {
      await dispose();
    }
  });

  it("keeps both kids when two delegates race", async () => {
    const { ctx, store, tool } = makeCtx({ ids: ["child-1", "child-2"] });
    const dispose = await plugin.setup(ctx);
    try {
      const t = tool();
      const [a, b] = await Promise.all([
        t.execute({ task: "one" }, { sessionID: "p" }),
        t.execute({ task: "two" }, { sessionID: "p" }),
      ]);
      assert.match(a.content, /childSessionID: child-1/);
      assert.match(b.content, /childSessionID: child-2/);
      assert.deepEqual(store.get(kidsKey("p")), ["child-1", "child-2"]);
    } finally {
      await dispose();
    }
  });
});

describe("execute: timeout", () => {
  it("interrupts the child and reports after timeoutSeconds", async () => {
    const { ctx, tool } = makeCtx({
      options: { timeoutSeconds: 1 },
      wait: () => new Promise(() => {}),
      contextMessages: [],
    });
    const dispose = await plugin.setup(ctx);
    try {
      const out = await tool().execute({ task: "slow" }, { sessionID: "p" });
      assert.match(out.content, /delegate timeout after 1s/);
    } finally {
      await dispose();
    }
  });
});
