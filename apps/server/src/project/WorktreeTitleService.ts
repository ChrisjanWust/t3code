import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  ProjectRegenerateWorktreeTitleError,
  type ProjectRegenerateWorktreeTitleInput,
  type ProjectWorktreeTitle,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectService from "./ProjectService.ts";
import {
  formatWorktreeTitleContext,
  isWorktreeTitleRefreshDue,
  selectWorktreeTitleWindow,
  WORKTREE_TITLE_COOLDOWN_MS,
  worktreeTitleRequests,
} from "./WorktreeTitlePolicy.ts";

const WORKTREE_TITLE_INSTRUCTIONS =
  "The text is the user's own messages from the most recent threads in one worktree, newest thread first. Title the work they share in 3-9 words; when they differ, favor the newest thread.";
const WORKTREE_TITLE_MAX_LENGTH = 80;

export class WorktreeTitleService extends Context.Service<
  WorktreeTitleService,
  {
    /** Titles the thread's worktree when it has none, or refreshes it when the policy says so. */
    readonly refresh: (threadId: ThreadId) => Effect.Effect<void>;
    /** Writes a new title now, replacing a manual one. Null when there is nothing to title yet. */
    readonly regenerate: (
      input: ProjectRegenerateWorktreeTitleInput,
    ) => Effect.Effect<ProjectWorktreeTitle | null, ProjectRegenerateWorktreeTitleError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/project/WorktreeTitleService") {}

type Mode = "refresh" | "regenerate";

const keyOf = (key: { readonly projectId: ProjectId; readonly worktreePath: string }) =>
  JSON.stringify([key.projectId, key.worktreePath]);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  // One generation per worktree at a time; overlapping triggers would only race to the same write.
  const inFlight = new Set<string>();
  // Failed or empty generations write nothing, so the cooldown alone would retry them on every run.
  const lastAttemptAt = new Map<string, number>();

  const userRequests = Effect.fn("WorktreeTitleService.userRequests")(function* (
    threadId: ThreadId,
  ) {
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user"],
    });
    return worktreeTitleRequests(messages);
  });

  const generate = Effect.fn("WorktreeTitleService.generate")(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly mode: Mode;
  }) {
    const row = yield* projectStore.get(input.projectId);
    if (Option.isNone(row)) return null;
    const entry = row.value.worktreeTitles.find(
      (candidate) => candidate.worktreePath === input.worktreePath,
    );
    const { threads } = yield* projections.getShellSnapshot({
      location: "active",
      projectId: input.projectId,
      worktreePath: input.worktreePath,
    });
    const window = selectWorktreeTitleWindow(
      threads
        .filter((thread) => thread.lineage.relationshipToParent !== "subagent")
        .map((thread) => ({
          id: thread.id,
          title: thread.title,
          lastUserMessageAt:
            thread.latestUserAuthoredMessageAt == null
              ? null
              : DateTime.toEpochMillis(thread.latestUserAuthoredMessageAt),
        })),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const key = keyOf(input);
    if (
      input.mode === "refresh" &&
      (!isWorktreeTitleRefreshDue({ entry, window, now }) ||
        now - (lastAttemptAt.get(key) ?? -Infinity) < WORKTREE_TITLE_COOLDOWN_MS)
    ) {
      return entry ?? null;
    }
    if (window.length === 0) return entry ?? null;

    const sources = yield* Effect.forEach(window, (thread) =>
      userRequests(thread.id).pipe(Effect.map((requests) => ({ title: thread.title, requests }))),
    );
    if (sources.every((source) => source.requests.length === 0)) return entry ?? null;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      input.projectId,
    ).settings;
    lastAttemptAt.set(key, now);
    const generated = yield* textGeneration.generateThreadTitle({
      cwd: input.worktreePath,
      message: formatWorktreeTitleContext(sources),
      ...(input.mode === "refresh" && entry?.generated != null
        ? { previousTitle: entry.generated }
        : {}),
      instructions: WORKTREE_TITLE_INSTRUCTIONS,
      // Worktree context mixes several threads, so their links say little about the shared work.
      linkedContext: "",
      modelSelection: settings.textGenerationModelSelection,
    });
    const title = generated.title.trim().slice(0, WORKTREE_TITLE_MAX_LENGTH).trim();
    if (title.length === 0) return entry ?? null;

    yield* projects.updateWorktreeTitle({
      commandId: CommandId.make(`server:worktree-title:${yield* crypto.randomUUIDv4()}`),
      projectId: input.projectId,
      worktreePath: input.worktreePath,
      change: {
        type: "generated",
        title,
        sourceThreadIds: window.map((thread) => thread.id),
        replaceManual: input.mode === "regenerate",
      },
    });
    const updated = yield* projectStore.get(input.projectId);
    return Option.isNone(updated)
      ? null
      : (updated.value.worktreeTitles.find(
          (candidate) => candidate.worktreePath === input.worktreePath,
        ) ?? null);
  });

  const exclusive = <A, E, R>(
    key: { readonly projectId: ProjectId; readonly worktreePath: string },
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Option.Option<A>, E, R> => {
    const id = keyOf(key);
    return Effect.suspend(() => {
      if (inFlight.has(id)) return Effect.succeedNone;
      inFlight.add(id);
      return effect.pipe(Effect.asSome, Effect.ensuring(Effect.sync(() => inFlight.delete(id))));
    });
  };

  const refresh: WorktreeTitleService["Service"]["refresh"] = Effect.fn(
    "WorktreeTitleService.refresh",
  )(
    function* (threadId) {
      const thread = yield* projections.getThreadShell(threadId);
      if (
        thread === null ||
        thread.worktreePath === null ||
        thread.archivedAt !== null ||
        thread.lineage.relationshipToParent === "subagent"
      ) {
        return;
      }
      const key = { projectId: thread.projectId, worktreePath: thread.worktreePath };
      yield* exclusive(key, generate({ ...key, mode: "refresh" }));
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Worktree title refresh failed", { threadId, cause }),
        ),
      ),
  );

  const regenerate: WorktreeTitleService["Service"]["regenerate"] = Effect.fn(
    "WorktreeTitleService.regenerate",
  )(function* (input) {
    const result = yield* exclusive(input, generate({ ...input, mode: "regenerate" })).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectRegenerateWorktreeTitleError({
            message: "Could not generate a worktree title.",
            cause,
          }),
      ),
    );
    if (Option.isNone(result)) {
      return yield* new ProjectRegenerateWorktreeTitleError({
        message: "This worktree's title is already being generated.",
      });
    }
    return result.value;
  });

  // A run starting is the cheap signal that the user just wrote in a thread.
  const isRunStart = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" && event.payload.status === "running";

  const start: WorktreeTitleService["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        // Generation takes seconds; do not hold up the event stream behind it.
        isRunStart(event) ? Effect.forkScoped(refresh(event.threadId)) : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Worktree title event stream failed", { cause }),
        ),
      ),
    );

  return WorktreeTitleService.of({ refresh, regenerate, start });
});

export const layer = Layer.effect(WorktreeTitleService, make);
