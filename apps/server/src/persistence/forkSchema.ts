import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Columns this fork adds outside the numbered migrations. A fork migration id would collide with
 * upstream's next one, and the migrator refuses to start on a history it would skip.
 */
export const ensureForkSchema = Effect.fn("ensureForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // In a transaction, so a second process opening the same database cannot add it twice.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      if (!columns.some((column) => column.name === "worktree_titles_json")) {
        yield* sql`
          ALTER TABLE projection_projects
          ADD COLUMN worktree_titles_json TEXT NOT NULL DEFAULT '[]'
        `;
      }
    }),
  );
});
