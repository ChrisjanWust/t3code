import type { WorktreeTitleCase } from "./cases.ts";

/** Checks that need no judgment; a person still reads every title against its rubric. */
export function gradeWorktreeTitle(fixture: WorktreeTitleCase, title: string) {
  const words = title.split(/\s+/).filter(Boolean).length;
  return {
    wordCount: words >= 3 && words <= 9,
    keptPrevious: fixture.keepPrevious === true ? title === fixture.previousTitle : null,
  };
}
