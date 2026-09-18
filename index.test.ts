// Pure-helper tests for the delegate plugin. Stdlib only: node:test +
// node:assert. Run with: node --test index.test.ts
// Orchestration (session/storage/event) needs the OpenCode runtime and is
// intentionally not covered here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  depthKey,
  eventSessionID,
  pendingKey,
  positiveInt,
  resolveOptions,
  strArg,
  textOfMessage,
  truncate,
} from "./index.ts";

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
  });
});
