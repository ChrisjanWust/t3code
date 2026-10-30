// An in-process environment for app render scenarios: a fetch stub for its HTTP API and a
// session that answers the shell, thread and config subscriptions from fixtures, and applies
// settle commands. Other RPCs stay pending so nothing retries on timers. Everything above
// the wire is the app's own.
import {
  AuthStandardClientScopes,
  EnvironmentId,
  EventId,
  ExecutionEnvironmentDescriptor,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ServerConfig,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  WsRpcGroup,
  type ExecutionEnvironmentCapabilities,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type ProjectMutation,
  type ProjectWorktreeTitle,
} from "@t3tools/contracts";
import type {
  ConnectionAttemptError,
  ConnectionCatalogEntry,
  EnvironmentConnectionLease,
  RouteCheck,
} from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { APP_VERSION } from "~/branding";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcSchema } from "effect/rpc";

export const ENVIRONMENT_ID = EnvironmentId.make("environment-render");
const PROJECT_ID = ProjectId.make("project-render");
const CODEX = ProviderInstanceId.make("codex");
const MODEL = { instanceId: CODEX, model: "gpt-5.4" };
const AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");

const makeDescriptor = (capabilities: Partial<ExecutionEnvironmentCapabilities>) => ({
  environmentId: ENVIRONMENT_ID,
  label: "Render scenarios",
  platform: { os: "linux", arch: "x64" },
  // A matching version, since a mismatch adds an update banner a typical user never sees.
  serverVersion: APP_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true, ...capabilities },
});
let descriptor = makeDescriptor({});
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "t3_session",
};

const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const encodeDescriptor = Schema.encodeSync(ExecutionEnvironmentDescriptor);

const makeServerConfig = (): ServerConfig => ({
  ...decodeServerConfig({
    environment: descriptor,
    auth,
    cwd: "/workspace/render",
    keybindingsConfigPath: "/workspace/.t3/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        instanceId: CODEX,
        driver: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-03-17T19:12:28.000Z",
        models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/.t3/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
    threadSnapshotPagination: true,
    threadResumeCompletionMarker: true,
    shellResumeCompletionMarker: true,
  }),
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
});
let serverConfig = makeServerConfig();

const baseProject: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "render",
  workspaceRoot: "/workspace/render",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-03-17T19:12:28.000Z",
  updatedAt: "2026-03-17T19:12:28.000Z",
};
let project = baseProject;

const base = (threadId: ThreadId, runId: RunId, id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: AT,
  completedAt: AT,
  updatedAt: AT,
});

function userItem(threadId: ThreadId, runId: RunId, id: string, ordinal: number, text: string) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  } satisfies OrchestrationV2TurnItem;
}

export function assistantItem(
  threadId: ThreadId,
  runId: RunId,
  id: string,
  ordinal: number,
  text: string,
  streaming = false,
) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming,
    ...(streaming ? { status: "running" as const, completedAt: null } : {}),
  } satisfies OrchestrationV2TurnItem;
}

function run(threadId: ThreadId, id: RunId, ordinal: number, userMessageId: string) {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: CODEX,
    modelSelection: MODEL,
    providerThreadId: null,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: AT,
    startedAt: AT,
    completedAt: AT,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

export interface FakeThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  /** The project checkout when absent. */
  readonly worktreePath?: string;
  /** `main` when absent. */
  readonly branch?: string | null;
  readonly creatingWorktree?: boolean;
}

/** A thread of `turns` user prompts, each answered in markdown with a list and inline code. */
export function threadWithHistory(name: string, turns: number): FakeThread {
  const id = ThreadId.make(name);
  const runs: OrchestrationV2Run[] = [];
  const items: OrchestrationV2TurnItem[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const runId = RunId.make(`${name}-run-${turn}`);
    runs.push(run(id, runId, turn + 1, `${name}-user-${turn}`));
    items.push(
      userItem(id, runId, `${name}-user-${turn}`, turn * 2, `${name}: question ${turn}`),
      assistantItem(
        id,
        runId,
        `${name}-assistant-${turn}`,
        turn * 2 + 1,
        `Answer ${turn} for ${name}.\n\n- checked \`Sidebar.tsx\`\n- ran the tests\n\n` +
          "The width is now `clamp(next, MIN_WIDTH, MAX_WIDTH)`, so the layout no longer jumps.",
      ),
    );
  }
  return { id, title: `Thread ${name}`, runs, items };
}

// Keyed by thread id: what settle commands changed since the fixture was installed.
const settlement = new Map<
  string,
  Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt" | "updatedAt">
>();

function shellOf(thread: FakeThread): OrchestrationV2ThreadShell {
  const latest = thread.runs.at(-1);
  return {
    ...baseShellOf(thread, latest),
    ...settlement.get(thread.id),
  };
}

function baseShellOf(
  thread: FakeThread,
  latest: OrchestrationV2Run | undefined,
): OrchestrationV2ThreadShell {
  return {
    id: thread.id,
    projectId: PROJECT_ID,
    title: thread.title,
    providerInstanceId: CODEX,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: thread.branch === undefined ? "main" : thread.branch,
    worktreePath: thread.worktreePath ?? null,
    ...(thread.creatingWorktree === undefined ? {} : { creatingWorktree: thread.creatingWorktree }),
    activeProviderThreadId: null,
    lineage: { rootThreadId: thread.id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latest?.id ?? null,
    activeRunId: null,
    // Idle reads as waiting on the user, which shows a per-second duration in the sidebar.
    status: latest ? "completed" : "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: AT,
    hasActionableProposedPlan: false,
    itemCount: thread.items.length,
    visibleItemCount: thread.items.length,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: AT,
    deletedAt: null,
  };
}

function projectionOf(thread: FakeThread): OrchestrationV2ThreadProjection {
  const shell = shellOf(thread);
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = thread.items.map(
    (item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: thread.id,
      sourceItemId: item.id,
      item,
    }),
  );
  return {
    thread: {
      id: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      providerInstanceId: shell.providerInstanceId,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      activeProviderThreadId: null,
      lineage: shell.lineage,
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: AT,
      deletedAt: null,
    },
    runs: [...thread.runs],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [...thread.items],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: AT,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Keyed by thread id: a live thread subscription's queue, for pushing events to it.
const threadSubscribers = new Map<string, Queue.Queue<OrchestrationV2ThreadStreamItem>>();
const shellSubscribers = new Set<Queue.Queue<OrchestrationV2ShellStreamItem>>();
let threads: ReadonlyArray<FakeThread> = [];
let sequence = 1;
let dispatched: OrchestrationV2Command[] = [];
let projectMutations: ProjectMutation[] = [];

const publishShell = (thread: FakeThread) => {
  sequence += 1;
  const item: OrchestrationV2ShellStreamItem = {
    kind: "thread.updated",
    sequence,
    location: "active",
    thread: shellOf(thread),
  };
  for (const queue of shellSubscribers) Effect.runSync(Queue.offer(queue, item));
};

const shellSnapshot = (): OrchestrationV2ShellStreamItem => ({
  kind: "snapshot",
  snapshot: {
    schemaVersion: 1,
    snapshotSequence: sequence,
    projects: [project],
    threads: threads.map(shellOf),
    archivedThreads: [],
  },
});

// Worktree titles land as the server's projection would; other mutations are only recorded.
const applyProjectMutation = (mutation: ProjectMutation) => {
  projectMutations.push(mutation);
  if (mutation.type === "project.worktree-title.set") {
    const existing = project.worktreeTitles?.find(
      (entry) => entry.worktreePath === mutation.worktreePath,
    );
    project = {
      ...project,
      worktreeTitles: [
        ...(project.worktreeTitles ?? []).filter((entry) => entry !== existing),
        {
          worktreePath: mutation.worktreePath,
          generated: existing?.generated ?? null,
          manual: mutation.title,
          sourceThreadIds: existing?.sourceThreadIds ?? [],
          generatedAt: existing?.generatedAt ?? null,
          updatedAt: DateTime.formatIso(AT),
        },
      ],
    };
    sequence += 1;
    const item: OrchestrationV2ShellStreamItem = { kind: "project.updated", sequence, project };
    for (const queue of shellSubscribers) Effect.runSync(Queue.offer(queue, item));
  }
  return { ...project, deletedAt: null };
};

// Settle and unsettle land as the server's projection would; other commands are only recorded.
const applyCommand = (command: OrchestrationV2Command) => {
  dispatched.push(command);
  if (command.type !== "thread.settle" && command.type !== "thread.unsettle") return;
  const thread = threads.find((candidate) => candidate.id === command.threadId);
  if (!thread) return;
  const now = DateTime.makeUnsafe(Date.now());
  settlement.set(
    thread.id,
    command.type === "thread.settle"
      ? { settledOverride: "settled", settledAt: command.settledAt ?? now, updatedAt: now }
      : { settledOverride: "active", settledAt: null, updatedAt: now },
  );
  publishShell(thread);
};

const subscribe = <A>(first: ReadonlyArray<A>, register?: (queue: Queue.Queue<A>) => () => void) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<A>();
      yield* Queue.offerAll(queue, first);
      if (register) {
        const unregister = register(queue);
        yield* Effect.addFinalizer(() => Effect.sync(unregister));
      }
      return Stream.fromQueue(queue);
    }),
  );

const handlers: Record<string, (input: never) => unknown> = {
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
    subscribe<OrchestrationV2ShellStreamItem>(
      [shellSnapshot(), { kind: "synchronized" }],
      (queue) => {
        shellSubscribers.add(queue);
        return () => void shellSubscribers.delete(queue);
      },
    ),
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
    Effect.sync(() => {
      applyCommand(command);
      return { sequence };
    }),
  [WS_METHODS.projectsMutate]: (mutation: ProjectMutation) =>
    Effect.sync(() => applyProjectMutation(mutation)),
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) => {
    const thread = threads.find((candidate) => candidate.id === input.threadId);
    if (!thread) return Stream.never;
    return subscribe<OrchestrationV2ThreadStreamItem>(
      [
        { kind: "snapshot", snapshotSequence: sequence, projection: projectionOf(thread) },
        { kind: "synchronized" },
      ],
      (queue) => {
        threadSubscribers.set(thread.id, queue);

        // A replaced subscription closes after its successor registers.
        return () => {
          if (threadSubscribers.get(thread.id) === queue) threadSubscribers.delete(thread.id);
        };
      },
    );
  },
  [WS_METHODS.subscribeServerConfig]: () =>
    subscribe([{ version: 1 as const, type: "snapshot" as const, config: serverConfig }]),
};

// Unanswered calls stay pending, like a server that has not replied yet.
const client = new Proxy(handlers, {
  get: (target, method: string) =>
    target[method] ??
    (() => {
      const rpc = WsRpcGroup.requests.get(method);
      return rpc && RpcSchema.isStreamSchema(rpc.successSchema) ? Stream.never : Effect.never;
    }),
});

const session: EnvironmentConnectionLease["session"] = {
  client: client as unknown as WsRpcProtocolClient,
  initialConfig: Effect.sync(() => serverConfig),
  subscribeServerConfig: () =>
    subscribe([{ version: 1 as const, type: "snapshot" as const, config: serverConfig }]),
  ready: Effect.void,
  probe: Effect.void,
  inboundFrames: Effect.succeed(0),
  closed: Effect.never,
};

/** Stands in for client-runtime's ConnectionDriver: every connection opens the session above. */
export const fakeDriver = {
  connect: (
    entry: ConnectionCatalogEntry,
  ): Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope> =>
    Effect.succeed({
      prepared: {
        environmentId: ENVIRONMENT_ID,
        label: descriptor.label,
        httpBaseUrl: window.location.origin,
        socketUrl: window.location.origin.replace(/^http/, "ws"),
        httpAuthorization: null,
        target: entry.target,
      },
      session,
    }),
  preflight: () => Effect.succeed(true),
  checkHost: () => Effect.succeed<RouteCheck>("unchecked"),
};
export type FakeDriver = typeof fakeDriver;

const realFetch = globalThis.fetch;

/** Serves the environment's HTTP API and these threads until disposed. */
export function installFakeEnvironment(
  fixtures: ReadonlyArray<FakeThread>,
  options: {
    readonly capabilities?: Partial<ExecutionEnvironmentCapabilities>;
    readonly worktreeTitles?: ReadonlyArray<ProjectWorktreeTitle>;
  } = {},
): Disposable {
  threads = fixtures;
  project =
    options.worktreeTitles === undefined
      ? baseProject
      : { ...baseProject, worktreeTitles: options.worktreeTitles };
  descriptor = makeDescriptor(options.capabilities ?? {});
  serverConfig = makeServerConfig();
  const encodedDescriptor = encodeDescriptor(decodeDescriptor(descriptor));
  // The app keeps its connection across mounts, so live subscriptions resync as on a reconnect.
  sequence += 1;
  for (const queue of shellSubscribers) Effect.runSync(Queue.offer(queue, shellSnapshot()));
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin) return realFetch(input, init);
    if (url.pathname === "/.well-known/t3/environment") return json(encodedDescriptor);
    if (url.pathname === "/api/auth/session") {
      return json({
        authenticated: true,
        auth,
        scopes: AuthStandardClientScopes,
        sessionMethod: "browser-session-cookie",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    // Snapshot endpoints fall back to the socket, which serves the same fixtures.
    if (/^\/(api|oauth|\.well-known)\//.test(url.pathname)) return json({}, 404);
    return realFetch(input, init);
  };
  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = realFetch;
      threads = [];
      settlement.clear();
      dispatched = [];
      projectMutations = [];
      project = baseProject;
    },
  };
}

type ThreadEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>["event"];

/** Whether the app holds a live subscription to the thread, so events reach it. */
export function isThreadSubscribed(threadId: ThreadId): boolean {
  return threadSubscribers.has(threadId);
}

/** Delivers one domain event, such as a run or turn-item update, to the thread's subscription. */
export async function emitThreadEvent(
  threadId: ThreadId,
  event: Pick<ThreadEvent, "type" | "payload">,
): Promise<void> {
  const queue = threadSubscribers.get(threadId);
  if (!queue) throw new Error(`No live subscription for ${threadId}`);
  sequence += 1;
  await Effect.runPromise(
    Queue.offer(queue, {
      kind: "event",
      sequence,
      event: { ...event, id: EventId.make(`event-${sequence}`), threadId, occurredAt: AT },
    } as OrchestrationV2ThreadStreamItem),
  );
}

/** The project mutations the app has sent, oldest first. */
export function dispatchedProjectMutations(): ReadonlyArray<ProjectMutation> {
  return projectMutations;
}

/** The orchestration commands the app has sent, oldest first. */
export function dispatchedCommands(): ReadonlyArray<OrchestrationV2Command> {
  return dispatched;
}

/** Adds a thread the server created, such as a fork, and publishes it to the shell. */
export function addServerThread(thread: FakeThread): void {
  threads = [...threads, thread];
  publishShell(thread);
}

/** Changes a thread as the server would, such as recording its new worktree, and publishes it. */
export function updateServerThread(threadId: ThreadId, patch: Partial<FakeThread>): void {
  threads = threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
  const updated = threads.find((thread) => thread.id === threadId);
  if (updated) publishShell(updated);
}

export function runningRun(threadId: ThreadId, id: string, ordinal: number, userMessageId: string) {
  return {
    ...run(threadId, RunId.make(id), ordinal, userMessageId),
    status: "running" as const,
    completedAt: null,
  };
}

export { userItem };
