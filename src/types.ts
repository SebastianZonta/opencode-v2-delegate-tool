// Shared structural types for the delegate plugin. Only the members the
// plugin touches are declared, so usage is checked without needing the
// full OpenCode SDK types.

export interface DelegateOptions {
  maxDepth: number;
  timeoutSeconds: number;
  maxResultChars: number;
}

export interface SessionInfo {
  parentID?: unknown;
}

export interface StorageClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  scan(args: { prefix: string }): Promise<{ entries?: Array<{ key: string }> }>;
}

export interface SessionClient {
  get(args: { sessionID: string }): Promise<SessionInfo>;
  context(args: { sessionID: string }): Promise<unknown>;
  create(args: { title: string }): Promise<{ id?: string; data?: { id?: string } }>;
  prompt(args: { sessionID: string; text: string }): Promise<unknown>;
  wait(args: { sessionID: string }): Promise<unknown>;
  interrupt(args: { sessionID: string; continue: boolean }): Promise<unknown>;
  synthetic(args: { sessionID: string; text: string }): Promise<unknown>;
  hook(event: string, fn: (event: HookEvent) => void): Promise<{ dispose(): Promise<void> }>;
}

export interface HookEvent {
  system: Array<{ type?: string; text?: string }>;
}

export interface ToolExecutorCtx {
  sessionID: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input: unknown;
  options: { codemode: boolean };
  execute: (args: unknown, toolCtx: ToolExecutorCtx) => Promise<{ content: string }>;
}

export interface ToolDraft {
  add(tool: ToolDefinition): void;
}

export interface SkillEditor {
  add(skill: { id: string; name: string; description: string; path: string; content: string }): void;
}

export interface PluginContext {
  options: unknown;
  storage: StorageClient;
  session: SessionClient;
  tool: { transform(fn: (draft: ToolDraft) => void): Promise<{ dispose(): Promise<void> }> };
  skill: { transform(fn: (editor: SkillEditor) => void): Promise<{ dispose(): Promise<void> }> };
  event: {
    subscribe(args: { signal: AbortSignal }): AsyncIterable<{ type?: string; data?: unknown; sessionID?: string }>;
  };
}

export interface DelegateArgs {
  task?: unknown;
  title?: unknown;
  sessionID?: unknown;
  background?: unknown;
  waitOnly?: unknown;
}
