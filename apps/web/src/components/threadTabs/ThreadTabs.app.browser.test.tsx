import { createMemoryHistory } from "@tanstack/react-router";
import { type ProjectWorktreeTitle, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  addServerThread,
  dispatchedCommands,
  dispatchedProjectMutations,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  updateServerThread,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { startWorktreePanelSharing } from "./worktreePanelKey";

vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

// The fake server leaves most requests unanswered, which would raise the slow-request toast.
vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// Desktop-sized, so the sidebar and header lay out as they do in the app.
await page.viewport(1400, 900);

const WORKTREE = {
  worktreePath: "/workspace/render-worktrees/feature-tabs",
  branch: "feature/tabs",
};
const inWorktree = (name: string): FakeThread => ({ ...threadWithHistory(name, 2), ...WORKTREE });

function setup(
  extra: ReadonlyArray<FakeThread> = [],
  worktreeTitles?: ReadonlyArray<ProjectWorktreeTitle>,
) {
  // Panel state persists, and a worktree's tabs share it, so each test starts with none open.
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    threadTabsEnabled: true,
  });
  return installFakeEnvironment(
    [
      threadWithHistory("checkout", 2),
      inWorktree("tab-a"),
      inWorktree("tab-b"),
      inWorktree("tab-c"),
      ...extra,
    ],
    { capabilities: { threadSettlement: true }, ...(worktreeTitles ? { worktreeTitles } : {}) },
  );
}

async function mountApp(threadId: string) {
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
  );
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 900px; width: 1400px;";
  // The app owns its router, as main.tsx does.
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

const tabList = () => page.getByRole("tablist", { name: "Thread tabs" });
const tab = (title: string) => tabList().getByRole("tab", { name: title });
const tabTitles = () =>
  tabList()
    .getByRole("tab")
    .elements()
    .map((element) => element.textContent);
// A row's accessible name leads with its label, then its status and project.
const sidebarRow = (label: string) =>
  page.getByRole("treeitem", { name: new RegExp(`^${label}(,|$)`) });
const rowTabCount = (label: string) =>
  sidebarRow(label)
    .element()
    .textContent?.match(/(\d+) tabs?$/)?.[1];
const settleCommands = () =>
  dispatchedCommands().flatMap((command) => (command.type === "thread.settle" ? [command] : []));
const unsettledThreadIds = () =>
  dispatchedCommands().flatMap((command) =>
    command.type === "thread.unsettle" ? [command.threadId] : [],
  );

it("lists the open worktree's threads as tabs, one sidebar row per worktree", async () => {
  using _environment = setup();
  const { screen, router } = await mountApp("tab-a");
  await using _screen = screen;

  await expect.element(tab("Thread tab-c")).toBeVisible();
  expect(tabTitles()).toEqual(["Thread tab-a", "Thread tab-b", "Thread tab-c"]);
  await vi.waitFor(() => expect(rowTabCount("feature/tabs")).toBe("3"));
  expect(rowTabCount("main")).toBe("1");

  await userEvent.click(tab("Thread tab-b"));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/tab-b`));
  await expect.element(tab("Thread tab-b")).toHaveAttribute("aria-selected", "true");

  await userEvent.click(page.getByRole("button", { name: "New tab" }));
  await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/draft\//));
  await expect.element(tab("New thread")).toHaveAttribute("aria-selected", "true");
  expect(tabTitles()).toEqual(["Thread tab-a", "Thread tab-b", "Thread tab-c", "New thread"]);
});

it("closes a tab by settling it and reopens it from the history panel", async () => {
  using _environment = setup();
  const { screen, router } = await mountApp("tab-a");
  await using _screen = screen;

  await userEvent.click(page.getByRole("button", { name: "Close Thread tab-b" }));
  await vi.waitFor(() => expect(tabTitles()).toEqual(["Thread tab-a", "Thread tab-c"]));
  expect(settleCommands().map((command) => command.threadId)).toEqual(["tab-b"]);

  await userEvent.click(page.getByRole("button", { name: "Tab history" }));
  // The strip's tabs are tabs, so the closed thread's only button is its history row.
  const closedRow = page.getByRole("button", { name: /^Thread tab-b/ });
  await expect.element(closedRow).toBeVisible();
  await userEvent.click(closedRow);

  await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/tab-b`));
  expect(unsettledThreadIds()).toEqual(["tab-b"]);
  await vi.waitFor(() =>
    expect(tabTitles()).toEqual(["Thread tab-a", "Thread tab-b", "Thread tab-c"]),
  );
});

it("settles a worktree's open tabs together and reopens the same tabs", async () => {
  using _environment = setup();
  const { screen } = await mountApp("tab-c");
  await using _screen = screen;

  // Closed on its own first, so the worktree's settle leaves it closed when reopened.
  await userEvent.click(page.getByRole("button", { name: "Close Thread tab-c" }));
  await vi.waitFor(() => expect(settleCommands()).toHaveLength(1));

  await userEvent.hover(sidebarRow("feature/tabs"));
  await userEvent.click(
    sidebarRow("feature/tabs").getByRole("button", { name: "Settle worktree" }),
  );
  await vi.waitFor(() => expect(settleCommands()).toHaveLength(3));
  const [, ...worktreeSettles] = settleCommands();
  expect(worktreeSettles.map((command) => command.threadId).toSorted()).toEqual(["tab-a", "tab-b"]);
  expect(new Set(worktreeSettles.map((command) => String(command.settledAt))).size).toBe(1);
  // The shelf's expanded state persists across tests, so it is opened only when collapsed.
  const settledShelf = page.getByTestId("sidebar-settled-shelf-toggle");
  await expect.element(settledShelf).toBeVisible();
  if (settledShelf.element().getAttribute("aria-expanded") !== "true") {
    await userEvent.click(settledShelf);
  }

  await userEvent.hover(sidebarRow("feature/tabs"));
  await userEvent.click(
    sidebarRow("feature/tabs").getByRole("button", { name: "Reopen worktree" }),
  );
  await vi.waitFor(() => expect(unsettledThreadIds().toSorted()).toEqual(["tab-a", "tab-b"]));

  await userEvent.click(sidebarRow("feature/tabs"));
  await vi.waitFor(() => expect(tabTitles()).toEqual(["Thread tab-a", "Thread tab-b"]));
});

it("opens a thread the server adds to the worktree, such as a fork, as a new tab", async () => {
  using _environment = setup();
  const { screen } = await mountApp("tab-a");
  await using _screen = screen;
  await expect.element(tab("Thread tab-c")).toBeVisible();

  addServerThread(inWorktree("tab-fork"));

  await vi.waitFor(() =>
    expect(tabTitles()).toEqual([
      "Thread tab-a",
      "Thread tab-b",
      "Thread tab-c",
      "Thread tab-fork",
    ]),
  );
  await vi.waitFor(() => expect(rowTabCount("feature/tabs")).toBe("4"));
});

it("keeps the right panel when switching tabs, and keeps each worktree's own", async () => {
  using _environment = setup();
  using _sharing = { [Symbol.dispose]: startWorktreePanelSharing() };
  const { screen, router } = await mountApp("tab-a");
  await using _screen = screen;
  const historyPanel = page.getByRole("heading", { name: "Open tabs" });

  await userEvent.click(page.getByRole("button", { name: "Tab history" }));
  await expect.element(historyPanel).toBeVisible();

  await userEvent.click(tab("Thread tab-b"));
  await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/tab-b`));
  await expect.element(historyPanel).toBeVisible();

  await userEvent.click(sidebarRow("main"));
  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/checkout`),
  );
  await expect.element(historyPanel).not.toBeInTheDocument();
});

it("closes the last tab like a browser, leaving a blank tab with nothing to close", async () => {
  using _environment = setup();
  const { screen, router } = await mountApp("checkout");
  await using _screen = screen;
  const closeBlank = page.getByRole("button", { name: "Close New thread" });

  await userEvent.click(page.getByRole("button", { name: "Close Thread checkout" }));
  await vi.waitFor(() => expect(router.state.location.pathname).toMatch(/^\/draft\//));
  await expect.element(tab("New thread")).toBeVisible();
  await expect.element(closeBlank).not.toBeInTheDocument();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("half-written prompt");
  const typedDraft = router.state.location.pathname;
  await userEvent.click(closeBlank);

  await vi.waitFor(() => {
    expect(router.state.location.pathname).toMatch(/^\/draft\//);
    expect(router.state.location.pathname).not.toBe(typedDraft);
  });
  await expect.element(tab("New thread")).toBeVisible();
  expect(tabTitles()).toEqual(["New thread"]);
});

it("closes a new tab back to the tab on its left", async () => {
  using _environment = setup();
  const { screen, router } = await mountApp("tab-a");
  await using _screen = screen;
  await expect.element(tab("Thread tab-c")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "New tab" }));
  await expect.element(tab("New thread")).toHaveAttribute("aria-selected", "true");
  // Typing and clearing leaves a stored draft with no content, as choosing a model does.
  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("x{Backspace}");
  await userEvent.click(page.getByRole("button", { name: "Close New thread" }));

  await vi.waitFor(() => expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/tab-c`));
  await vi.waitFor(() =>
    expect(tabTitles()).toEqual(["Thread tab-a", "Thread tab-b", "Thread tab-c"]),
  );
});

it("keeps a thread out of the checkout's tabs while its new worktree is being created", async () => {
  // Right after send, the server has the thread but not yet its worktree path or branch.
  using _environment = setup([
    { ...threadWithHistory("new-work", 1), branch: null, creatingWorktree: true },
  ]);
  const { screen } = await mountApp("new-work");
  await using _screen = screen;

  await expect.element(tab("Thread new-work")).toHaveAttribute("aria-selected", "true");
  expect(tabTitles()).toEqual(["Thread new-work"]);
  await vi.waitFor(() => expect(rowTabCount("New worktree")).toBe("1"));
  expect(rowTabCount("main")).toBe("1");
  await expect.element(page.getByRole("button", { name: "New tab" })).toBeDisabled();

  updateServerThread(ThreadId.make("new-work"), {
    creatingWorktree: false,
    worktreePath: "/workspace/render-worktrees/new-work",
    branch: "t3/new-work",
  });
  await vi.waitFor(() => expect(rowTabCount("t3/new-work")).toBe("1"));
  expect(sidebarRow("New worktree").elements()).toHaveLength(0);
  expect(tabTitles()).toEqual(["Thread new-work"]);
  await expect.element(page.getByRole("button", { name: "New tab" })).toBeEnabled();
});

it("names a worktree row by its title, and F2 renames the worktree", async () => {
  using _environment = setup(
    [],
    [
      {
        worktreePath: WORKTREE.worktreePath,
        generated: "Thread tab layout",
        manual: null,
        sourceThreadIds: [],
        generatedAt: null,
        updatedAt: "2026-03-17T19:12:28.000Z",
      },
    ],
  );
  const { screen } = await mountApp("tab-a");
  await using _screen = screen;

  await expect.element(sidebarRow("Thread tab layout")).toBeVisible();
  expect(sidebarRow("feature/tabs").elements()).toHaveLength(0);

  sidebarRow("Thread tab layout").element().focus();
  await userEvent.keyboard("{F2}");
  const input = page.getByRole("textbox", { name: "Worktree title" });
  await userEvent.clear(input);
  await userEvent.type(input, "Tabs and worktree rows{Enter}");

  await expect.element(sidebarRow("Tabs and worktree rows")).toBeVisible();
  expect(dispatchedProjectMutations()).toMatchObject([
    {
      type: "project.worktree-title.set",
      worktreePath: WORKTREE.worktreePath,
      title: "Tabs and worktree rows",
    },
  ]);
});
