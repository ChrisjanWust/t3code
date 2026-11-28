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
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";

const threadId = ThreadId.make("thread-move-test");
const sideChatId = ThreadId.make("thread-move-side-chat");
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

const makeHarness = (options: {
  readonly running?: boolean;
  readonly bindFails?: boolean;
  readonly newThreadsIn?: "local" | "worktree";
  /** Where the thread works: a worktree another thread also uses, or alone in Main. */
  readonly startsIn?: "shared-worktree" | "main-alone";
  readonly uncommittedChanges?: boolean;
  readonly startFromOrigin?: boolean;
  readonly customBranchNaming?: boolean;
  readonly trackedRepositories?: boolean;
  readonly sideChat?: boolean;
}) => {
  const dispatched: Array<Record<string, unknown>> = [];
  const alone = options.startsIn === "main-alone";
  let thread = {
    id: threadId,
    projectId,
    title: "Fix the image viewer",
    worktreePath: alone ? null : sharedWorktree,
    branch: alone ? "main" : "feat/shared",
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: null } as Record<string, unknown>,
  };
  const sideChat = { ...thread, id: sideChatId, lineage: { sideChat: true } };
  const dispatch = vi.fn((command: Record<string, unknown>) => {
    dispatched.push(command);
    if (options.bindFails && command.type === "thread.metadata.update") {
      return Effect.fail("worktree changed") as never;
    }
    if (command.threadId !== threadId) return Effect.succeed({ sequence: 1, storedEvents: [] });
    if (command.type === "thread.metadata.update") {
      thread = { ...thread, worktreePath: command.worktreePath as string | null };
    }
    if (command.type === "thread.project.adopt-folder") {
      thread = { ...thread, projectId: command.projectId as ProjectId, worktreePath: null };
    }
    return Effect.succeed({ sequence: 1, storedEvents: [] });
  });
  const gitCalls: Array<{ readonly cwd: string; readonly args: ReadonlyArray<string> }> = [];
  const git = vi.fn((input: { readonly cwd: string; readonly args: ReadonlyArray<string> }) => {
    gitCalls.push({ cwd: input.cwd, args: input.args });
    const shelved = gitCalls.find((call) => call.args[1] === "push")?.args.at(-1);
    return Effect.succeed({
      exitCode: 0,
      stdout: input.args[1] === "list" ? `5e1f On main: ${shelved}\n` : "",
      stderr: "",
    });
  });
  const fetchWorktreeBaseCommit = vi.fn((_: unknown) =>
    Effect.succeed({ commitSha: "0r1g1n", remoteRefName: "origin/develop" }),
  );
  const createTaskFolder = vi.fn((input: { readonly branch: string }) =>
    Effect.succeed({
      taskFolder: { root: "/tasks/app/1", projectPath: "/tasks/app/1/app" },
      branch: input.branch,
      laidOutByProject: false,
      repositoriesStartedFromOrigin: false,
    }),
  );
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
          listProjectThreads: () => Effect.succeed([]),
          getShellSnapshot: () =>
            Effect.succeed({
              threads: alone ? [thread] : [thread, { ...thread, id: "thread-move-neighbour" }],
            } as never),
          getThreadRecords: (id: ThreadId) =>
            Effect.succeed({
              thread: id === sideChatId ? sideChat : thread,
              runs: options.running ? [{ status: "running" }] : [],
              runtimeRequests: [],
              contextTransfers:
                options.sideChat && id === threadId
                  ? [{ type: "fork", sourceThreadId: threadId, targetThreadId: sideChatId }]
                  : [],
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
              hasWorkingTreeChanges: options.uncommittedChanges === true,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          listLocalBranchNames: () => Effect.succeed(["main", "fix-the-image-viewer"]),
          createWorktree: createWorktree as never,
          removeWorktree: removeWorktree as never,
          deleteLocalBranch: deleteLocalBranch as never,
          fetchWorktreeBaseCommit: fetchWorktreeBaseCommit as never,
        }),
        Layer.mock(TaskFolders.TaskFolders)({
          plan: () =>
            Effect.succeed(
              options.trackedRepositories ? ({ projectIsRepository: false } as never) : null,
            ),
          create: createTaskFolder as never,
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({ execute: git as never }),
        Layer.mock(TextGeneration.TextGeneration)({
          generateBranchName: () => Effect.succeed({ branch: "team/CJ-12-image-viewer" }),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(T3ProjectFileLoader.T3ProjectFileLoader)({ load: () => Effect.succeedNone }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" } as const),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus: () => Effect.void as never,
        }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          moveThreadTasks: moveThreadTasks as never,
        }),
        ServerSettings.layerTest({
          branchNamingMode: options.customBranchNaming ? "custom" : "semantic",
          defaultThreadEnvMode: options.newThreadsIn ?? "local",
          newWorktreesStartFromOrigin: options.startFromOrigin === true,
        }),
        NodeCrypto.layer,
      ),
    ),
  );
  const move = (to: Parameters<ThreadMoveService.ThreadMoveService["Service"]["move"]>[0]["to"]) =>
    Effect.flatMap(ThreadMoveService.ThreadMoveService, (service) =>
      service.move({ threadId, to }, { projectCommands: "permitted" }),
    ).pipe(Effect.provide(layer));
  return {
    move,
    dispatched,
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    moveThreadTasks,
    gitCalls,
    fetchWorktreeBaseCommit,
    createTaskFolder,
  };
};

describe("ThreadMoveService", () => {
  it.effect("splits a shared worktree from its own commit, leaving its changes behind", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ uncommittedChanges: true, startFromOrigin: true });
      const result = yield* harness.move({ _tag: "newWorktree" });

      expect(harness.fetchWorktreeBaseCommit).not.toHaveBeenCalled();
      expect(harness.gitCalls).toEqual([]);
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
        changesMoved: false,
      });
    }),
  );

  it.effect("a thread alone in its folder brings its uncommitted changes", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        startsIn: "main-alone",
        uncommittedChanges: true,
        startFromOrigin: true,
      });
      const result = yield* harness.move({ _tag: "newWorktree" });

      // The changes only apply to the commit they were made on, so the remote is not the start.
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ refName: "main" }),
      );
      const worktree = "/worktrees/app/fix-the-image-viewer-2";
      expect(harness.gitCalls.map((call) => [call.cwd, ...call.args.slice(0, 3)])).toEqual([
        ["/repo/app", "stash", "push", "--include-untracked"],
        ["/repo/app", "stash", "list", "--format=%H %gs"],
        [worktree, "stash", "apply", "--index"],
        ["/repo/app", "stash", "list", "--format=%H %gs"],
        ["/repo/app", "stash", "drop", "stash@{0}"],
      ]);
      expect(harness.gitCalls[2]?.args.at(-1)).toBe("5e1f");
      expect(result.changesMoved).toBe(true);
    }),
  );

  it.effect("names the branch by the project's own naming instructions", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ customBranchNaming: true });
      const result = yield* harness.move({ _tag: "newWorktree" });

      expect(result.branch).toBe("team/CJ-12-image-viewer");
    }),
  );

  it.effect("gives a project that tracks repositories a worktree of each", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ startsIn: "main-alone", trackedRepositories: true });
      const result = yield* harness.move({ _tag: "newWorktree" });

      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.createTaskFolder).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "fix-the-image-viewer", projectCommands: "permitted" }),
      );
      expect(result.worktreePath).toBe("/tasks/app/1/app");
    }),
  );

  it.effect("takes the thread's side chats to the new folder", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ sideChat: true });
      yield* harness.move({ _tag: "worktree", worktreePath: null });

      expect(harness.dispatched).toEqual([
        expect.objectContaining({ threadId, worktreePath: null }),
        expect.objectContaining({
          threadId: sideChatId,
          worktreePath: null,
          expectedWorktreePath: sharedWorktree,
        }),
      ]);
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

  it.effect("moves into a new worktree of a project whose new threads start in one", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ newThreadsIn: "worktree", startFromOrigin: true });
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
        expect.objectContaining({
          type: "thread.metadata.update",
          worktreePath: "/worktrees/app/fix-the-image-viewer-2",
          expectedWorktreePath: null,
        }),
      ]);
      // Out of Main, it starts where a new thread's worktree would: the freshly fetched remote.
      expect(harness.createWorktree).toHaveBeenCalledWith({
        cwd: "/repo/other",
        refName: "0r1g1n",
        newRefName: "fix-the-image-viewer-2",
        path: null,
        baseRefName: "refs/remotes/origin/develop",
      });
      expect(result).toEqual({
        projectId: otherProjectId,
        worktreePath: "/worktrees/app/fix-the-image-viewer-2",
        branch: "fix-the-image-viewer-2",
        changesMoved: false,
      });
    }),
  );

  it.effect(
    "moves into the checkout of a project whose new threads start there, with its tasks",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ newThreadsIn: "local" });
        const result = yield* harness.move({ _tag: "project", projectId: otherProjectId });

        expect(harness.createWorktree).not.toHaveBeenCalled();
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
        expect(result).toEqual({
          projectId: otherProjectId,
          worktreePath: null,
          branch: "develop",
        });
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
