#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CodexSettings,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ClaudeTextGeneration from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import * as CodexTextGeneration from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { worktreeTitleEvaluationCases } from "./cases.ts";
import { gradeWorktreeTitle } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    provider: { type: "string", default: "claude" },
    model: { type: "string" },
    effort: { type: "string" },
    out: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "1" },
  },
});
if (!values.model || !values.out) {
  throw new Error(
    "Use --model <model> --out <directory> [--provider claude|codex] [--effort <level>].",
  );
}
const provider = values.provider === "codex" ? "codex" : "claude";
const model = values.model;
const outputDirectory = values.out;
const samples = Number(values.samples);
const caseIds = values.case?.split(",");
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-worktree-title-evaluation-" });
    const generation =
      provider === "codex"
        ? yield* CodexTextGeneration.makeCodexTextGeneration(yield* decodeCodexSettings({}))
        : yield* ClaudeTextGeneration.makeClaudeTextGeneration(yield* decodeClaudeSettings({}));
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make(provider === "codex" ? "codex" : "claudeAgent"),
      model,
      ...(values.effort === undefined
        ? {}
        : {
            options: [
              { id: provider === "codex" ? "reasoningEffort" : "effort", value: values.effort },
            ],
          }),
    };
    const results = [];
    for (const fixture of worktreeTitleEvaluationCases) {
      if (caseIds && !caseIds.includes(fixture.id)) continue;
      for (let sample = 0; sample < samples; sample += 1) {
        const [elapsed, { title }] = yield* generation
          .generateWorktreeTitle({
            cwd,
            threads: fixture.threads,
            previousTitle: fixture.previousTitle,
            modelSelection,
          })
          .pipe(Effect.timed);
        results.push({
          id: fixture.id,
          sample,
          title,
          previousTitle: fixture.previousTitle ?? null,
          rubric: fixture.rubric,
          checks: gradeWorktreeTitle(fixture, title),
          latencyMs: Duration.toMillis(elapsed),
        });
      }
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(outputDirectory, "results.json"),
      yield* encodeReport(results),
    );
    const failed = results.filter(
      (result) => !result.checks.wordCount || result.checks.keptPrevious === false,
    );
    yield* Effect.log(
      `Wrote ${results.length} titles to ${outputDirectory}. ${failed.length} failed an automatic check. Read each title against its rubric.`,
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-worktree-title-evaluation-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
