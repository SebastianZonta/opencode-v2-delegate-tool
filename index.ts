// Delegate — lets a subagent (or any session) spawn its own subagent.
//
// A tool `delegate` is registered via `ctx.tool.transform`, so it shows up in
// every session's tool catalog including child sessions created by the `task`
// tool. The model discovers it through the tool description, a one-line
// system hint, and the bundled `delegate` skill.
//
// Safety rails:
// - `maxDepth` (default 3, configurable via plugin options or
//   DELEGATE_MAX_DEPTH): root session is depth 0; a session at depth N may
//   delegate only if N < maxDepth. Each delegate child records depth N+1.
// - `timeoutSeconds` per subtask (default 300): on timeout the child is
//   interrupted and whatever it produced so far is returned.
// - Results are truncated to `maxResultChars` (default 4000) so a verbose
//   child cannot flood the parent context.
// - Child sessions inherit the parent's permission rules automatically
//   (OpenCode behavior at creation time), so no rule copying is needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_RESULT_CHARS = 4000;
const MAX_PARENT_WALK = 10;

// Minimal structural types for the OpenCode plugin context. Only the
// members this plugin touches are declared, so the compiler checks our
// usage without needing the full SDK types.
interface DelegateOptions {
  maxDepth: number;
  timeoutSeconds: number;
  maxResultChars: number;
}

interface SessionInfo {
  parentID?: unknown;
}

interface StorageClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(args: { prefix: string }): Promise<{ entries?: Array<{ key: string }> }>;
}

interface SessionClient {
  get(args: { sessionID: string }): Promise<SessionInfo>;
  context(args: { sessionID: string }): Promise<unknown>;
  create(args: { title: string }): Promise<{ id?: string; data?: { id?: string } }>;
  prompt(args: { sessionID: string; text: string }): Promise<unknown>;
  wait(args: { sessionID: string }): Promise<unknown>;
  interrupt(args: { sessionID: string; continue: boolean }): Promise<unknown>;
  synthetic(args: { sessionID: string; text: string }): Promise<unknown>;
  hook(event: string, fn: (event: HookEvent) => void): Promise<{ dispose(): Promise<void> }>;
}

interface HookEvent {
  system: Array<{ type?: string; text?: string }>;
}

interface ToolExecutorCtx {
  sessionID: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  options: { codemode: boolean };
  execute: (args: unknown, toolCtx: ToolExecutorCtx) => Promise<{ content: string }>;
}

interface ToolDraft {
  add(tool: ToolDefinition): void;
}

interface SkillEditor {
  add(skill: { id: string; name: string; description: string; path: string; content: string }): void;
}

interface PluginContext {
  options: unknown;
  storage: StorageClient;
  session: SessionClient;
  tool: { transform(fn: (draft: ToolDraft) => void): Promise<{ dispose(): Promise<void> }> };
  skill: { transform(fn: (editor: SkillEditor) => void): Promise<{ dispose(): Promise<void> }> };
  event: {
    subscribe(args: { signal: AbortSignal }): AsyncIterable<{ type?: string; data?: unknown; sessionID?: string }>;
  };
}

interface DelegateArgs {
  task?: unknown;
  title?: unknown;
  sessionID?: unknown;
  background?: unknown;
  waitOnly?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
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

const CHILD_DONE_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
]);

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

function kidsKey(sessionID: string) {
  return `delegate:kids:${sessionID}`;
}

async function loadKids(ctx: PluginContext, sessionID: string): Promise<string[]> {
  try {
    const raw = await ctx.storage.get(kidsKey(sessionID));
    if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === "string");
  } catch {
    // Storage unavailable; ownership check degrades to depth-only.
  }
  return [];
}

async function recordKid(ctx: PluginContext, parentSessionID: string, childID: string, depth: number) {
  try {
    await ctx.storage.set(depthKey(childID), depth);
    await ctx.storage.set(kidsKey(parentSessionID), [...(await loadKids(ctx, parentSessionID)), childID]);
  } catch {
    // Records are best-effort; parent walk still bounds nesting.
  }
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

export default {
  id: "delegate",

  async setup(ctx: PluginContext) {
    const options = resolveOptions(ctx.options);
    const registrations: Array<{ dispose(): Promise<void> }> = [];

    async function storedDepth(sessionID: string): Promise<number | null> {
      try {
        const raw = await ctx.storage.get(depthKey(sessionID));
        if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
      } catch {
        // Storage unavailable; fall through to parent walk.
      }
      return null;
    }

    // Depth of a session: explicit record first (written at delegate
    // creation), otherwise walk the parent chain. Unknown sessions are
    // treated as depth 0 (top-level) so plain user sessions keep working.
    async function sessionDepth(sessionID: string): Promise<number> {
      const stored = await storedDepth(sessionID);
      if (stored != null) return stored;
      let depth = 0;
      let current: string | undefined = sessionID;
      for (let hop = 0; hop < MAX_PARENT_WALK && current; hop += 1) {
        let info: SessionInfo;
        try {
          info = await ctx.session.get({ sessionID: current });
        } catch {
          break;
        }
        const parentID = typeof info?.parentID === "string" ? info.parentID : undefined;
        if (!parentID) break;
        depth += 1;
        current = parentID;
      }
      return depth;
    }

    async function lastAssistantText(sessionID: string): Promise<string> {
      try {
        const messages = await ctx.session.context({ sessionID });
        const assistants = (Array.isArray(messages) ? messages : []).filter(
          (m): m is { type?: string; content?: unknown } => asRecord(m)?.type === "assistant",
        );
        const last = assistants[assistants.length - 1];
        return textOfMessage(last).trim();
      } catch {
        return "";
      }
    }

    async function waitForChild(ctx: PluginContext, childID: string, options: DelegateOptions): Promise<string> {
      const timeoutMs = options.timeoutSeconds * 1000;
      try {
        await Promise.race([
          ctx.session.wait({ sessionID: childID }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
        ]);
      } catch (error) {
        try {
          await ctx.session.interrupt({ sessionID: childID, continue: false });
        } catch {
          // Child may already be done; fall through to result harvest.
        }
        const partial = await lastAssistantText(childID);
        const note =
          error instanceof Error && error.message === "timeout"
            ? `delegate timeout after ${options.timeoutSeconds}s; child interrupted.`
            : `delegate wait failed (${error instanceof Error ? error.message : String(error)}).`;
        const body = partial
          ? `\nPartial result:\n${truncate(partial, options.maxResultChars, "…[truncated]")}`
          : "\nNo partial result.";
        return `${note}${body}`;
      }

      const result = await lastAssistantText(childID);
      if (!result) return "delegate done: child produced no text result.";
      return truncate(result, options.maxResultChars, `…[truncated, child session ${childID} holds the full transcript]`);
    }

    // Background auto-notify: when a fire-and-forget child finishes, push
    // its result into the parent session (same UX as ctrl+b background
    // tasks). Pending entries live in storage so they survive restarts;
    // timers bound the wait and interrupt runaway children.
    const backgroundTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function clearBackgroundTimer(childID: string) {
      const timer = backgroundTimers.get(childID);
      if (timer) {
        clearTimeout(timer);
        backgroundTimers.delete(childID);
      }
    }

    async function untrackBackground(childID: string) {
      clearBackgroundTimer(childID);
      try {
        await ctx.storage.remove(pendingKey(childID));
      } catch {
        // Best effort.
      }
    }

    async function notifyParent(childID: string, status: string) {
      let pending: unknown = null;
      try {
        pending = await ctx.storage.get(pendingKey(childID));
      } catch {
        return;
      }
      if (!asRecord(pending) || typeof asRecord(pending)?.parentSessionID !== "string") return;
      await untrackBackground(childID);
      const result = await lastAssistantText(childID);
      const body = result ? truncate(result, options.maxResultChars, "…[truncated]") : "(no text result)";
      try {
        await ctx.session.synthetic({
          sessionID: (pending as { parentSessionID: string }).parentSessionID,
          text: `[delegate] background child ${childID} ${status}:\n${body}`,
        });
      } catch {
        // Parent may be gone; result stays in the child session.
      }
    }

    function armBackgroundTimeout(childID: string) {
      clearBackgroundTimer(childID);
      const timer = setTimeout(() => {
        void (async () => {
          try {
            await ctx.session.interrupt({ sessionID: childID, continue: false });
          } catch {
            // Already done; harvest below reports whatever exists.
          }
          await notifyParent(childID, `timed out after ${options.timeoutSeconds}s and was interrupted`);
        })();
      }, options.timeoutSeconds * 1000);
      const maybeUnref = timer as unknown as { unref?: () => void };
      if (typeof maybeUnref.unref === "function") maybeUnref.unref();
      backgroundTimers.set(childID, timer);
    }

    async function trackBackground(childID: string, parentSessionID: string) {
      try {
        await ctx.storage.set(pendingKey(childID), { parentSessionID, since: Date.now() });
      } catch {
        // Without storage the event loop cannot route completion; the
        // caller still holds the childSessionID for manual waitOnly.
        return;
      }
      armBackgroundTimeout(childID);
    }

    // Completion watcher: route finished background children to parents.
    const eventController = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
          try {
            const type = event?.type;
            if (typeof type !== "string" || !CHILD_DONE_EVENTS.has(type)) continue;
            const childID = eventSessionID(event);
            if (!childID) continue;
            let pending: unknown = null;
            try {
              pending = await ctx.storage.get(pendingKey(childID));
            } catch {
              continue;
            }
            if (!pending) continue;
            const status =
              type === "session.execution.failed"
                ? "failed"
                : type === "session.execution.interrupted"
                  ? "was interrupted"
                  : "finished";
            await notifyParent(childID, status);
          } catch {
            // One bad event must not kill the watcher.
          }
        }
      } catch {
        // Aborted on unload.
      }
    })();

    // Re-arm timers for children that were background-dispatched before a
    // restart. Completion itself is event-driven, so nothing else is needed.
    try {
      const scan = await ctx.storage.scan({ prefix: "delegate:pending:" });
      for (const entry of scan?.entries ?? []) {
        const childID = String(entry.key).slice("delegate:pending:".length);
        if (childID) armBackgroundTimeout(childID);
      }
    } catch {
      // Scan unsupported; in-memory tracking from here on.
    }

    // Single ownership error; `verb` keeps the original collect/resume wording.
    function notOwned(childID: string, verb: "collect" | "resume"): { content: string } {
      return {
        content:
          `delegate rejected: session ${childID} is not a child of this session. ` +
          `You can only ${verb} children you spawned yourself.`,
      };
    }

    // Single harvest path: stop background tracking (so the watcher does
    // not double-notify), wait, and append the childSessionID for follow-ups.
    async function collect(childID: string): Promise<{ content: string }> {
      await untrackBackground(childID);
      const outcome = await waitForChild(ctx, childID, options);
      return { content: `${outcome}\nchildSessionID: ${childID}` };
    }

    registrations.push(
      await ctx.tool.transform((draft: ToolDraft) => {
        draft.add({
          name: "delegate",
          description:
            `Spawn a subagent for one self-contained subtask, or resume the conversation with a child you already spawned. ` +
            `Use for independent research, exploration, or isolated changes — not for trivial steps. ` +
            `New child: write 'task' as a complete brief (goal, scope, files, expected result). ` +
            `Resume: pass 'sessionID' (a previous delegate result's childSessionID) plus 'task' as the follow-up — the child keeps full context, no need to repeat instructions. ` +
            `Nesting is limited: sessions at depth ${options.maxDepth} or deeper are rejected, solve those directly. ` +
            `Every result includes the childSessionID for follow-ups. Summaries are truncated to ~${options.maxResultChars} chars; the full transcript stays in the child session. ` +
            `Background: pass 'background: true' to prompt a new child and return immediately without waiting — you are notified here when it finishes (like ctrl+b tasks); 'waitOnly: true' plus its sessionID collects manually instead.`,
          input: {
            type: "object",
            properties: {
              task: {
                type: "string",
                minLength: 1,
                description: "New child: self-contained brief. Resume: follow-up message for the existing child. Not needed when waitOnly is true.",
              },
              title: {
                type: "string",
                description: "Short session title for a new child (optional, ignored on resume).",
              },
              sessionID: {
                type: "string",
                description: "Child sessionID from a previous delegate result to resume instead of creating a new child (optional).",
              },
              background: {
                type: "boolean",
                description: "New child only: return immediately after prompting, without waiting. Collect later with waitOnly (optional).",
              },
              waitOnly: {
                type: "boolean",
                description: "With sessionID: only wait for the child and harvest its result, without sending a new prompt (optional).",
              },
            },
            required: ["task"],
            additionalProperties: false,
          },
          options: { codemode: true },
          execute: async (rawArgs: unknown, tool: ToolExecutorCtx) => {
            const parentSessionID: string = tool?.sessionID;
            const args = asRecord(rawArgs) as DelegateArgs | null;
            const task = strArg(args?.task);
            if (!task) return { content: "delegate rejected: 'task' must be a non-empty string." };

            // Collect path: wait for an owned background child, no new prompt.
            const waitOnlyID = args?.waitOnly === true ? strArg(args?.sessionID) : null;
            if (waitOnlyID) {
              const owned = await loadKids(ctx, parentSessionID);
              if (!owned.includes(waitOnlyID)) return notOwned(waitOnlyID, "collect");
              return collect(waitOnlyID);
            }

            // Resume path: same child, keeps its context.
            const resumeID = strArg(args?.sessionID);
            if (resumeID) {
              const owned = await loadKids(ctx, parentSessionID);
              if (!owned.includes(resumeID)) return notOwned(resumeID, "resume");
              await untrackBackground(resumeID);
              try {
                await ctx.session.prompt({ sessionID: resumeID, text: task });
              } catch (error) {
                return { content: `delegate failed: could not prompt child session (${error instanceof Error ? error.message : String(error)}).` };
              }
              return collect(resumeID);
            }

            // New child path.
            const depth = await sessionDepth(parentSessionID);
            if (depth >= options.maxDepth) {
              return {
                content:
                  `delegate rejected: nesting limit reached (session depth ${depth}, max ${options.maxDepth}). ` +
                  `Solve this directly instead of delegating.`,
              };
            }

            let childID: string;
            try {
              const child = await ctx.session.create({
                title: strArg(args?.title)?.slice(0, 80) ?? "delegated subtask",
              });
              childID = child?.id ?? child?.data?.id ?? "";
              if (!childID) throw new Error("session.create returned no id");
            } catch (error) {
              return { content: `delegate failed: could not create child session (${error instanceof Error ? error.message : String(error)}).` };
            }

            await recordKid(ctx, parentSessionID, childID, depth + 1);

            try {
              await ctx.session.prompt({ sessionID: childID, text: task });
            } catch (error) {
              return { content: `delegate failed: could not prompt child session (${error instanceof Error ? error.message : String(error)}). childSessionID: ${childID}` };
            }

            // Background: fire-and-forget with completion notify (ctrl+b
            // style); caller may also collect manually with waitOnly.
            if (args?.background === true) {
              await trackBackground(childID, parentSessionID);
              return {
                content:
                  `delegate dispatched in background; child ${childID} is working. ` +
                  `You will be notified here when it finishes; or collect it yourself with delegate({ sessionID: "${childID}", task: "...", waitOnly: true }).\nchildSessionID: ${childID}`,
              };
            }

            return collect(childID);
          },
        });
      }),
    );

    // One-line hint so subagents notice the tool without reading the skill.
    registrations.push(
      await ctx.session.hook("context", (event: HookEvent) => {
        const hint = `You may spawn one subagent per independent subtask with the 'delegate' tool (max nesting depth ${options.maxDepth}); trivial steps do directly.`;
        if (event.system.some((p) => p?.type === "text" && typeof p.text === "string" && p.text.includes("'delegate' tool")))
          return;
        event.system.push({ type: "text", text: hint });
      }),
    );

    // Skill with usage examples.
    try {
      const location = path.join(PLUGIN_DIR, "SKILL.md");
      const body = fs.readFileSync(location, "utf8");
      registrations.push(
        await ctx.skill.transform((editor: SkillEditor) => {
          editor.add({
            id: "delegate",
            name: "delegate",
            description: `Spawn a subagent for one self-contained subtask (resumable; max depth ${options.maxDepth}).`,
            path: location,
            content: body,
          });
        }),
      );
    } catch {
      // Skill is additive; tool + hint work without it.
    }

    return async () => {
      eventController.abort();
      for (const childID of [...backgroundTimers.keys()]) clearBackgroundTimer(childID);
      for (const r of registrations) {
        try {
          await r.dispose();
        } catch {
          // Unload must not throw.
        }
      }
    };
  },
};
