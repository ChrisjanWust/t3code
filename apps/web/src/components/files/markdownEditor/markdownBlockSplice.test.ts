import { getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vite-plus/test";

import { loadMarkdownDocument, saveMarkdownDocument } from "./markdownBlockSplice";
import { markdownAtomExtensions, markdownEditorExtensions } from "./markdownEditorSchema";
import { serializeMarkdown } from "./vmark/markdownPipeline";

const schema = getSchema([...markdownEditorExtensions, ...markdownAtomExtensions]);

// Written in styles the serializer would normalize: `*` bullets, `__bold__`,
// setext heading, `~~~` fence, unpadded table, reference link, raw HTML.
const SOURCE = `---
title: Demo
---

Title
=====

Intro with __bold__ and _italic_ and a [ref][docs] link.
* one
* two

~~~ts
const a = 1;
~~~

|a|b|
|:-|-:|
|1|2|

> [!NOTE]
> Heads up.

<details>
<summary>More</summary>

Hidden ~/path text.

</details>

1) first
2) second

- [ ] todo
- [x] done

Last line with a footnote[^1].

[^1]: The note.

[docs]: https://example.com
`;

function withBlocks(doc: ProseMirrorNode, blocks: ReadonlyArray<ProseMirrorNode>) {
  return doc.type.create(doc.attrs, blocks);
}

function blocksOf(doc: ProseMirrorNode): ProseMirrorNode[] {
  const blocks: ProseMirrorNode[] = [];
  doc.forEach((child) => blocks.push(child));
  return blocks;
}

const paragraph = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text));

function canonical(markdown: string): string {
  return serializeMarkdown(schema, loadMarkdownDocument(schema, markdown).doc);
}

describe("saveMarkdownDocument", () => {
  it("returns the source untouched when nothing changed", () => {
    const loaded = loadMarkdownDocument(schema, SOURCE);
    expect(loaded.blockStarts).not.toBeNull();
    expect(saveMarkdownDocument(schema, loaded, loaded.doc)).toBe(SOURCE);
  });

  it("rewrites only the edited block", () => {
    const loaded = loadMarkdownDocument(schema, SOURCE);
    const blocks = blocksOf(loaded.doc);
    const index = blocks.findIndex((block) => block.textContent.startsWith("Last line"));
    blocks[index] = paragraph("Rewritten ending.");
    const saved = saveMarkdownDocument(schema, loaded, withBlocks(loaded.doc, blocks));
    expect(saved).toBe(SOURCE.replace("Last line with a footnote[^1].", "Rewritten ending."));
  });

  it("keeps the rest byte-identical when a block is inserted or removed", () => {
    const loaded = loadMarkdownDocument(schema, SOURCE);
    const blocks = blocksOf(loaded.doc);
    const table = blocks.findIndex((block) => block.type.name === "table");
    const inserted = [...blocks.slice(0, table), paragraph("New block."), ...blocks.slice(table)];
    expect(saveMarkdownDocument(schema, loaded, withBlocks(loaded.doc, inserted))).toBe(
      SOURCE.replace("|a|b|", "New block.\n\n|a|b|"),
    );
    const removed = blocks.filter((_, index) => index !== table);
    expect(saveMarkdownDocument(schema, loaded, withBlocks(loaded.doc, removed))).toBe(
      SOURCE.replace("|a|b|\n|:-|-:|\n|1|2|\n\n", ""),
    );
  });

  it("produces a document that parses back to the edited one, for an edit at every block", () => {
    const loaded = loadMarkdownDocument(schema, SOURCE);
    const blocks = blocksOf(loaded.doc);
    for (let index = 0; index < blocks.length; index++) {
      for (const replacement of [[paragraph("Changed.")], [], [blocks[index]!, blocks[index]!]]) {
        const next = [...blocks.slice(0, index), ...replacement, ...blocks.slice(index + 1)];
        if (next.length === 0) continue;
        const current = withBlocks(loaded.doc, next);
        const saved = saveMarkdownDocument(schema, loaded, current);
        expect(canonical(saved), `block ${index} (${blocks[index]!.type.name})`).toBe(
          canonical(serializeMarkdown(schema, current)),
        );
      }
    }
  });

  it("keeps CRLF line endings and a missing final newline", () => {
    const source = "First.\r\n\r\n* a\r\n* b\r\n\r\nLast.";
    const loaded = loadMarkdownDocument(schema, source);
    const blocks = blocksOf(loaded.doc);
    blocks[0] = paragraph("Changed.");
    blocks.push(paragraph("Added."));
    expect(saveMarkdownDocument(schema, loaded, withBlocks(loaded.doc, blocks))).toBe(
      "Changed.\r\n\r\n* a\r\n* b\r\n\r\nLast.\r\n\r\nAdded.",
    );
  });
});
