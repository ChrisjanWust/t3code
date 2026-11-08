import { assert, describe, it } from "@effect/vitest";
import { type ProjectWorktreeTitle, RunId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";

import {
  isWorktreeTitleRefreshDue,
  selectWorktreeTitleWindow,
  worktreeTitleExcerpts,
} from "./WorktreeTitlePolicy.ts";

const minute = 60_000;
const now = Date.parse("2026-01-01T12:00:00.000Z");
const a = ThreadId.make("thread-a");
const b = ThreadId.make("thread-b");
const c = ThreadId.make("thread-c");
const d = ThreadId.make("thread-d");

const thread = (id: ThreadId, minutesAgo: number | null) => ({
  id,
  lastUserMessageAt: minutesAgo === null ? null : now - minutesAgo * minute,
});

const minutesAgoIso = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - minutes * minute));

const entry = (
  overrides: Partial<ProjectWorktreeTitle> = {},
): Pick<ProjectWorktreeTitle, "manual" | "sourceThreadIds" | "updatedAt"> => ({
  manual: null,
  sourceThreadIds: [a],
  updatedAt: minutesAgoIso(60),
  ...overrides,
});

describe("selectWorktreeTitleWindow", () => {
  it("keeps the three most recently used threads the user wrote in, newest first", () => {
    const window = selectWorktreeTitleWindow([
      thread(a, 50),
      thread(b, 5),
      thread(c, null),
      thread(d, 30),
      thread(ThreadId.make("thread-e"), 10),
    ]);
    assert.deepEqual(
      window.map((candidate) => candidate.id),
      [b, ThreadId.make("thread-e"), d],
    );
  });
});

describe("isWorktreeTitleRefreshDue", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly entry: ReturnType<typeof entry> | undefined;
    readonly window: ReadonlyArray<ReturnType<typeof thread>>;
    readonly due: boolean;
  }> = [
    {
      name: "a new worktree gets its first title",
      entry: undefined,
      window: [thread(a, 0)],
      due: true,
    },
    { name: "nothing to title yet", entry: undefined, window: [], due: false },
    {
      name: "a manual title is never refreshed",
      entry: entry({ manual: "Mine" }),
      window: [thread(b, 0), thread(a, 60)],
      due: false,
    },
    {
      name: "the same threads keep their title",
      entry: entry({ sourceThreadIds: [a, b] }),
      window: [thread(b, 0), thread(a, 90)],
      due: false,
    },
    {
      name: "a thread started beside an active one waits for it to go quiet",
      entry: entry(),
      window: [thread(b, 0), thread(a, 5)],
      due: false,
    },
    {
      name: "once the earlier thread is quiet, the new one updates the title",
      entry: entry(),
      window: [thread(b, 0), thread(a, 20)],
      due: true,
    },
    {
      name: "the cooldown holds even when the earlier threads are quiet",
      entry: entry({ updatedAt: minutesAgoIso(10) }),
      window: [thread(b, 0), thread(a, 25)],
      due: false,
    },
    {
      name: "a source thread that left the window does not hold it up",
      entry: entry({ sourceThreadIds: [d] }),
      window: [thread(c, 0), thread(b, 1), thread(a, 2)],
      due: true,
    },
  ];
  it.each(cases)("$name", (testCase) => {
    assert.equal(
      isWorktreeTitleRefreshDue({ entry: testCase.entry, window: testCase.window, now }),
      testCase.due,
    );
  });
});

describe("worktreeTitleExcerpts", () => {
  it("keeps the user's first and latest requests and the last reply of finished runs", () => {
    const message = (
      text: string,
      overrides: Partial<{
        role: "user" | "assistant" | "system";
        createdBy: "user" | "agent" | "system";
        scheduledTaskId: ScheduledTaskId;
        streaming: boolean;
        runId: RunId;
      }> = {},
    ) =>
      ({
        text,
        role: "user",
        createdBy: "user",
        streaming: false,
        runId: null,
        ...overrides,
      }) as const;
    const reply = (text: string, run: string) =>
      message(text, { role: "assistant", createdBy: "agent", runId: RunId.make(run) });
    const run = (id: string, status: "completed" | "running") => ({
      id: RunId.make(id),
      status,
    });
    assert.deepEqual(
      worktreeTitleExcerpts(
        [
          message("https://example.slack.com/archives/C1/p1"),
          reply("Reading the thread", "run-1"),
          reply("It is about [vendor fallbacks](https://example.com/doc)", "run-1"),
          message("A delegated task's brief", { createdBy: "agent" }),
          message("A scheduled wake", { createdBy: "system" }),
          message("A scheduled task's prompt", {
            scheduledTaskId: ScheduledTaskId.make("scheduled-task"),
          }),
          message(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT),
          message("Do the items assigned to me"),
          reply("Started both items", "run-2"),
          message("Write the PRs"),
          message("PR #5 has new comments", { createdBy: "agent" }),
          reply("Checks are still pending", "run-3"),
          message("Draft the Slack post"),
          reply("Still writing", "run-4"),
          message("Half-streamed", { streaming: true }),
        ],
        [
          run("run-1", "completed"),
          run("run-2", "completed"),
          run("run-3", "completed"),
          run("run-4", "running"),
        ],
      ),
      [
        { from: "user", text: "https://example.slack.com/archives/C1/p1" },
        { from: "assistant", text: "It is about vendor fallbacks" },
        { from: "user", text: "Write the PRs" },
        { from: "assistant", text: "Checks are still pending" },
        { from: "user", text: "Draft the Slack post" },
      ],
    );
  });
});
