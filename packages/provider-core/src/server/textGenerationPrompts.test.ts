import { describe, expect, it } from "vite-plus/test";

import { formatWorktreeTitleContext } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("formatWorktreeTitleContext", () => {
  it("keeps each thread's first and latest two requests, newest thread first", () => {
    expect(
      formatWorktreeTitleContext([
        { title: "Pairing expiry", requests: ["Fix pairing\n  expiry", "one", "two", "three"] },
        { title: "QR layout", requests: ["Improve QR sharing layout"] },
      ]),
    ).toBe(
      [
        'Thread 1: "Pairing expiry"',
        "- Fix pairing expiry",
        "- …",
        "- two",
        "- three",
        "",
        'Thread 2: "QR layout"',
        "- Improve QR sharing layout",
      ].join("\n"),
    );
  });

  it("caps each request and spends the budget on the newest threads first", () => {
    const long = "x".repeat(1_000);
    const context = formatWorktreeTitleContext(
      ["Newest", "Middle", "Oldest"].map((title) => ({ title, requests: [long, long, long] })),
    );
    expect(context.length).toBeLessThanOrEqual(2_500);
    expect(context).toContain('Thread 1: "Newest"');
    expect(context.split("\n").every((line) => line.length <= 400 + "- ".length)).toBe(true);
  });
});
