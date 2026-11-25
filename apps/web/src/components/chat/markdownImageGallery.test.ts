import { describe, expect, it } from "vite-plus/test";

import { threadImageGallery, workGroupImageGallery } from "./markdownImageGallery";

const item = (name: string) => ({ src: `https://assets.test/${name}`, name });

describe("workGroupImageGallery", () => {
  it("pages the clicked image through the group's resolved images", () => {
    const clicked = { ...item("second.png"), src: "https://assets.test/second.png#fresh" };
    const viewed = [
      { path: "/repo/first.png", item: item("first.png") },
      { path: "/repo/pending.png", item: null },
      { path: "/repo/second.png", item: item("second.png") },
      { path: "/repo/third.png", item: item("third.png") },
    ];
    expect(
      workGroupImageGallery(viewed, "/repo/second.png", { images: [clicked], index: 0 }),
    ).toEqual({ images: [item("first.png"), clicked, item("third.png")], index: 1 });
    const single = { images: [clicked], index: 0 };
    expect(workGroupImageGallery(viewed, "/repo/other.png", single)).toBe(single);
  });
});

describe("threadImageGallery", () => {
  it("pages the clicked image through every message's images, in order", () => {
    const clicked = { ...item("chart.png"), onCopySnapshot: async () => {} };
    const messages = [
      { id: "a", images: [item("chart.png"), item("before.png")] },
      { id: "b", images: [] },
      { id: "c", images: [item("chart.png"), item("after.png")] },
    ];
    // The same image shown again in a later message pages from where it was clicked.
    expect(threadImageGallery(messages, "c", { images: [clicked], index: 0 })).toEqual({
      images: [item("chart.png"), item("before.png"), clicked, item("after.png")],
      index: 2,
    });
    const linkedFile = { images: [item("linked.png")], index: 0 };
    expect(threadImageGallery(messages, "c", linkedFile)).toBe(linkedFile);
  });
});
