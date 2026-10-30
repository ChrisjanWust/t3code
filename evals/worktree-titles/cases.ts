import type { WorktreeTitleThread } from "@t3tools/provider-core/server/textGeneration";

export interface WorktreeTitleCase {
  readonly id: string;
  readonly source: string;
  /** Newest first, as the server sends them. */
  readonly threads: ReadonlyArray<WorktreeTitleThread>;
  readonly previousTitle?: string;
  /** The current title still fits, so the model must return it unchanged. */
  readonly keepPrevious?: boolean;
  readonly rubric: string;
}

export const worktreeTitleEvaluationCases: ReadonlyArray<WorktreeTitleCase> = [
  {
    id: "new-worktree",
    source: "A new worktree's first thread",
    threads: [
      {
        title: "Fix pairing token expiry",
        requests: [
          "Pairing links expire after a minute on mobile. Make them last the full window.",
        ],
      },
    ],
    rubric: "Name pairing link expiry.",
  },
  {
    id: "same-subject-new-thread",
    source: "Control: a second thread on the same work must not churn the title",
    previousTitle: "Pairing token expiry",
    keepPrevious: true,
    threads: [
      { title: "Test pairing expiry on Android", requests: ["Now check it on the Android app."] },
      {
        title: "Fix pairing token expiry",
        requests: [
          "Pairing links expire after a minute on mobile. Make them last the full window.",
        ],
      },
    ],
    rubric: "Keep the current title.",
  },
  {
    id: "workflow-threads",
    source: "Review, CI, and merge threads that share one subject",
    previousTitle: "Shared onboarding wizard",
    keepPrevious: true,
    threads: [
      { title: "Fix onboarding CI failure", requests: ["CI is red on the onboarding PR, fix it."] },
      {
        title: "Review onboarding wizard PR",
        requests: ["Review the PR for the shared onboarding wizard."],
      },
      {
        title: "Shared onboarding wizard",
        requests: ["Make onboarding one shared wizard across computers.", "File a PR."],
      },
    ],
    rubric: "Keep the onboarding subject; do not title it after CI or review.",
  },
  {
    id: "subject-changed",
    source: "The newest threads moved to different work in the same worktree",
    previousTitle: "QR sharing layout",
    threads: [
      {
        title: "Relay reconnect backoff",
        requests: ["Remote clients hammer the relay on reconnect. Add exponential backoff."],
      },
      {
        title: "Relay reconnect storms",
        requests: ["Why do clients reconnect in a tight loop after the relay restarts?"],
      },
      { title: "QR sharing layout", requests: ["Improve the QR sharing layout."] },
    ],
    rubric: "Replace the QR title with relay reconnect backoff.",
  },
  {
    id: "issue-number",
    source: "An issue number is what distinguishes the work",
    threads: [
      {
        title: "Fix issue 8812 crash",
        requests: ["Fix #8812: the diff panel crashes on binary files."],
      },
    ],
    rubric: "Name the binary-file diff crash; keeping #8812 is fine.",
  },
];
