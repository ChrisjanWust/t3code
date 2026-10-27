import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import {
  buildWorktreeTabs,
  collapseToWorktreeRows,
  draftWorktreeKey,
  isBlankLastTab,
  resolveTabAfterClose,
  resolveWorktreeReopenSet,
  resolveWorktreeReturnTab,
  resolveWorktreeStatusThread,
  resolveWorktreeTabs,
  worktreeKey,
  worktreeLabel,
} from "./threadTabs.logic";

const NOW = "2026-10-26T12:00:00.000Z";

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    environmentId: "env-1",
    projectId: "project-1",
    id,
    title: id,
    branch: "feature",
    worktreePath: "/repo/.t3/worktrees/feature",
    createdAt: "2026-10-26T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    lineage: { relationshipToParent: null, parentThreadId: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    runtime: null,
    blockedOnThreadWait: false,
    ...overrides,
  } as unknown as SidebarThreadSummary;
}

const FEATURE = worktreeKey(thread("any"));

type WorktreeTabDraftInput = Parameters<typeof buildWorktreeTabs>[0]["drafts"][number];

describe("resolveWorktreeTabs", () => {
  it("lists the worktree's open threads oldest first", () => {
    const tabs = resolveWorktreeTabs(
      [
        thread("forked", { createdAt: "2026-10-26T11:00:00.000Z" }),
        thread("first", { createdAt: "2026-10-26T09:00:00.000Z" }),
        thread("other-worktree", { worktreePath: "/repo/.t3/worktrees/other" }),
        thread("root", { worktreePath: null }),
      ],
      FEATURE,
      NOW,
    );
    expect(tabs.map((tab) => tab.id)).toEqual(["first", "forked"]);
  });

  it("leaves out closed, snoozed, archived and subagent threads", () => {
    const tabs = resolveWorktreeTabs(
      [
        thread("open"),
        thread("closed", { settledOverride: "settled", settledAt: NOW }),
        thread("snoozed", { snoozedAt: NOW, snoozedUntil: "2026-10-27T09:00:00.000Z" }),
        thread("woke", { snoozedAt: NOW, snoozedUntil: "2026-10-26T11:00:00.000Z" }),
        thread("archived", { archivedAt: NOW }),
        thread("subagent", {
          lineage: {
            relationshipToParent: "subagent",
            parentThreadId: "open",
          } as SidebarThreadSummary["lineage"],
        }),
      ],
      FEATURE,
      NOW,
    );
    expect(tabs.map((tab) => tab.id)).toEqual(["open", "woke"]);
  });
});

describe("buildWorktreeTabs", () => {
  const draft = (draftId: string, overrides: Partial<WorktreeTabDraftInput> = {}) => ({
    draftId,
    threadId: `${draftId}-thread`,
    createdAt: "2026-10-26T11:00:00.000Z",
    worktreeKey: FEATURE,
    hasContent: false,
    ...overrides,
  });
  const build = (
    threads: SidebarThreadSummary[],
    drafts: WorktreeTabDraftInput[],
    routeKey: string,
  ) =>
    buildWorktreeTabs({
      threads,
      drafts,
      worktreeKey: FEATURE,
      routeKey,
      threadKey: (tab) => tab.id,
      now: NOW,
    }).map((tab) =>
      tab.kind === "thread" ? `${tab.key}${tab.closed ? " (closed)" : ""}` : tab.key,
    );

  it("keeps a closed thread opened from History as a tab while it is open", () => {
    const closed = thread("closed", {
      settledOverride: "settled",
      settledAt: NOW,
      createdAt: "2026-10-26T09:00:00.000Z",
    });
    expect(build([thread("open"), closed], [], "closed")).toEqual(["closed (closed)", "open"]);
    expect(build([thread("open"), closed], [], "open")).toEqual(["open"]);
  });

  it("adds the open draft and drafts with content, after the threads", () => {
    expect(
      build(
        [thread("open")],
        [
          draft("blank"),
          draft("typed", { hasContent: true }),
          draft("elsewhere", { hasContent: true, worktreeKey: null }),
          draft("sent", { hasContent: true, threadId: "open" }),
        ],
        "blank",
      ),
    ).toEqual(["open", "blank", "typed"]);
  });

  it("leaves nothing to close when the only tab is a blank draft", () => {
    const tabs = (threads: SidebarThreadSummary[], drafts: WorktreeTabDraftInput[]) =>
      buildWorktreeTabs({
        threads,
        drafts,
        worktreeKey: FEATURE,
        routeKey: "blank",
        threadKey: (tab) => tab.id,
        now: NOW,
      });

    expect(isBlankLastTab(tabs([], [draft("blank")]))).toBe(true);
    expect(isBlankLastTab(tabs([], [draft("blank", { hasContent: true })]))).toBe(false);
    expect(isBlankLastTab(tabs([thread("open")], [draft("blank")]))).toBe(false);
  });
});

describe("collapseToWorktreeRows", () => {
  it("keeps one row per worktree, in its most prominent section and position", () => {
    const other = { worktreePath: "/repo/.t3/worktrees/other" };
    const rows = collapseToWorktreeRows({
      pinned: [thread("feature-pinned")],
      active: [thread("other-done", other), thread("feature-done")],
      working: [thread("other-working", other)],
      snoozed: [],
      settled: [thread("root-settled", { worktreePath: null }), thread("feature-settled")],
    });
    expect({
      pinned: rows.pinned.map((row) => row.id),
      active: rows.active.map((row) => row.id),
      working: rows.working.map((row) => row.id),
      settled: rows.settled.map((row) => row.id),
    }).toEqual({
      pinned: ["feature-pinned"],
      active: ["other-done"],
      working: [],
      settled: ["root-settled"],
    });
  });

  it("puts a fork in its source's row", () => {
    const rows = collapseToWorktreeRows({
      pinned: [],
      active: [thread("fork", { createdAt: "2026-10-26T11:00:00.000Z" }), thread("source")],
      working: [],
      snoozed: [],
      settled: [],
    });
    expect(rows.active.map((row) => row.id)).toEqual(["fork"]);
  });
});

describe("resolveWorktreeReopenSet", () => {
  it("brings back the tabs settled together last, not tabs closed earlier", () => {
    const together = "2026-10-26T11:30:00.000Z";
    const reopen = resolveWorktreeReopenSet([
      thread("closed-earlier", {
        settledOverride: "settled",
        settledAt: "2026-10-26T11:00:00.000Z",
      }),
      thread("tab-a", { settledOverride: "settled", settledAt: together }),
      thread("tab-b", { settledOverride: "settled", settledAt: together }),
      thread("open"),
    ]);
    expect(reopen.map((tab) => tab.id)).toEqual(["tab-a", "tab-b"]);
  });

  it("finds nothing to reopen when no thread is settled", () => {
    expect(resolveWorktreeReopenSet([thread("open")])).toEqual([]);
  });
});

describe("resolveWorktreeReturnTab", () => {
  it("returns to the tab visited last, counting unvisited tabs from creation", () => {
    const visited = thread("visited");
    const created = thread("created", { createdAt: "2026-10-26T11:00:00.000Z" });
    const lastVisitedAt = (tab: SidebarThreadSummary) =>
      tab === visited ? "2026-10-26T11:30:00.000Z" : undefined;
    expect(resolveWorktreeReturnTab([created, visited], lastVisitedAt)?.id).toBe("visited");
    expect(resolveWorktreeReturnTab([thread("first"), created], () => undefined)?.id).toBe(
      "created",
    );
  });
});

describe("draftWorktreeKey", () => {
  it("places a draft in its worktree unless it will create a new one", () => {
    const draft = (worktreePath: string | null, envMode: "local" | "worktree") => ({
      ...thread("draft", { worktreePath }),
      envMode,
    });
    expect(draftWorktreeKey(draft("/repo/.t3/worktrees/feature", "worktree"))).toBe(FEATURE);
    expect(draftWorktreeKey(draft(null, "worktree"))).toBeNull();
    expect(draftWorktreeKey(draft(null, "local"))).toBe(
      worktreeKey(thread("root", { worktreePath: null })),
    );
  });
});

describe("resolveTabAfterClose", () => {
  it("moves to the right neighbor, then the left, then nowhere", () => {
    expect(resolveTabAfterClose(["a", "b", "c"], "b")).toBe("c");
    expect(resolveTabAfterClose(["a", "b", "c"], "c")).toBe("b");
    expect(resolveTabAfterClose(["a"], "a")).toBeNull();
  });
});

describe("resolveWorktreeStatusThread", () => {
  it("shows the tab that most needs the user", () => {
    const working = thread("working", {
      runtime: { status: "running" } as SidebarThreadSummary["runtime"],
    });
    const approval = thread("approval", { hasPendingApprovals: true });
    const done = thread("done");
    expect(resolveWorktreeStatusThread([working, approval, done], () => false)?.id).toBe(
      "approval",
    );
    expect(resolveWorktreeStatusThread([done, working], () => false)?.id).toBe("working");
    expect(
      resolveWorktreeStatusThread([thread("read"), done], (candidate) => candidate === done)?.id,
    ).toBe("done");
  });
});

describe("worktreeLabel", () => {
  it("names a worktree by its branch, then its folder", () => {
    expect(worktreeLabel(thread("a"))).toBe("feature");
    expect(worktreeLabel(thread("a", { branch: null }))).toBe("feature");
    expect(worktreeLabel(thread("a", { branch: null, worktreePath: null, title: "Chat" }))).toBe(
      "Chat",
    );
  });
});
