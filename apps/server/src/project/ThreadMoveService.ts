import {
  CommandId,
  type GitCommandError,
  isListedThreadLineage,
  type OrchestrationV2AppThread,
  type Project,
  type ProjectId,
  type TaskFolderError,
  type ThreadMoveInput,
  type ThreadMoveResult,
} from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeBranchFragment } from "@t3tools/shared/git";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
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

export class ThreadMoveError extends Schema.TaggedError<ThreadMoveError>()("ThreadMoveError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

export interface ThreadMoveOptions {
  /** Whether a project's own worktree layout command may run for whoever asked for the move. */
  readonly projectCommands: TaskFolders.ProjectCommandsNow;
}

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    /**
     * Moves an idle thread, with its side chats, to another folder. The conversation carries over
     * and resumes there on the next message. Files stay where they are, except that a thread
     * alone in its folder takes its uncommitted changes into a new worktree.
     */
    readonly move: (
      input: ThreadMoveInput,
      options: ThreadMoveOptions,
    ) => Effect.Effect<ThreadMoveResult, ThreadMoveError>;
  }
>()("t3/project/ThreadMoveService") {}

const BRANCH_NAME_TIMEOUT = "20 seconds";

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
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
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
    thread: Pick<OrchestrationV2AppThread, "id" | "title">,
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

  const sideChatsOf = Effect.fn("ThreadMoveService.sideChatsOf")(function* (
    threadId: OrchestrationV2AppThread["id"],
  ) {
    const { contextTransfers } = yield* threads
      .getThreadRecords(threadId, ["contextTransfers"], { turnItemTypes: [] })
      .pipe(Effect.mapError(fail("Could not read the thread's side chats.")));
    const sideChats = [];
    for (const transfer of contextTransfers) {
      if (transfer.type !== "fork" || transfer.sourceThreadId !== threadId) continue;
      const records = yield* threads
        .getThreadRecords(transfer.targetThreadId, ["runs", "runtimeRequests"], {
          turnItemTypes: [],
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (records?.thread.lineage.sideChat === true && records.thread.deletedAt === null) {
        sideChats.push(records);
      }
    }
    return sideChats;
  });

  // Side chats live inside their thread and work in its folder. The thread has moved by now, so
  // one that cannot follow is logged, not a reason to undo the move.
  const bringSideChats = (
    threadId: OrchestrationV2AppThread["id"],
    worktreePath: string | null,
    branch: string | null,
    adoptInto?: Project,
  ) =>
    sideChatsOf(threadId).pipe(
      Effect.flatMap(
        Effect.forEach(({ thread: sideChat }) =>
          Effect.gen(function* () {
            if (sideChat.worktreePath !== worktreePath) {
              yield* dispatchWorkspace(sideChat, worktreePath, branch, sideChat.worktreePath);
            }
            if (adoptInto === undefined) return;
            const id = yield* randomId;
            yield* threads.dispatch({
              type: "thread.project.adopt-folder",
              commandId: CommandId.make(`thread-move-project:${id}`),
              threadId: sideChat.id,
              projectId: adoptInto.id,
            });
          }).pipe(Effect.ignoreCause({ log: true })),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    );

  const sharesFolder = Effect.fn("ThreadMoveService.sharesFolder")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    const snapshot = yield* threads
      .getShellSnapshot(
        thread.worktreePath === null
          ? { projectId: thread.projectId, location: "active" }
          : { worktreePath: thread.worktreePath, location: "active" },
      )
      .pipe(Effect.mapError(fail("Could not read which threads share the folder.")));
    return snapshot.threads.some(
      (other) =>
        other.id !== thread.id &&
        isListedThreadLineage(other.lineage) &&
        other.worktreePath === thread.worktreePath,
    );
  });

  const git = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    gitDriver.execute({ operation: `ThreadMoveService.${operation}`, cwd, args });

  // Every worktree of a repository shares one stash list, which the user and other moves also
  // use, so an entry is found by its tag and applied by its commit, never by position.
  const findShelved = (cwd: string, tag: string) =>
    git("listShelved", cwd, ["stash", "list", "--format=%H %gs"]).pipe(
      Effect.map(({ stdout }) => {
        const index = stdout.split("\n").findIndex((line) => line.endsWith(tag));
        const sha = stdout.split("\n")[index]?.split(" ")[0];
        return sha === undefined ? null : { sha, ref: `stash@{${index}}` };
      }),
    );

  /** Sets a folder's uncommitted changes aside, untracked files included. Null when it has none. */
  const shelveChanges = Effect.fn("ThreadMoveService.shelveChanges")(function* (cwd: string) {
    const tag = `t3-thread-move:${yield* randomId}`;
    yield* git("shelve", cwd, ["stash", "push", "--include-untracked", "--message", tag]);
    const shelved = yield* findShelved(cwd, tag);
    return shelved === null ? null : { tag, sha: shelved.sha };
  });

  const unshelveInto = (cwd: string, sha: string) =>
    git("unshelve", cwd, ["stash", "apply", "--index", sha]);

  const dropShelved = (cwd: string, tag: string) =>
    findShelved(cwd, tag).pipe(
      Effect.flatMap((shelved) =>
        shelved === null ? Effect.void : git("dropShelved", cwd, ["stash", "drop", shelved.ref]),
      ),
      Effect.ignoreCause({ log: true }),
    );

  // A new thread's worktree starts from the default branch when it is checked out locally.
  const defaultLocalBranch = (cwd: string) =>
    gitWorkflow.resolveDefaultBranchName(cwd, "origin").pipe(
      Effect.flatMap((name) =>
        name === null
          ? Effect.succeed(null)
          : gitWorkflow
              .listLocalBranchNames(cwd)
              .pipe(Effect.map((names) => (names.includes(name) ? name : null))),
      ),
      Effect.orElseSucceed(() => null),
    );

  const projectSettings = (projectId: ProjectId) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => resolveProjectSettings(settings, projectId).settings),
      Effect.mapError(fail("Could not read settings.")),
    );

  // The same naming a new thread's worktree gets, from the title in place of a first message.
  const newBranchName = Effect.fn("ThreadMoveService.newBranchName")(function* (
    title: string,
    project: Project,
    listBranchesIn: string | null,
  ) {
    const settings = yield* projectSettings(project.id);
    const slug = sanitizeBranchFragment(title);
    let base = slug;
    if (settings.branchNamingMode === "static") {
      base = formatGeneratedBranchName((yield* randomId).replaceAll("-", "").slice(0, 8), {
        mode: "static",
        prefix: settings.branchNamePrefix,
        instructions: "",
      });
    } else if (settings.branchNamingMode === "custom") {
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : ServerSettings.resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
              project.id,
            );
      // A name is not worth failing a move over: the title's slug stands in.
      base = yield* textGeneration
        .generateBranchName({
          naming: {
            mode: "custom",
            prefix: settings.branchNamePrefix,
            instructions: settings.branchNameInstructions,
          },
          cwd: project.workspaceRoot,
          message: title,
          modelSelection,
          projectId: project.id,
        })
        .pipe(
          Effect.timeout(BRANCH_NAME_TIMEOUT),
          Effect.map((result) => result.branch.trim() || slug),
          Effect.catchCause((cause) =>
            Effect.logWarning("thread move could not generate a branch name", cause).pipe(
              Effect.as(slug),
            ),
          ),
        );
    }
    const existing =
      listBranchesIn === null
        ? []
        : (yield* gitWorkflow
            .listLocalBranchNames(listBranchesIn)
            .pipe(Effect.mapError(fail("Could not list branches.")))).map((name) =>
            name.toLowerCase(),
          );
    // Refs are files: `feat` can't sit beside `feat/login`, and some disks ignore case.
    const taken = (name: string) =>
      existing.some(
        (other) => other === name.toLowerCase() || other.startsWith(`${name.toLowerCase()}/`),
      );
    let branch = base;
    for (let suffix = 2; taken(branch); suffix++) branch = `${base}-${suffix}`;
    return branch;
  });

  const toNewWorktree = Effect.fn("ThreadMoveService.toNewWorktree")(function* (
    thread: OrchestrationV2AppThread,
    project: Project,
    options: ThreadMoveOptions & {
      /** False after a project move: what sits in the new project's folder is not the thread's. */
      readonly bringChanges: boolean;
    },
  ) {
    if (yield* managedFolders.isScratchProject(project.id)) {
      return yield* refuse("A No project thread has no repository to make a worktree from.");
    }
    // A project that tracks repositories gets a task folder: a worktree of each on one branch.
    const taskPlan = yield* taskFolders
      .plan({ projectId: project.id })
      .pipe(Effect.mapError(fail("Could not read the project's repositories.")));
    const projectIsRepository = taskPlan === null || taskPlan.projectIsRepository;
    const root = project.workspaceRoot;
    const sourcePath = thread.worktreePath ?? root;
    const fromMain = thread.worktreePath === null;
    const source = yield* readStatus(sourcePath);
    // Each repository of a plain project folder starts from its own default branch.
    let startRef = "HEAD";
    if (projectIsRepository) {
      if (!source.isRepo) return yield* refuse(`${sourcePath} is not a git repository.`);
      if (source.refName === null) {
        return yield* refuse("The thread's folder has no branch checked out. Check one out first.");
      }
      startRef = source.refName;
      // Moved in from another project, the thread has no work on whatever Main has checked out.
      if (!options.bringChanges) startRef = (yield* defaultLocalBranch(root)) ?? startRef;
    }
    const settings = yield* projectSettings(project.id);
    const bringChanges =
      options.bringChanges &&
      projectIsRepository &&
      source.hasWorkingTreeChanges &&
      !(yield* sharesFolder(thread));
    // Uncommitted changes only apply to the commit they were made on, and a split keeps the
    // shared worktree's unpushed commits, so only a clean move out of Main follows the setting.
    const startFromOrigin = fromMain && !bringChanges && settings.newWorktreesStartFromOrigin;
    // Branched from Main, a worktree records Main's branch as its base, as a new thread's does.
    let start = { refName: startRef, baseRefName: fromMain ? startRef : undefined };
    if (startFromOrigin && projectIsRepository) {
      // Offline, the local branch is still a place to start.
      const remoteBase = yield* gitWorkflow
        .fetchWorktreeBaseCommit({ cwd: root, refName: startRef })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread move could not fetch its base", cause).pipe(Effect.as(null)),
          ),
        );
      if (remoteBase !== null) {
        start = {
          refName: remoteBase.commitSha,
          baseRefName: `refs/remotes/${remoteBase.remoteRefName}`,
        };
      }
    }
    const branch = yield* newBranchName(thread.title, project, projectIsRepository ? root : null);

    // Once git has made the worktree, binding or removing it must finish even if the caller leaves.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const create: Effect.Effect<
          { readonly path: string; readonly refName: string; readonly taskFolder: string | null },
          GitCommandError | TaskFolderError
        > =
          taskPlan === null
            ? gitWorkflow
                .createWorktree({
                  cwd: root,
                  refName: start.refName,
                  newRefName: branch,
                  path: null,
                  ...(start.baseRefName === undefined ? {} : { baseRefName: start.baseRefName }),
                })
                .pipe(Effect.map(({ worktree }) => ({ ...worktree, taskFolder: null })))
            : taskFolders
                .create({
                  plan: taskPlan,
                  branch,
                  projectStart: {
                    refName: start.refName,
                    baseRefName: start.baseRefName ?? start.refName,
                  },
                  // A split starts each repository from the shared folder's branch.
                  baseBranch: fromMain ? undefined : (thread.branch ?? undefined),
                  startFromOrigin,
                  projectCommands: options.projectCommands,
                })
                .pipe(
                  Effect.map((made) => ({
                    path: made.taskFolder.projectPath,
                    refName: made.branch,
                    taskFolder: made.taskFolder.root,
                  })),
                );
        const created = yield* restore(create).pipe(
          Effect.mapError(fail("Could not create the worktree.")),
        );
        const { path: worktreePath, refName } = created;
        const discardWorktree: Effect.Effect<unknown, GitCommandError | TaskFolderError> =
          created.taskFolder === null
            ? gitWorkflow
                .removeWorktree({ cwd: root, path: worktreePath, force: true })
                .pipe(
                  Effect.andThen(
                    gitWorkflow.deleteLocalBranch({ cwd: root, refName, force: true }),
                  ),
                )
            : taskFolders.remove({
                root: created.taskFolder,
                force: true,
                forget: true,
                projectCommands: options.projectCommands,
                deleteBranch: refName,
              });

        const changesMoved = yield* Effect.gen(function* () {
          const shelved = bringChanges
            ? yield* shelveChanges(sourcePath).pipe(
                Effect.mapError(fail("Could not set the uncommitted changes aside.")),
              )
            : null;
          yield* Effect.gen(function* () {
            if (shelved !== null) {
              yield* unshelveInto(worktreePath, shelved.sha).pipe(
                Effect.mapError(fail("Could not bring the uncommitted changes along.")),
              );
            }
            yield* repoint(thread, worktreePath, refName);
          }).pipe(
            // The new worktree is about to be removed, so the changes go back first.
            Effect.onError((cause) =>
              shelved === null || Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : unshelveInto(sourcePath, shelved.sha).pipe(
                    Effect.andThen(dropShelved(sourcePath, shelved.tag)),
                    Effect.ignoreCause({ log: true }),
                  ),
            ),
          );
          if (shelved !== null) yield* dropShelved(sourcePath, shelved.tag);
          return shelved !== null;
        }).pipe(
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : discardWorktree.pipe(Effect.ignoreCause({ log: true })),
          ),
        );
        yield* bringSideChats(thread.id, worktreePath, refName);
        yield* Effect.forEach(changesMoved ? [worktreePath, sourcePath] : [worktreePath], (cwd) =>
          vcsStatusBroadcaster
            .refreshStatus(cwd)
            .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach),
        );
        yield* setupScriptRunner
          .runForThread({
            threadId: thread.id,
            projectId: project.id,
            projectCwd: root,
            worktreePath,
            project: { id: project.id, workspaceRoot: root, scripts: project.scripts },
          })
          .pipe(Effect.ignoreCause({ log: true }));
        return { projectId: project.id, worktreePath, branch: refName, changesMoved };
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
    yield* bringSideChats(thread.id, worktreePath, branch);
    return { projectId: project.id, worktreePath, branch };
  });

  const newThreadEnvMode = Effect.fn("ThreadMoveService.newThreadEnvMode")(function* (
    project: Project,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(fail("Could not read settings.")),
    );
    const projectFile = yield* projectFiles.load(project.workspaceRoot);
    const projectThreads = yield* threads
      .listProjectThreads({ projectId: project.id, includeSubagents: false })
      .pipe(Effect.mapError(fail("Could not read the project's threads.")));
    return resolveNewThreadEnvMode({
      projectSettings: resolveProjectSettings(
        settings,
        project.id,
        project,
        Option.getOrNull(projectFile),
      ),
      workspaceRoot: project.workspaceRoot,
      newProjectsRoot: managedFolders.namedProjectsRoot,
      projectHasThreads: projectThreads.length > 0,
    });
  });

  const toProject = Effect.fn("ThreadMoveService.toProject")(function* (
    thread: OrchestrationV2AppThread,
    projectId: ProjectId,
    options: ThreadMoveOptions,
  ) {
    if (projectId === thread.projectId) {
      return yield* refuse("The thread is already in that project.");
    }
    const target = yield* loadProject(projectId);
    if (yield* managedFolders.isScratchProject(target.id)) {
      return yield* refuse("A thread can't move into No project.");
    }
    const status = yield* readStatus(target.workspaceRoot);
    const taskPlan = yield* taskFolders
      .plan({ projectId: target.id })
      .pipe(Effect.mapError(fail("Could not read the project's repositories.")));
    // It lands where a new thread in that project would start. A plain folder that tracks no
    // repository, or a detached checkout, has no worktree to make, so those keep it in Main.
    const getsWorktree =
      (yield* newThreadEnvMode(target)) === "worktree" &&
      (taskPlan === null || taskPlan.projectIsRepository
        ? status.isRepo && status.refName !== null
        : true);
    const repointed = thread.worktreePath !== target.workspaceRoot;
    // adopt-folder files a thread under the project rooted where it works, so it moves there first.
    // If filing it fails, it goes back, so it never works in one project's folder under another.
    const filed = yield* Effect.uninterruptible(
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
    yield* bringSideChats(thread.id, target.workspaceRoot, status.refName, target);
    if (!getsWorktree) return filed;
    return yield* loadIdleThread(thread.id).pipe(
      Effect.flatMap((moved) => toNewWorktree(moved, target, { ...options, bringChanges: false })),
      Effect.mapError(
        (error) =>
          new ThreadMoveError({
            reason: `"${thread.title}" moved to ${target.title}'s Main, but its new worktree failed. ${error.reason}`,
            cause: error,
          }),
      ),
    );
  });

  const move: ThreadMoveService["Service"]["move"] = Effect.fn("ThreadMoveService.move")(
    function* (input, options) {
      const thread = yield* loadIdleThread(input.threadId);
      // A move detaches a side chat's session too, which would cut off a turn it is in.
      if ((yield* sideChatsOf(thread.id)).some(threadHasUnfinishedWork)) {
        return yield* refuse(
          `A side chat of "${thread.title}" is still working. Finish or stop it first.`,
        );
      }
      switch (input.to._tag) {
        case "newWorktree":
          return yield* toNewWorktree(thread, yield* loadProject(thread.projectId), {
            ...options,
            bringChanges: true,
          });
        case "worktree":
          return yield* toWorktree(
            thread,
            yield* loadProject(thread.projectId),
            input.to.worktreePath,
          );
        case "project":
          return yield* toProject(thread, input.to.projectId, options);
      }
    },
  );

  return ThreadMoveService.of({ move });
});

export const layer = Layer.effect(ThreadMoveService, make);
