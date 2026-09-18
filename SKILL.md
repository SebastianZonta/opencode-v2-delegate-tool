# Delegate skill

Use `delegate` when a task splits into an independent subtask that can run in
isolation (research, exploration, or a self-contained change). Do NOT use it
for trivial steps you can do directly, and never delegate back work the
parent already gave you — that loops.

Rules:

- One subtask per call. Write the `task` as a complete, self-contained
  brief: goal, scope, files involved, and what to return.
- Ask for a short result (a summary plus file paths); the full transcript
  stays in the child session.
- If the tool rejects with a depth-limit message, solve it directly instead
  of retrying or rewording.
- Never ask the child to delegate further when you are already deep; the
  depth budget is small on purpose.

Example:

```json
{
  "task": "Explore how auth tokens are refreshed. Read the relevant files, trace the flow, and return: files involved, refresh trigger, and expiry handling. Keep it under 20 lines."
}
```

## Resuming a child

Every result ends with `childSessionID: <id>`. To continue that same
conversation — the child keeps full context, so do NOT repeat the brief —
call again with `sessionID` plus the follow-up as `task`:

```json
{
  "sessionID": "<childSessionID from the previous result>",
  "task": "You reported expiry is 15 min but found no refresh call. Search for background jobs or interceptors that might trigger it and update your verdict."
}
```

Only children you spawned yourself can be resumed; anything else is
rejected. Resuming does not consume nesting depth.

## Background dispatch

To keep solving while children work, pass `background: true` on creation:
the call returns immediately with the `childSessionID` while the child runs.
When the child finishes you are **notified here automatically** (same UX as
ctrl+b background tasks — a `[delegate] background child …` message lands in
this session). No polling needed; `waitOnly` remains as manual fallback:

1. `delegate({ task: "brief ejercicio 27.27…", background: true })` → child A
2. `delegate({ task: "brief ejercicio 27.28…", background: true })` → child B
3. …keep solving the main task…
4. Notification arrives: `[delegate] background child <A> finished: …`
5. Still want to pull manually? `delegate({ sessionID: "<B>", task: "collect", waitOnly: true })`

The `task` text is still required on collect calls but ignored; only
`sessionID` + `waitOnly` matter there. Background children that exceed the
timeout are interrupted and their partial result is notified the same way.
