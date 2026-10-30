import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  MessageId,
  ProjectId,
  type ProjectWorktreeTitle,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectService from "./ProjectService.ts";
import * as WorktreeTitleService from "./WorktreeTitleService.ts";

const projectId = ProjectId.make("project:worktree-title");
const worktreePath = "/repo/.t3/worktrees/pairing";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in worktree title tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness() {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "worktree-title" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  let titles: ReadonlyArray<ProjectWorktreeTitle> = [];
  const generateThreadTitle = vi.fn((_input: TextGeneration.ThreadTitleGenerationInput) =>
    Effect.succeed({ title: "Pairing token expiry" }),
  );
  const updateWorktreeTitle = vi.fn((input: ProjectService.ProjectWorktreeTitleInput) =>
    Effect.sync(() => {
      if (input.change.type !== "generated") return;
      titles = [
        {
          worktreePath: input.worktreePath,
          generated: input.change.title,
          manual: null,
          sourceThreadIds: input.change.sourceThreadIds,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
    }),
  );
  const layerService = WorktreeTitleService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerOrchestrator,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              worktreeTitles: titles,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({ updateWorktreeTitle }),
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        layerServerSettings,
        NodeCrypto.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(layerThreadManagement, layerService),
    generateThreadTitle,
    updateWorktreeTitle,
  };
}

const startWorktreeThread = (id: string, text: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(id);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${id}:create`),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "t3/pairing",
      worktreePath,
      createdBy: "user",
      creationSource: "web",
    });
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${id}:message`),
      threadId,
      messageId: MessageId.make(`${id}:message`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

describe("WorktreeTitleService", () => {
  it.effect("titles a new worktree once, from what the user wrote", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* WorktreeTitleService.WorktreeTitleService;
        const threadId = yield* startWorktreeThread("thread:pairing", "Fix pairing token expiry");

        yield* service.refresh(threadId);
        const generation = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(generation?.cwd, worktreePath);
        assert.equal(generation?.message, 'Thread 1: "Seed title"\nUser: Fix pairing token expiry');
        assert.equal(generation?.linkedContext, "");
        assert.isUndefined(generation?.previousTitle);
        assert.deepEqual(harness.updateWorktreeTitle.mock.calls[0]![0].change, {
          type: "generated",
          title: "Pairing token expiry",
          sourceThreadIds: [threadId],
          replaceManual: false,
        });

        // The same threads keep their title.
        yield* service.refresh(threadId);
        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);

        const regenerated = yield* service.regenerate({ projectId, worktreePath });
        assert.equal(regenerated?.generated, "Pairing token expiry");
        const change = harness.updateWorktreeTitle.mock.calls[1]![0].change;
        assert.isTrue(change.type === "generated" && change.replaceManual);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
