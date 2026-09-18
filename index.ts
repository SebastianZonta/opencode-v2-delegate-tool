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

function positiveInt(raw: unknown, fallback: number): number {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : (raw as number);
  return Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : fallback;
}

function resolveOptions(raw: any) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    maxDepth: positiveInt(
      o.maxDepth ?? process.env.DELEGATE_MAX_DEPTH,
      DEFAULT_MAX_DEPTH,
    ),
    timeoutSeconds: positiveInt(o.timeoutSeconds ?? process.env.DELEGATE_TIMEOUT_SECONDS, DEFAULT_TIMEOUT_SECONDS),
    maxResultChars: positiveInt(o.maxResultChars ?? process.env.DELEGATE_MAX_RESULT_CHARS, DEFAULT_MAX_RESULT_CHARS),
  };
}

function depthKey(sessionID: string) {
  return `depth:${sessionID}`;
}

function pendingKey(childID: string) {
  return `delegate:pending:${childID}`;
}

const CHILD_DONE_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
]);

function eventSessionID(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const data = (event as any).data;
  if (data && typeof data === "object") {
    if (typeof data.sessionID === "string") return data.sessionID;
    const info = (data as any).info;
    if (info && typeof info === "object") {
      if (typeof info.sessionID === "string") return info.sessionID;
      if (typeof info.id === "string") return info.id;
    }
    if (typeof (data as any).id === "string" && String((event as any).type ?? "").startsWith("session.")) {
      return (data as any).id;
    }
  }
  if (typeof (event as any).sessionID === "string") return (event as any).sessionID;
  return undefined;
}

function kidsKey(sessionID: string) {
  return `delegate:kids:${sessionID}`;
}

async function loadKids(ctx: any, sessionID: string): Promise<string[]> {
  try {
    const raw = await ctx.storage.get(kidsKey(sessionID));
    if (Array.isArray(raw)) return raw.filter((id) => typeof id === "string");
  } catch {
    // Storage unavailable; ownership check degrades to depth-only.
  }
  return [];
}

async function recordKid(ctx: any, parentSessionID: string, childID: string, depth: number) {
  try {
    await ctx.storage.set(depthKey(childID), depth);
    await ctx.storage.set(kidsKey(parentSessionID), [...(await loadKids(ctx, parentSessionID)), childID]);
  } catch {
    // Records are best-effort; parent walk still bounds nesting.
  }
}

function textOfMessage(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((entry: any) => {
        if (!entry || typeof entry !== "object") return "";
        if (entry.type === "text" && typeof entry.text === "string") return entry.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export default {
  id: "delegate",

  async setup(ctx: any) {
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
        let info: any;
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
        const assistants = (Array.isArray(messages) ? messages : []).filter((m: any) => m?.type === "assistant");
        const last = assistants[assistants.length - 1];
        return textOfMessage(last).trim();
      } catch {
        return "";
      }
    }

    async function waitForChild(ctx: any, childID: string, options: { timeoutSeconds: number; maxResultChars: number }): Promise<string> {
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
        const body = partial ? `\nPartial result:\n${partial.slice(0, options.maxResultChars)}` : "\nNo partial result.";
        return `${note}${body}`;
      }

      const result = await lastAssistantText(childID);
      if (!result) return "delegate done: child produced no text result.";
      return result.length > options.maxResultChars
        ? `${result.slice(0, options.maxResultChars)}\n…[truncated, child session ${childID} holds the full transcript]`
        : result;
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
      let pending: any = null;
      try {
        pending = await ctx.storage.get(pendingKey(childID));
      } catch {
        return;
      }
      if (!pending || typeof pending !== "object" || typeof pending.parentSessionID !== "string") return;
      await untrackBackground(childID);
      const result = await lastAssistantText(childID);
      const body = result
        ? result.length > options.maxResultChars
          ? `${result.slice(0, options.maxResultChars)}\n…[truncated]`
          : result
        : "(no text result)";
      try {
        await ctx.session.synthetic({
          sessionID: pending.parentSessionID,
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
            const type = (event as any)?.type;
            if (typeof type !== "string" || !CHILD_DONE_EVENTS.has(type)) continue;
            const childID = eventSessionID(event);
            if (!childID) continue;
            let pending: any = null;
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

    registrations.push(
      await ctx.tool.transform((draft: any) => {
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
          execute: async (args: any, tool: any) => {
            const parentSessionID: string = tool?.sessionID;
            const task = typeof args?.task === "string" ? args.task.trim() : "";
            if (!task) return { content: "delegate rejected: 'task' must be a non-empty string." };

            // Collect path: wait for an owned background child, no new prompt.
            // Takes over tracking so the completion watcher does not
            // double-notify.
            const waitOnlyID = args?.waitOnly === true && typeof args?.sessionID === "string" && args.sessionID.trim() ? args.sessionID.trim() : null;
            if (waitOnlyID) {
              const owned = await loadKids(ctx, parentSessionID);
              if (!owned.includes(waitOnlyID)) {
                return {
                  content:
                    `delegate rejected: session ${waitOnlyID} is not a child of this session. ` +
                    `You can only collect children you spawned yourself.`,
                };
              }
              await untrackBackground(waitOnlyID);
              const outcome = await waitForChild(ctx, waitOnlyID, options);
              return { content: `${outcome}\nchildSessionID: ${waitOnlyID}` };
            }

            // Resume path: same child, keeps its context. Takes over
            // tracking (synchronous wait below reports the result).
            const resumeID = typeof args?.sessionID === "string" && args.sessionID.trim() ? args.sessionID.trim() : null;
            if (resumeID) {
              const owned = await loadKids(ctx, parentSessionID);
              if (!owned.includes(resumeID)) {
                return {
                  content:
                    `delegate rejected: session ${resumeID} is not a child of this session. ` +
                    `You can only resume children you spawned yourself.`,
                };
              }
              await untrackBackground(resumeID);
              try {
                await ctx.session.prompt({ sessionID: resumeID, text: task });
              } catch (error) {
                return { content: `delegate failed: could not prompt child session (${error instanceof Error ? error.message : String(error)}).` };
              }
              const outcome = await waitForChild(ctx, resumeID, options);
              return { content: `${outcome}\nchildSessionID: ${resumeID}` };
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
                title: typeof args?.title === "string" && args.title.trim() ? args.title.trim().slice(0, 80) : "delegated subtask",
              });
              childID = child?.id ?? child?.data?.id;
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

            const outcome = await waitForChild(ctx, childID, options);
            return { content: `${outcome}\nchildSessionID: ${childID}` };
          },
        });
      }),
    );

    // One-line hint so subagents notice the tool without reading the skill.
    registrations.push(
      await ctx.session.hook("context", (event: any) => {
        const hint = `You may spawn one subagent per independent subtask with the 'delegate' tool (max nesting depth ${options.maxDepth}); trivial steps do directly.`;
        if (event.system.some((p: any) => p?.type === "text" && typeof p.text === "string" && p.text.includes("'delegate' tool")))
          return;
        event.system.push({ type: "text", text: hint });
      }),
    );

    // Skill with usage examples.
    try {
      const location = path.join(PLUGIN_DIR, "SKILL.md");
      const body = fs.readFileSync(location, "utf8");
      registrations.push(
        await ctx.skill.transform((editor: any) => {
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
