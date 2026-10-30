import { describe, expect, it } from "vite-plus/test";

import { gradeWorktreeTitle } from "./grade.ts";

describe("gradeWorktreeTitle", () => {
  const fixture = {
    id: "case",
    source: "test",
    threads: [],
    previousTitle: "Pairing token expiry",
    keepPrevious: true,
    rubric: "",
  };

  it("checks length and stability", () => {
    expect(gradeWorktreeTitle(fixture, "Pairing token expiry")).toEqual({
      wordCount: true,
      keptPrevious: true,
    });
    expect(gradeWorktreeTitle(fixture, "Pairing links")).toEqual({
      wordCount: false,
      keptPrevious: false,
    });
    expect(
      gradeWorktreeTitle({ ...fixture, keepPrevious: false }, "Pairing token expiry").keptPrevious,
    ).toBeNull();
  });
});
