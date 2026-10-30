# Worktree titles

Generates sidebar titles for worktrees from their recent threads with the server's title generator, the same prompt and context trimming the server uses.

## Run

```sh
cd evals
pnpm worktree-titles --model claude-haiku-5-5 --effort medium --out runs/worktree-titles
pnpm worktree-titles --provider codex --model <codex model> --out runs/worktree-titles-codex
```

- It uses your local Claude or Codex login, like the server does. Claude is the default provider.
- `--samples <n>` repeats each case; `--case <ids>` runs only some.
- A run writes `results.json`. Each title has two automatic checks: 3 to 9 words, and, for cases marked `keepPrevious`, that the current title came back unchanged. Read every title against its `rubric` as well.
- Each call is one short prompt, so a full run costs a few cents on Haiku.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, the worktree's `threads` (newest first), an optional `previousTitle`, and a `rubric`. Set `keepPrevious` when the current title still fits and must not change.
