import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type OrchestrationV2ThreadProjection,
  type Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";

const threadId = ThreadId.make("thread-move-test");
const projectId = ProjectId.make("project-move-test");
const otherProjectId = ProjectId.make("project-move-other");
const sharedWorktree = "/worktrees/app/shared";

const makeProject = (id: ProjectId, workspaceRoot: string): Project =>
  ({
    id,
    title: id,
    workspaceRoot,
    scripts: [],
    deletedAt: null,
  }) as unknown as Project;

const projects = new Map([
  [projectId, makeProject(projectId, "/repo/app")],
  [otherProjectId, makeProject(otherProjectId, "/repo/other")],
]);

const makeHarness = (options: { readonly running?: boolean; readonly bindFails?: boolean }) => {
  const dispatched: Array<Record<string, unknown>> = [];
  const dispatch = vi.fn((command: Record<string, unknown>) => {
    dispatched.push(command);
    return options.bindFails && command.type === "thread.metadata.update"
      ? (Effect.fail("worktree changed") as never)
      : Effect.succeed({ sequence: 1, storedEvents: [] });
  });
  const createWorktree = vi.fn((input: { readonly newRefName?: string | undefined }) =>
    Effect.succeed({
      worktree: { path: `/worktrees/app/${input.newRefName}`, refName: input.newRefName ?? "" },
    }),
  );
  const removeWorktree = vi.fn((_: unknown) => Effect.void);
  const deleteLocalBranch = vi.fn((_: unknown) => Effect.void);
  const moveThreadTasks = vi.fn((_: unknown) => Effect.void);
  const branchAt: Record<string, string> = {
    "/repo/app": "main",
    [sharedWorktree]: "feat/shared",
    "/repo/other": "develop",
  };

  const layer = ThreadMoveService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: dispatch as never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: threadId,
                projectId,
                title: "Fix the image viewer",
                worktreePath: sharedWorktree,
                archivedAt: null,
                deletedAt: null,
                lineage: { relationshipToParent: null },
              },
              runs: options.running ? [{ status: "running" }] : [],
              runtimeRequests: [],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.fromNullishOr(projects.get(id))),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          isScratchProject: () => Effect.succeed(false),
          namedProjectsRoot: "/projects",
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: (input) =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: false,
              refName: branchAt[input.cwd] ?? null,
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          listLocalBranchNames: () => Effect.succeed(["main", "fix-the-image-viewer"]),
          createWorktree: createWorktree as never,
          removeWorktree: removeWorktree as never,
          deleteLocalBranch: deleteLocalBranch as never,
        }),
        Layer.mock(TaskFolders.TaskFolders)({ plan: () => Effect.succeed(null) }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" } as const),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus: () => Effect.die("unused"),
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          moveThreadTasks: moveThreadTasks as never,
        }),
        ServerSettings.layerTest({ branchNamingMode: "semantic" }),
        NodeCrypto.layer,
      ),
    ),
  );
  const move = (to: Parameters<ThreadMoveService.ThreadMoveService["Service"]["move"]>[0]["to"]) =>
    Effect.flatMap(ThreadMoveService.ThreadMoveService, (service) =>
      service.move({ threadId, to }),
    ).pipe(Effect.provide(layer));
  return { move, dispatched, createWorktree, removeWorktree, deleteLocalBranch, moveThreadTasks };
};

describe("ThreadMoveService", () => {
  it.effect("splits a shared worktree into a new one on a branch named after the thread", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const result = yield* harness.move({ _tag: "newWorktree" });

      expect(harness.createWorktree).toHaveBeenCalledWith({
        cwd: "/repo/app",
        refName: "feat/shared",
        newRefName: "fix-the-image-viewer-2",
        path: null,
      });
      expect(harness.dispatched).toEqual([
        expect.objectContaining({
          type: "thread.metadata.update",
          worktreePath: "/worktrees/app/fix-the-image-viewer-2",
          branch: "fix-the-image-viewer-2",
          expectedWorktreePath: sharedWorktree,
        }),
      ]);
      expect(result).toEqual({
        projectId,
        worktreePath: "/worktrees/app/fix-the-image-viewer-2",
        branch: "fix-the-image-viewer-2",
      });
    }),
  );

  it.effect("removes the new worktree and branch when the thread cannot be re-pointed", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ bindFails: true });
      const exit = yield* Effect.exit(harness.move({ _tag: "newWorktree" }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: "/repo/app",
        path: "/worktrees/app/fix-the-image-viewer-2",
        force: true,
      });
      expect(harness.deleteLocalBranch).toHaveBeenCalledWith({
        cwd: "/repo/app",
        refName: "fix-the-image-viewer-2",
        force: true,
      });
    }),
  );

  it.effect("moves back to the project's own checkout on its current branch", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const result = yield* harness.move({ _tag: "worktree", worktreePath: null });

      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.dispatched).toEqual([
        expect.objectContaining({
          type: "thread.metadata.update",
          worktreePath: null,
          branch: "main",
          expectedWorktreePath: sharedWorktree,
        }),
      ]);
      expect(result).toEqual({ projectId, worktreePath: null, branch: "main" });
    }),
  );

  it.effect("moves into another project's checkout, taking its scheduled tasks along", () =>
    Effect.gen(function* () {
      const harness = makeHarness({});
      const result = yield* harness.move({ _tag: "project", projectId: otherProjectId });

      expect(harness.dispatched).toEqual([
        expect.objectContaining({
          type: "thread.metadata.update",
          worktreePath: "/repo/other",
          branch: "develop",
        }),
        expect.objectContaining({
          type: "thread.project.adopt-folder",
          threadId,
          projectId: otherProjectId,
        }),
      ]);
      expect(harness.moveThreadTasks).toHaveBeenCalledWith({
        threadIds: [threadId],
        projectId: otherProjectId,
      });
      expect(result).toEqual({ projectId: otherProjectId, worktreePath: null, branch: "develop" });
    }),
  );

  it.effect("refuses a thread that is still working, before touching git", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ running: true });
      const exit = yield* Effect.exit(harness.move({ _tag: "newWorktree" }));

      expect(Exit.isFailure(exit)).toBe(true);
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.dispatched).toEqual([]);
    }),
  );
});
