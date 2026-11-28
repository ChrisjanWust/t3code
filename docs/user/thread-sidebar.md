# Working with threads

Use a separate thread for each task. Choose **New worktree** when a task needs its own Git branch and working directory; threads sharing a checkout share its branch, so T3 Code blocks branch switches while one is running.

## Start a thread

- **Web and desktop**: **New thread** opens the project picker when you have multiple open projects (unless the sidebar is filtered to one project). `Shift`-click to start in the current project. To reuse an existing worktree, choose **New thread in this worktree** from the branch toolbar.
- **Mobile**: **New thread** uses the current, filtered, or last-opened project. Disable **Settings → General → Use last project** to pick every time.
- **Defaults**: New threads inherit your last model and mode unless the project sets its own model default.

### Start without a project

Threads don't require a project. Pick **No project** from the project menu above a new thread's composer or from **New thread in...** in the command palette (or press `mod+alt+n` on web/desktop) to start a scratch thread in `~/.t3/scratch/<date>-<slug>-<id>`.

- Deleting a scratch thread leaves its folder on disk.
- Git branch, worktree, and diff controls are hidden (and scratch threads are unavailable if your T3 data directory itself is inside a Git repo).
- Choose **Move to project › New project** from the thread menu (**Turn into project** on mobile) to promote the folder into a real project in place, then **Initialize Git** if needed.

### Start in the background and multi-model runs

- **Background start** (web/desktop): Press `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) in a new thread to submit it and immediately open another draft with the same workspace mode and base branch.
- **Same prompt, multiple models** (web/desktop, Git projects): `Shift`-click models in a new thread's model picker to select several. Sending starts a separate thread and worktree for each model.

## Move a thread

On web and desktop, right-click a thread, or its tab when worktrees are shown as tabs, and use **Move to worktree** or **Move to project** to change where it works. The conversation comes along, and the agent picks up in the new folder with your next message. A thread has to be idle to move.

- **Move to worktree › New worktree** gives the thread a worktree of its own, on a new branch from the commit its folder is on. **Main** moves it back to the project's own checkout, and the rest are the project's other open worktrees.
- **Move to project** moves the thread into another project's own checkout. Restore points from turns before the move don't work there.

Files never move with a thread. Uncommitted changes stay in the old folder, so commit them first if the thread needs them; T3 Code asks before moving when there are any.

## Sidebar layout and organization

- **Resize or hide** (web/desktop): Drag the sidebar's right edge past its minimum width to hide it; hover the left window edge and click or drag the handle to bring it back.
- **Drop files onto a thread** (web/desktop): Drag files from your computer onto any thread row to open it and attach them to its composer.
- **Pin and reorder**: Pin a thread from its menu or drag threads between **Pinned**, **Active**, and **Settled** (or drag out of **Snoozed** to wake). On mobile, use **Arrange threads** or **Move up / Move down** in the thread menu. Custom order syncs across devices (requires an up-to-date server).
- **Order** (web/desktop): **Settings → General → Thread order** sorts rows by **Recent activity** (the default: a thread moves up when it's created, reopened, sent work, or finishes a turn) or **Created at**, newest first. Either way, pinned threads and active threads you have dragged keep their place, Snoozed stays in wake order, and Settled stays in settlement order. Each device keeps its own choice.
- **Show only recent work** (web/desktop): The clock button next to the project filter limits the sidebar to work from the last 6 hours, 12 hours, 24 hours, 2 days, or 7 days. Activity means a thread was created, messaged, ran, or was settled, snoozed, reopened, or woken; a thread that is running or waiting on you always counts. The open thread stays listed, and search still finds older threads. A Settled count such as **15+** means older pages haven't loaded yet. Each device keeps its own choice.
- **Undo** (web/desktop): Unpinning, settling, snoozing, archiving, or discarding a draft shows a 5-second **Undo** toast (`mod+z`).
- **Titles**: Choose **Regenerate title** from a thread's menu, or customize title style in **Settings → Threads → Text generation → Thread title instructions** (global or per-project).

### Working section (beta)

Enabled by default (**Settings → General → Working section**, per device). Unpinned threads that are actively running—or waiting on subagents, watched PRs, or monitors—collapse into a **Working** section below Active, and return to the top of Active when they finish, fail, or need input (or to their creation slot when you sort by creation date).

While enabled, Active is sorted by most recent return (manual reordering is paused until you turn it off).

### Group threads by project (beta)

Enable **Settings → Labs → Boring sidebar (group by project)** on web/desktop (per device) to group active threads into collapsible project folders. Pinned threads stay above; Snoozed and Settled stay below. In this mode, the Working section and sidebar drag-reordering are disabled (dragging a thread onto the composer still works).

## Thread tabs (Labs)

With **Settings → Labs → Thread tabs** on (web and desktop), each sidebar row is a worktree and its threads are tabs.

- **Worktree titles**: A new worktree gets a short title from its first message, written by the model in **Settings → Threads → Text generation**. The title follows the work slowly: it changes only after the threads it was written from have been quiet for 20 minutes, at most once every 30 minutes, and only when the subject has actually moved. Choose **Rename worktree** from a row's menu or press F2 to name it yourself; clear your name or choose **Reset title** to bring back the generated one. **Regenerate title** writes a fresh title right away and replaces your name.
- **Ordering**: With **Created at** order, a worktree row dates from its oldest open thread, so a new tab in an old worktree does not move it up. With a recent-work filter, a worktree stays while any of its threads is recent, and opening it shows all of its tabs.
- **Tab side panel**: The button at the left end of the tabs moves them into a panel beside the chat, one tab per line, newest first. The top bar then shows only the open tab; the same button at the top of the panel moves the tabs back. Narrow windows always keep the tabs in the top bar. Turn on **Settings → Labs → Thread tabs → Hide the tab panel for one tab** to skip the panel for worktrees with a single tab. Each tab in the panel shows its provider's icon; turn off **Hide provider icons in the sidebar** to show it on worktree rows too.
- **Settled tabs**: Closing a tab in the panel settles it into a folded **Settled** section at the bottom of the panel. Click a settled tab to read it without reopening it. Sending it a message, or the undo arrow that replaces its time on hover, moves it back up. While the panel is hidden for a single tab, find settled tabs under **Tab history** instead.
- **Subagents**: A subagent opens inside its parent's tab, even when it works in a worktree of its own. In the top bar the tab reads `parent › subagent`: click the parent's name to go back, or the subagent's name to switch to another subagent. On the parent, the bot icon on its tab lists them; in the side panel, the open tab lists them under it. Both lists show the five newest first, plus any waiting on you; **Show more** reveals the rest. On desktop, the close-tab shortcut on a subagent returns to the parent instead of closing the tab.
- **Settling**: The `thread.settle` shortcut settles the whole worktree, as its sidebar row's **Settle** button does. Closing a tab settles only that tab.

## Settle, snooze, and archive

| Action      | When to use          | Effect                                                                                                                                         |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settle**  | Task is done for now | Moves to **Settled**; stays searchable; any new message reactivates it. Closes idle terminals (and stops actions with `stopOnSettle: true`).   |
| **Snooze**  | Defer until later    | Hides until wake time (thread keeps working in the background). Wakes early on approvals, questions, errors, or new messages.                  |
| **Archive** | Out of the way       | Leaves sidebar and search; lives in **Settings → Archive**. Refuses new messages (including from agents and scheduled tasks) until unarchived. |

> Tip: If a scheduled task targets a thread, settle it instead of archiving—archiving causes scheduled runs to fail.

### Settlement rules and hooks

- **Automatic settlement**: By default, environments settle threads after 7 days of inactivity or when their linked PR merges/closes (even while your apps are closed). Active work, pending questions/approvals, and waited-on background work block auto-settlement. Configure rules in **Settings → Threads** (per environment or **All environments**), including **Keep threads with a PR**.
- **Per-thread override**: Open a thread's menu → **Auto-settle behavior → Never** to exempt a single thread.
- **Drag-to-settle** (web/desktop): Press and drag down/up from a thread's **Settle**, **Un-settle**, or **Wake** button to act on a contiguous range (`Esc` cancels).
- **Offline settle/snooze**: Queues locally (**Pending** / **Waiting to sync**) and syncs on reconnect; remote changes take precedence if the thread changed in the meantime.
- **Worktree cleanup on settle**: Enable **Run in the thread's worktree when the thread settles** on a project action (or `"runOnSettle": true` in `t3.json`), e.g. `cargo clean`, to reclaim disk space automatically in worktree threads.

### Snooze options

Customize presets in **Settings → Threads → Snooze options** (durations like `3 hours` or times like `9:00 PM tomorrow`), or pick **Snooze → Custom…** for an exact date/time or duration. Choose **Wake thread** to bring a thread back early.

## Link a pull request

The server automatically links open PRs matching an unsettled thread's branch. On web/desktop, right-click any PR link in a thread and choose **Link to thread** or **Unlink from thread** to override it. Linked PRs participate in auto-settlement.

## Find and reference work

- **Command palette** (`Cmd/Ctrl+K`): Searches threads across connected environments by title, branch, PR, project, and message contents (use `"exact phrase"` for exact matches). On mobile, use the thread list search (or `Cmd+K` on iPad with a keyboard).
- **Copy reference**: Copies the linked PR URL if one exists, otherwise a thread link that pastes into any composer as a thread chip. Use **Copy → Thread** (or **Copy thread** on mobile) to force a thread link, or **Thread ID** for scripts and the `t3` CLI.

## Usage limits, subagents, and thread details

- **Usage limits**: When a provider hits a rate/usage limit (**Limited**), press **Resume** in an empty composer after reset (or send a message). If the provider reports a reset time, choose **Resume at reset** or **Snooze until reset**—or enable defaults in **Settings → Threads** (**Resume after usage limits** / **Snooze until limits reset**).
- **Subagents**: Follow delegated work from the conversation card or **Agents**. Stopping a parent thread also stops its delegated subagents. Subagents started internally by the provider are read-only; message the parent thread instead.
- **Running dev servers** (web/desktop): The thread details card lists local servers started by the thread's terminals or Claude agent with their ports. Click one to open it in the browser panel, or **Stop** to end it (macOS/Linux only).
- **Customize thread details**: Right-click the thread details card or open **Settings → Appearance → Thread details** to show/hide rows.

## Open a thread beside the one you are in

On web and desktop, subagents, side chats, and [threads on linked machines](./remote-access.md#read-a-linked-machines-threads) open as a tab in the right panel by default so your main thread stays visible.

- Hold `Cmd`/`Ctrl` while clicking (or middle-click) to open in the main view instead.
- Change the default in **Settings → Chat → Open subagents and side chats in**.
- From a right-panel tab, choose **Open in main view** to promote it.
- On mobile, they open in the inspector where available, or full screen otherwise.

## Side chats

Ask a quick side question about a thread without polluting its history. A side chat starts with the parent thread's context, folder, model, and permissions while the parent keeps working.

- **Start** (web/desktop): Send `/side <question>` or `/btw <question>`, or choose **Side chat** from the right panel's **+** menu.
- **Find later**: Listed under **Side chats** in thread details (web/desktop) or above the composer (mobile); hidden from the main sidebar.
- **Bring results back**: Click **Add to chat** in the side chat, or `@`-mention its title in the parent composer (not readable by external OpenCode servers).
- **Lifecycle**: Closing an unused side chat deletes it. Deleting or archiving the parent thread deletes or archives its side chats.
