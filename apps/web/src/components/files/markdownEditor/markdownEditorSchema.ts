import { Extension, InputRule, mergeAttributes, Node, wrappingInputRule } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { ListItem } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

// Node and attribute names here are the vmark pipeline's contract: it reads and
// writes them by name, and drops content whose node type the schema lacks.

const hidden = (fallback: unknown = null) => ({ default: fallback, rendered: false });

const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "alertBlock",
  "bulletList",
  "orderedList",
  "listItem",
  "horizontalRule",
  "table",
  "block_image",
  "footnote_definition",
  "link_definition",
  "frontmatter",
  "html_block",
];

const PipelineAttributes = Extension.create({
  name: "markdownPipelineAttributes",
  addGlobalAttributes() {
    return [
      { types: BLOCK_TYPES, attributes: { sourceLine: hidden(), blankLinesBefore: hidden() } },
      { types: ["bulletList", "orderedList"], attributes: { spread: hidden() } },
      { types: ["listItem"], attributes: { tightBefore: hidden() } },
      { types: ["codeBlock"], attributes: { meta: hidden() } },
      {
        types: ["link", "image", "block_image"],
        attributes: { referenceId: hidden(), referenceType: hidden() },
      },
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          alignment: {
            default: null,
            parseHTML: (element) => element.style.textAlign || null,
            renderHTML: (attributes) =>
              attributes.alignment ? { style: `text-align: ${attributes.alignment}` } : {},
          },
        },
      },
    ];
  },
});

function dataAttributes(names: ReadonlyArray<string>) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        default: name === "label" || name === "title" ? null : "",
        parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes[name] == null ? {} : { [`data-${name}`]: String(attributes[name]) },
      },
    ]),
  );
}

/** A node the editor shows but does not edit in place; its source lives in attributes. */
function sourceAtom(config: {
  name: string;
  inline: boolean;
  attributes: ReadonlyArray<string>;
  text: (attributes: Record<string, unknown>) => string;
}) {
  const tag = config.inline ? "span" : "div";
  return Node.create({
    name: config.name,
    group: config.inline ? "inline" : "block",
    inline: config.inline,
    atom: true,
    selectable: true,
    addAttributes: () => dataAttributes(config.attributes),
    parseHTML: () => [{ tag: `${tag}[data-markdown-atom="${config.name}"]` }],
    renderHTML: ({ node, HTMLAttributes }) => [
      tag,
      mergeAttributes(HTMLAttributes, { "data-markdown-atom": config.name }),
      config.text(node.attrs),
    ],
  });
}

export function imageMarkdown(attributes: Record<string, unknown>): string {
  const src = String(attributes.src ?? "");
  const destination = /[\s()<>]/.test(src) ? `<${src}>` : src;
  const title = attributes.title ? ` "${String(attributes.title).replaceAll('"', '\\"')}"` : "";
  return `![${String(attributes.alt ?? "")}](${destination}${title})`;
}

const FrontmatterNode = sourceAtom({
  name: "frontmatter",
  inline: false,
  attributes: ["value"],
  text: (attributes) => `---\n${String(attributes.value)}\n---`,
});

const LinkDefinitionNode = sourceAtom({
  name: "link_definition",
  inline: false,
  attributes: ["identifier", "label", "url", "title"],
  text: (attributes) =>
    `[${String(attributes.label ?? attributes.identifier)}]: ${String(attributes.url)}${
      attributes.title ? ` "${String(attributes.title)}"` : ""
    }`,
});

export const HtmlBlockNode = sourceAtom({
  name: "html_block",
  inline: false,
  attributes: ["value"],
  text: (attributes) => String(attributes.value),
});

const HtmlInlineNode = sourceAtom({
  name: "html_inline",
  inline: true,
  attributes: ["value"],
  text: (attributes) => String(attributes.value),
});

const MathInlineNode = sourceAtom({
  name: "math_inline",
  inline: true,
  attributes: ["content"],
  text: (attributes) => `$${String(attributes.content)}$`,
});

const FootnoteReferenceNode = sourceAtom({
  name: "footnote_reference",
  inline: true,
  attributes: ["label"],
  text: (attributes) => `[^${String(attributes.label)}]`,
});

export const BlockImageNode = sourceAtom({
  name: "block_image",
  inline: false,
  attributes: ["src", "alt", "title"],
  text: imageMarkdown,
});

export const InlineImageNode = Image.configure({ inline: true });

const FootnoteDefinitionNode = Node.create({
  name: "footnote_definition",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => dataAttributes(["label"]),
  parseHTML: () => [{ tag: "div[data-footnote-definition]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-footnote-definition": "" }),
    0,
  ],
});

const ALERT_TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"];

const AlertBlockNode = Node.create({
  name: "alertBlock",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes: () => ({
    alertType: {
      default: "NOTE",
      parseHTML: (element) => element.getAttribute("data-alert") ?? "NOTE",
      renderHTML: (attributes) => ({ "data-alert": String(attributes.alertType) }),
    },
  }),
  parseHTML: () => [{ tag: "div[data-alert]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", HTMLAttributes, 0],
  addInputRules() {
    return [
      wrappingInputRule({
        find: new RegExp(`^\\[!(${ALERT_TYPES.join("|")})\\]\\s$`, "i"),
        type: this.type,
        getAttributes: (match) => ({ alertType: match[1]!.toUpperCase() }),
      }),
    ];
  },
});

// GFM task items are list items carrying `checked`, not a separate list type.
const MarkdownListItem = ListItem.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      checked: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element) =>
          element.hasAttribute("data-checked")
            ? element.getAttribute("data-checked") === "true"
            : null,
        renderHTML: (attributes) =>
          attributes.checked == null ? {} : { "data-checked": String(attributes.checked) },
      },
    };
  },
  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      Enter: () => {
        const item = this.editor.state.selection.$from.node(-1);
        const task = item?.type === this.type && item.attrs.checked !== null;
        return this.editor.commands.splitListItem(this.name, task ? { checked: false } : {});
      },
    };
  },
  addInputRules() {
    return [
      new InputRule({
        find: /^\[([ xX])\]\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.selection.$from;
          const item = $from.node(-1);
          if (item.type !== this.type || $from.index(-1) !== 0) return null;
          state.tr
            .delete(range.from, range.to)
            .setNodeAttribute($from.before(-1), "checked", match[1] !== " ");
        },
      }),
    ];
  },
});

const cellContent = { content: "paragraph" };

export const markdownEditorExtensions = [
  StarterKit.configure({
    listItem: false,
    underline: false,
    trailingNode: false,
    codeBlock: { HTMLAttributes: { class: "chat-markdown-codeblock" } },
    link: { openOnClick: false, autolink: false },
  }),
  MarkdownListItem,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader.extend(cellContent),
  TableCell.extend(cellContent),
  AlertBlockNode,
  FootnoteDefinitionNode,
  PipelineAttributes,
];

export const markdownAtomExtensions = [
  FrontmatterNode,
  LinkDefinitionNode,
  HtmlBlockNode,
  HtmlInlineNode,
  MathInlineNode,
  FootnoteReferenceNode,
  BlockImageNode,
  InlineImageNode,
];
