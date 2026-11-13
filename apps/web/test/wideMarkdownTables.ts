import { expect } from "vite-plus/test";

const WIDE_ROW = [
  "Keep the explanation readable",
  "Allow each column to wrap",
  "`apps/web/src/components/chat/MarkdownTable.tsx`",
  "Collapse and expand again",
  "Keep narrow layouts working",
  "Resize the conversation lane",
  "Verification follows release",
  "Followup actions are tracked",
];

/** A paragraph, a small table, a wide table, and a wide table inside a list item. */
export const WIDE_TABLES_MARKDOWN = [
  "The tables below compare each change against the release checklist so reviewers can scan them.",
  "",
  "| Key | Value |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  `| ${WIDE_ROW.map((_, index) => `Column ${index + 1}`).join(" | ")} |`,
  `| ${WIDE_ROW.map(() => "---").join(" | ")} |`,
  `| ${WIDE_ROW.join(" | ")} |`,
  "",
  "- Nested tables stay in their list item:",
  "",
  `  | ${WIDE_ROW.map((_, index) => `Column ${index + 1}`).join(" | ")} |`,
  `  | ${WIDE_ROW.map(() => "---").join(" | ")} |`,
  `  | ${WIDE_ROW.join(" | ")} |`,
].join("\n");

const scroller = (table: HTMLTableElement) =>
  table.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;

// The text column is the markdown root's content box; wrapped text stops short of its right edge.
function textColumn(root: HTMLElement) {
  const rect = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  return {
    left: rect.left + Number.parseFloat(style.paddingLeft),
    right: rect.right - Number.parseFloat(style.paddingRight),
  };
}

function tables(root: HTMLElement) {
  const [small, wide, nested] = root.querySelectorAll("table");
  return { small: small!, wide: wide!, nested: nested! };
}

/** Checks {@link WIDE_TABLES_MARKDOWN} rendered with wide tables in a pane with free margins. */
export function expectTablesUseMargins(root: HTMLElement, scrollArea: HTMLElement) {
  const { small, wide, nested } = tables(root);
  const column = textColumn(root);

  const smallRect = small.getBoundingClientRect();
  expect(smallRect.width).toBeLessThan((column.right - column.left) / 3);
  expect(
    Math.abs(smallRect.left - root.querySelector("p")!.getBoundingClientRect().left),
  ).toBeLessThanOrEqual(1);

  const wideRect = scroller(wide).getBoundingClientRect();
  const leftGrowth = column.left - wideRect.left;
  const rightGrowth = wideRect.right - column.right;
  expect(leftGrowth).toBeGreaterThan(20);
  expect(rightGrowth).toBeGreaterThan(20);
  expect(Math.abs(leftGrowth - rightGrowth)).toBeLessThanOrEqual(2);
  const area = scrollArea.getBoundingClientRect();
  expect(wideRect.left).toBeGreaterThanOrEqual(area.left);
  expect(wideRect.right).toBeLessThanOrEqual(area.right);

  const cell = wide.tBodies[0]!.rows[0]!.cells[0]!.getBoundingClientRect();
  const y = cell.top + cell.height / 2;
  expect(wide.contains(document.elementFromPoint(wideRect.left + 2, y))).toBe(true);
  expect(wide.contains(document.elementFromPoint(wideRect.right - 2, y))).toBe(true);

  const nestedRect = scroller(nested).getBoundingClientRect();
  expect(nestedRect.left).toBeGreaterThanOrEqual(column.left - 0.5);
  expect(nestedRect.right).toBeLessThanOrEqual(column.right + 0.5);
}

/** Checks that every table in markdown that did not opt into wide tables stays in its column. */
export function expectTablesStayInColumn(root: HTMLElement) {
  const column = textColumn(root);
  const tables = root.querySelectorAll("table");
  expect(tables.length).toBeGreaterThan(0);
  for (const table of tables) {
    const rect = scroller(table).getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(column.left - 0.5);
    expect(rect.right).toBeLessThanOrEqual(column.right + 0.5);
  }
}

/** Checks {@link WIDE_TABLES_MARKDOWN} in a pane too narrow for the wide table's columns. */
export function expectWideTableScrolls(root: HTMLElement, scrollArea: HTMLElement) {
  const { wide } = tables(root);
  const viewport = scroller(wide);
  expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
  expect(scrollArea.scrollWidth).toBeLessThanOrEqual(scrollArea.clientWidth);
  // The path breaks mid-word instead of holding its column at the path's width.
  expect(wide.querySelector("code")!.getClientRects().length).toBeGreaterThan(1);
}
