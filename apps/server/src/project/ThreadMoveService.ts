import {
  CommandId,
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type Project,
  type ProjectId,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeBranchFragment } from "@t3tools/shared/git";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { threadHasUnfinishedWork } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    /**
     * Moves an idle thread to another folder. The conversation carries over and resumes there on
     * the next message; files, uncommitted changes included, stay where they are.
     */
    readonly move: (input: ThreadMoveInput) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
  }
>()("t3/project/ThreadMoveService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const random = yield* SecureRandom.SecureRandom;

  const fail = (reason: string) => (cause: unknown) => new ThreadMoveError({ reason, cause });
  const refuse = (reason: string) => Effect.fail(new ThreadMoveError({ reason }));
  const randomId = random.uuidV4().pipe(Effect.orDie);

  const loadProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError(fail("Could not read the project.")),
      Effect.flatMap(
        Option.match({
          onNone: () => refuse("That project no longer exists."),
          onSome: (project) =>
            project.deletedAt === null
              ? Effect.succeed(project)
              : refuse("That project no longer exists."),
        }),
      ),
    );

  const readStatus = (cwd: string) =>
    gitWorkflow
      .localStatus({ cwd })
      .pipe(Effect.mapError(fail(`Could not read the git status of ${cwd}.`)));

  const loadIdleThread = Effect.fn("ThreadMoveService.loadIdleThread")(function* (
    threadId: OrchestrationV2AppThread["id"],
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["runs", "runtimeRequests"], { turnItemTypes: [] })
      .pipe(Effect.mapError(fail("Could not read the thread.")));
    const thread = records.thread;
    if (thread.deletedAt !== null) return yield* refuse("Thread not found.");
    if (!isListedThreadLineage(thread.lineage)) {
      return yield* refuse("Only a top-level thread can move.");
    }
    if (thread.archivedAt !== null) {
      return yield* refuse("Unarchive the thread before moving it.");
    }
    if (threadHasUnfinishedWork(records)) {
      return yield* refuse(`"${thread.title}" is still working. Finish or stop it first.`);
    }
    return thread;
  });

  const dispatchWorkspace = (
    thread: OrchestrationV2AppThread,
    worktreePath: string | null,
    branch: string | null,
    expectedWorktreePath: string | null,
  ) =>
    Effect.flatMap(randomId, (id) =>
      threads.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`thread-move:${id}`),
        threadId: thread.id,
        worktreePath,
        branch,
        expectedWorktreePath,
      }),
    ).pipe(Effect.mapError(fail(`Could not move "${thread.title}". Try again.`)));

  // A workspace change detaches the provider session, and the next turn resumes it in the new folder.
  // A turn started while git worked would be cut off, so idleness is checked again right before.
  const repoint = (
    thread: OrchestrationV2AppThread,
    worktreePath: string | null,
    branch: string | null,
  ) =>
    loadIdleThread(thread.id).pipe(
      Effect.andThen(dispatchWorkspace(thread, worktreePath, branch, thread.worktreePath)),
    );

  const newBranchName = Effect.fn("ThreadMoveService.newBranchName")(function* (
    title: string,
    projectId: ProjectId,
    repositoryRoot: string,
  ) {
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings.pipe(Effect.mapError(fail("Could not read settings."))),
      projectId,
    ).settings;
    const base =
      settings.branchNamingMode === "static"
        ? formatGeneratedBranchName((yield* randomId).replaceAll("-", "").slice(0, 8), {
            mode: "static",
            prefix: settings.branchNamePrefix,
            instructions: "",
          })
        : sanitizeBranchFragment(title);
    const existing = (yield* gitWorkflow
      .listLocalBranchNames(repositoryRoot)
      .pipe(Effect.mapError(fail("Could not list branches.")))).map((name) => name.toLowerCase());
    // Refs are files: `feat` can't sit beside `feat/login`, and some disks ignore case.
    const taken = (name: string) =>
      existing.some((other) => other === name || other.startsWith(`${name}/`));
    let branch = base;
    for (let suffix = 2; taken(branch); suffix++) branch = `${base}-${suffix}`;
    return branch;
  });

  const toNewWorktree = Effect.fn("ThreadMoveService.toNewWorktree")(function* (
    thread: OrchestrationV2AppThread,
    project: Project,
  ) {
    if (yield* managedFolders.isScratchProject(project.id)) {
      return yield* refuse("A No project thread has no repository to make a worktree from.");
    }
    const taskPlan = yield* taskFolders
      .plan({ projectId: project.id })
      .pipe(Effect.mapError(fail("Could not read the project's repositories.")));
    if (taskPlan !== null) {
      return yield* refuse(
        "A project with several repositories can't move a thread into a new worktree yet.",
      );
    }
    const root = project.workspaceRoot;
    const source = yield* readStatus(thread.worktreePath ?? root);
    if (!source.isRepo) {
      return yield* refuse(`${thread.worktreePath ?? root} is not a git repository.`);
    }
    const startRef = source.refName;
    if (startRef === null) {
      return yield* refuse("The thread's folder has no branch checked out. Check one out first.");
    }
    const branch = yield* newBranchName(thread.title, project.id, root);

    // Once git has made the worktree, binding or removing it must finish even if the caller leaves.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const created = yield* restore(
          gitWorkflow.createWorktree({
            cwd: root,
            refName: startRef,
            newRefName: branch,
            path: null,
            // Branched from the checkout, it records the checkout's branch as its base, as a new
            // thread's worktree does. A split from another worktree leaves its base unset.
            ...(thread.worktreePath === null ? { baseRefName: startRef } : {}),
          }),
        ).pipe(Effect.mapError(fail("Could not create the worktree.")));
        const { path: worktreePath, refName } = created.worktree;
        yield* repoint(thread, worktreePath, refName).pipe(
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : gitWorkflow
                  .removeWorktree({ cwd: root, path: worktreePath, force: true })
                  .pipe(
                    Effect.andThen(
                      gitWorkflow.deleteLocalBranch({ cwd: root, refName, force: true }),
                    ),
                    Effect.ignoreCause({ log: true }),
                  ),
          ),
        );
        yield* vcsStatusBroadcaster
          .refreshStatus(worktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
        yield* setupScriptRunner
          .runForThread({
            threadId: thread.id,
            projectId: project.id,
            projectCwd: root,
            worktreePath,
            project: { id: project.id, workspaceRoot: root, scripts: project.scripts },
          })
          .pipe(Effect.ignoreCause({ log: true }));
        return { projectId: project.id, worktreePath, branch: refName };
      }),
    );
  });

  const toWorktree = Effect.fn("ThreadMoveService.toWorktree")(function* (
    thread: OrchestrationV2AppThread,
    project: Project,
    worktreePath: string | null,
  ) {
    if (worktreePath === thread.worktreePath) {
      return yield* refuse("The thread already works there.");
    }
    if (yield* managedFolders.isScratchProject(project.id)) {
      return yield* refuse("A No project thread has no worktrees to move to.");
    }
    const status = yield* readStatus(worktreePath ?? project.workspaceRoot);
    let branch = status.refName;
    if (worktreePath !== null && !status.isRepo) {
      // A multi-repository project's folder holds the repositories, all on the thread's branch.
      const taskFolder = yield* taskFolders
        .find(worktreePath)
        .pipe(Effect.mapError(fail("Could not read the project's repositories.")));
      const [repository] = taskFolder?.repositories ?? [];
      if (
        taskFolder?.projectId !== project.id ||
        taskFolder.projectPath !== worktreePath ||
        !repository
      ) {
        return yield* refuse(`${worktreePath} is not a git worktree.`);
      }
      branch = (yield* readStatus(repository.worktreePath)).refName;
    }
    yield* repoint(thread, worktreePath, branch);
    return { projectId: project.id, worktreePath, branch };
  });

  const toProject = Effect.fn("ThreadMoveService.toProject")(function* (
    thread: OrchestrationV2AppThread,
    projectId: ProjectId,
  ) {
    if (projectId === thread.projectId) {
      return yield* refuse("The thread is already in that project.");
    }
    const target = yield* loadProject(projectId);
    if (yield* managedFolders.isScratchProject(target.id)) {
      return yield* refuse("A thread can't move into No project.");
    }
    const status = yield* readStatus(target.workspaceRoot);
    const repointed = thread.worktreePath !== target.workspaceRoot;
    // adopt-folder files a thread under the project rooted where it works, so it moves there first.
    // If filing it fails, it goes back, so it never works in one project's folder under another.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        if (repointed) yield* repoint(thread, target.workspaceRoot, status.refName);
        yield* scheduledTasks
          .moveThreadTasks({ threadIds: [thread.id], projectId: target.id })
          .pipe(
            Effect.mapError(fail("Could not move the thread's scheduled tasks.")),
            Effect.andThen(
              Effect.flatMap(randomId, (id) =>
                threads.dispatch({
                  type: "thread.project.adopt-folder",
                  commandId: CommandId.make(`thread-move-project:${id}`),
                  threadId: thread.id,
                  projectId: target.id,
                }),
              ).pipe(Effect.mapError(fail(`Could not move "${thread.title}". Try again.`))),
            ),
            Effect.onError(() =>
              Effect.andThen(
                scheduledTasks
                  .moveThreadTasks({ threadIds: [thread.id], projectId: thread.projectId })
                  .pipe(Effect.ignoreCause({ log: true })),
                repointed
                  ? dispatchWorkspace(
                      thread,
                      thread.worktreePath,
                      thread.branch,
                      target.workspaceRoot,
                    ).pipe(Effect.ignoreCause({ log: true }))
                  : Effect.void,
              ),
            ),
          );
        return { projectId: target.id, worktreePath: null, branch: status.refName };
      }),
    );
  });

  const move: ThreadMoveService["Service"]["move"] = Effect.fn("ThreadMoveService.move")(
    function* (input) {
      const thread = yield* loadIdleThread(input.threadId);
      switch (input.to._tag) {
        case "newWorktree":
          return yield* toNewWorktree(thread, yield* loadProject(thread.projectId));
        case "worktree":
          return yield* toWorktree(
            thread,
            yield* loadProject(thread.projectId),
            input.to.worktreePath,
          );
        case "project":
          return yield* toProject(thread, input.to.projectId);
      }
    },
  );

  return ThreadMoveService.of({ move });
});

export const layer = Layer.effect(ThreadMoveService, make);
