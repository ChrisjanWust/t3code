import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Columns this fork adds outside the numbered migrations. A fork migration id would collide with
 * upstream's next one, and the migrator refuses to start on a history it would skip.
 */
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasWorktreeTitles = sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `.pipe(Effect.map((columns) => columns.some((column) => column.name === "worktree_titles_json")));
  // Checked first, because CLI startup must not take the write lock on a current schema.
  if (yield* hasWorktreeTitles) return;
  // In a transaction, so a second process opening the same database cannot add it twice.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      if (yield* hasWorktreeTitles) return;
      yield* sql`
        ALTER TABLE projection_projects
        ADD COLUMN worktree_titles_json TEXT NOT NULL DEFAULT '[]'
      `;
    }),
  );
});
