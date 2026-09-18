// Pure helpers for the delegate plugin: no OpenCode dependencies, fully
// covered by index.test.ts. Orchestration (sessions/storage/events) lives
// in index.ts and is tested there with a mocked context.

import type { DelegateOptions } from "./types.ts";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RESULT_CHARS = 4000;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function positiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function resolveOptions(raw: unknown): DelegateOptions {
  const o = asRecord(raw) ?? {};
  return {
    maxDepth: positiveInt(o.maxDepth ?? process.env.DELEGATE_MAX_DEPTH, DEFAULT_MAX_DEPTH),
    timeoutSeconds: positiveInt(o.timeoutSeconds ?? process.env.DELEGATE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    maxResultChars: positiveInt(o.maxResultChars ?? process.env.DELEGATE_MAX_RESULT_CHARS, DEFAULT_MAX_RESULT_CHARS),
  };
}

/** Trimmed non-empty string, or null when the arg is missing/blank. */
export function strArg(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Cut `text` to `max` chars, appending `tail` on its own line when cut. */
export function truncate(text: string, max: number, tail: string): string {
  return text.length > max ? `${text.slice(0, max)}\n${tail}` : text;
}

export function depthKey(sessionID: string) {
  return `depth:${sessionID}`;
}

export function pendingKey(childID: string) {
  return `delegate:pending:${childID}`;
}

export function kidsKey(sessionID: string) {
  return `delegate:kids:${sessionID}`;
}

export function eventSessionID(event: unknown): string | undefined {
  const top = asRecord(event);
  if (!top) return undefined;
  const data = asRecord(top.data);
  if (data) {
    if (typeof data.sessionID === "string") return data.sessionID;
    const info = asRecord(data.info);
    if (info) {
      if (typeof info.sessionID === "string") return info.sessionID;
      if (typeof info.id === "string") return info.id;
    }
    if (typeof data.id === "string" && String(top.type ?? "").startsWith("session.")) {
      return data.id;
    }
  }
  if (typeof top.sessionID === "string") return top.sessionID;
  return undefined;
}

export function textOfMessage(message: unknown): string {
  const content = asRecord(message)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        const e = asRecord(entry);
        return e?.type === "text" && typeof e.text === "string" ? e.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
