import type { ScopedThreadRef } from "@t3tools/contracts";
import type { Editor } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import type { EditorProps, EditorView } from "@tiptap/pm/view";
import {
  EditorContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  useEditorState,
} from "@tiptap/react";
import {
  BoldIcon,
  CodeIcon,
  Columns3Icon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  Rows3Icon,
  SquareCodeIcon,
  StrikethroughIcon,
  Table2Icon,
  TextQuoteIcon,
  Trash2Icon,
} from "lucide-react";
import { createContext, type ReactNode, use, useEffect, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";

import { markdownImageBaseDir } from "../FileMarkdownPreview";
import { Input } from "../../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Separator } from "../../ui/separator";
import { Toggle } from "../../ui/toggle";
import {
  loadMarkdownDocument,
  type MarkdownDocument,
  saveMarkdownDocument,
} from "./markdownBlockSplice";
import {
  BlockImageNode,
  HtmlBlockNode,
  imageMarkdown,
  InlineImageNode,
  markdownAtomExtensions,
  markdownEditorExtensions,
} from "./markdownEditorSchema";
import { parseMarkdown, serializeMarkdown } from "./vmark/markdownPipeline";

interface RenderContext {
  readonly cwd: string;
  readonly imageBaseDir: string;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
}

const MarkdownRenderContext = createContext<RenderContext | null>(null);

/** Shows a node the editor can't edit in place the way the read-only preview renders it. */
function RenderedSource(props: { readonly markdown: string; readonly inline?: boolean }) {
  const context = use(MarkdownRenderContext);
  if (!context) return null;
  return (
    <ChatMarkdown
      text={props.markdown}
      cwd={context.cwd}
      imageBaseDir={context.imageBaseDir}
      threadRef={context.threadRef}
      workspaceMutationId={context.workspaceMutationId}
      {...(props.inline ? { className: "inline-block w-auto align-middle [&>p]:m-0" } : {})}
    />
  );
}

function ImageNodeView({ node }: NodeViewProps) {
  const inline = node.type.name === "image";
  return (
    <NodeViewWrapper as={inline ? "span" : "div"} data-markdown-atom={node.type.name}>
      <RenderedSource markdown={imageMarkdown(node.attrs)} inline={inline} />
    </NodeViewWrapper>
  );
}

// A lone `<details>` opener or closing tag renders as nothing, so those stay source.
function rendersOnItsOwn(html: string): boolean {
  const opened = html.match(/<details\b/gi)?.length ?? 0;
  const closed = html.match(/<\/details>/gi)?.length ?? 0;
  if (opened !== closed) return false;
  const body = new DOMParser().parseFromString(html, "text/html").body;
  return (
    (body.textContent ?? "").trim() !== "" ||
    body.querySelector("img, svg, video, audio, picture, hr, table") !== null
  );
}

function HtmlBlockNodeView({ node }: NodeViewProps) {
  const html = String(node.attrs.value);
  return (
    <NodeViewWrapper data-markdown-atom="html_block">
      {rendersOnItsOwn(html) ? <RenderedSource markdown={html} /> : html}
    </NodeViewWrapper>
  );
}

const imageNodeView = { addNodeView: () => ReactNodeViewRenderer(ImageNodeView) };
const renderedAtomNames = new Set([BlockImageNode.name, InlineImageNode.name, HtmlBlockNode.name]);

const extensions = [
  ...markdownEditorExtensions,
  ...markdownAtomExtensions.filter((extension) => !renderedAtomNames.has(extension.name)),
  BlockImageNode.extend(imageNodeView),
  InlineImageNode.extend(imageNodeView),
  HtmlBlockNode.extend({ addNodeView: () => ReactNodeViewRenderer(HtmlBlockNodeView) }),
];

function ToolbarToggle(props: {
  readonly label: string;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Toggle
      size="xs"
      variant="ghost"
      aria-label={props.label}
      title={props.label}
      pressed={props.pressed ?? false}
      disabled={props.disabled}
      // Keeps the selection in the document while the control is pressed.
      onMouseDown={(event) => event.preventDefault()}
      onPressedChange={props.onPress}
    >
      {props.children}
    </Toggle>
  );
}

function toggleTaskList(editor: Editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "listItem") continue;
    const position = $from.before(depth);
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.setNodeAttribute(position, "checked", node.attrs.checked === null ? false : null);
        return true;
      })
      .run();
    return;
  }
  editor
    .chain()
    .focus()
    .toggleBulletList()
    .command(({ tr, state }) => {
      const { $from: $next } = state.selection;
      for (let depth = $next.depth; depth > 0; depth--) {
        if ($next.node(depth).type.name !== "listItem") continue;
        tr.setNodeAttribute($next.before(depth), "checked", false);
        break;
      }
      return true;
    })
    .run();
}

function LinkControl({ editor, pressed }: { readonly editor: Editor; readonly pressed: boolean }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const apply = () => {
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href.trim() === "") chain.unsetLink().run();
    // An edited URL no longer belongs to the reference definition it came from.
    else chain.setLink({ href: href.trim() }).updateAttributes("link", { referenceId: null }).run();
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        const current: unknown = editor.getAttributes("link").href;
        if (next) setHref(typeof current === "string" ? current : "");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Toggle
            size="xs"
            variant="ghost"
            aria-label="Link"
            title="Link"
            pressed={pressed}
            onMouseDown={(event) => event.preventDefault()}
          />
        }
      >
        <LinkIcon />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <Input
            autoFocus
            size="compact"
            aria-label="Link URL"
            placeholder="https://… (empty removes the link)"
            value={href}
            onChange={(event) => setHref(event.currentTarget.value)}
          />
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function Toolbar({ editor }: { readonly editor: Editor }) {
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      link: current.isActive("link"),
      heading: current.isActive("heading") ? Number(current.getAttributes("heading").level) : 0,
      bulletList: current.isActive("bulletList"),
      orderedList: current.isActive("orderedList"),
      task: current.getAttributes("listItem").checked != null,
      blockquote: current.isActive("blockquote"),
      codeBlock: current.isActive("codeBlock"),
      table: current.isActive("table"),
    }),
  });
  const run = () => editor.chain().focus();
  const headings = [
    [1, Heading1Icon],
    [2, Heading2Icon],
    [3, Heading3Icon],
  ] as const;

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border/60 px-3 py-1"
    >
      {headings.map(([level, Icon]) => (
        <ToolbarToggle
          key={level}
          label={`Heading ${level}`}
          pressed={active.heading === level}
          onPress={() => run().toggleHeading({ level }).run()}
        >
          <Icon />
        </ToolbarToggle>
      ))}
      <Separator orientation="vertical" className="mx-1 h-4" />
      <ToolbarToggle label="Bold" pressed={active.bold} onPress={() => run().toggleBold().run()}>
        <BoldIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label="Italic"
        pressed={active.italic}
        onPress={() => run().toggleItalic().run()}
      >
        <ItalicIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label="Strikethrough"
        pressed={active.strike}
        onPress={() => run().toggleStrike().run()}
      >
        <StrikethroughIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label="Inline code"
        pressed={active.code}
        onPress={() => run().toggleCode().run()}
      >
        <CodeIcon />
      </ToolbarToggle>
      <LinkControl editor={editor} pressed={active.link} />
      <Separator orientation="vertical" className="mx-1 h-4" />
      <ToolbarToggle
        label="Bullet list"
        pressed={active.bulletList && !active.task}
        onPress={() => (active.task ? toggleTaskList(editor) : run().toggleBulletList().run())}
      >
        <ListIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label="Numbered list"
        pressed={active.orderedList}
        onPress={() => run().toggleOrderedList().run()}
      >
        <ListOrderedIcon />
      </ToolbarToggle>
      <ToolbarToggle label="Task list" pressed={active.task} onPress={() => toggleTaskList(editor)}>
        <ListChecksIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label="Quote"
        pressed={active.blockquote}
        onPress={() => run().toggleBlockquote().run()}
      >
        <TextQuoteIcon />
      </ToolbarToggle>
      <ToolbarToggle
        label="Code block"
        pressed={active.codeBlock}
        onPress={() => run().toggleCodeBlock().run()}
      >
        <SquareCodeIcon />
      </ToolbarToggle>
      <ToolbarToggle label="Divider" onPress={() => run().setHorizontalRule().run()}>
        <MinusIcon />
      </ToolbarToggle>
      <Separator orientation="vertical" className="mx-1 h-4" />
      <ToolbarToggle
        label="Insert table"
        disabled={active.table}
        onPress={() => run().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Table2Icon />
      </ToolbarToggle>
      {active.table ? (
        <>
          <ToolbarToggle label="Add row below" onPress={() => run().addRowAfter().run()}>
            <Rows3Icon />
          </ToolbarToggle>
          <ToolbarToggle label="Add column right" onPress={() => run().addColumnAfter().run()}>
            <Columns3Icon />
          </ToolbarToggle>
          <ToolbarToggle label="Delete row" onPress={() => run().deleteRow().run()}>
            <Rows3Icon className="text-destructive" />
          </ToolbarToggle>
          <ToolbarToggle label="Delete column" onPress={() => run().deleteColumn().run()}>
            <Columns3Icon className="text-destructive" />
          </ToolbarToggle>
          <ToolbarToggle label="Delete table" onPress={() => run().deleteTable().run()}>
            <Trash2Icon className="text-destructive" />
          </ToolbarToggle>
        </>
      ) : null}
    </div>
  );
}

function toggleTaskAtClick(view: EditorView, event: MouseEvent): boolean {
  const item = event.target instanceof HTMLElement ? event.target.closest("li") : null;
  if (event.button !== 0 || !item?.hasAttribute("data-checked")) return false;
  // The checkbox is drawn in the item's start gutter, outside its text.
  const { left, right } = item.getBoundingClientRect();
  const rtl = getComputedStyle(item).direction === "rtl";
  if (rtl ? event.clientX <= right : event.clientX >= left) return false;
  const $position = view.state.doc.resolve(view.posAtDOM(item, 0));
  for (let depth = $position.depth; depth > 0; depth--) {
    const node = $position.node(depth);
    if (node.type.name !== "listItem") continue;
    event.preventDefault();
    view.dispatch(
      view.state.tr.setNodeAttribute(
        $position.before(depth),
        "checked",
        node.attrs.checked !== true,
      ),
    );
    return true;
  }
  return false;
}

const editorProps: EditorProps = {
  attributes: {
    class: "chat-markdown chat-markdown-document file-markdown-editor outline-none",
    "aria-label": "Markdown editor",
  },
  clipboardTextParser: (text, _context, _plain, view) =>
    Slice.maxOpen(parseMarkdown(view.state.schema, text).content),
  clipboardTextSerializer: (slice, view) => {
    const { schema } = view.state;
    const doc = schema.topNodeType.createAndFill(null, slice.content);
    return doc
      ? serializeMarkdown(schema, doc).trim()
      : slice.content.textBetween(0, slice.content.size, "\n\n");
  },
  handleDOMEvents: { mousedown: (view, event) => toggleTaskAtClick(view, event) },
};

function loadInto(editor: Editor, text: string): MarkdownDocument {
  const document = loadMarkdownDocument(editor.schema, text);
  // The parsed nodes go in as they are, since saving matches unchanged blocks by
  // identity, and outside history, since undoing the load would empty the file.
  editor.view.dispatch(
    editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, document.doc.content)
      .setMeta("addToHistory", false)
      .setMeta("preventUpdate", true),
  );
  return document;
}

export default function FileMarkdownEditor(props: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly text: string;
  /** Changes when `text` was written by something other than this editor. */
  readonly revision: number;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceMutationId: string | null;
  readonly onChange: (markdown: string) => void;
  /** The text could not be loaded for editing; the caller falls back to the read-only preview. */
  readonly onLoadError: () => void;
}) {
  const loadedRef = useRef<{ document: MarkdownDocument; revision: number } | null>(null);
  const load = (target: Editor) => {
    try {
      loadedRef.current = { document: loadInto(target, props.text), revision: props.revision };
    } catch {
      loadedRef.current = null;
      props.onLoadError();
    }
  };
  const editor = useEditor({
    extensions,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps,
    onCreate: ({ editor: created }) => load(created),
    onUpdate: ({ editor: updated }) => {
      const loaded = loadedRef.current;
      if (!loaded) return;
      props.onChange(saveMarkdownDocument(updated.schema, loaded.document, updated.state.doc));
    },
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads the ProseMirror document in place when the file changes outside the editor
  useEffect(() => {
    if (editor && loadedRef.current && loadedRef.current.revision !== props.revision) load(editor);
  });

  const renderContext: RenderContext = {
    cwd: props.cwd,
    imageBaseDir: markdownImageBaseDir(props.cwd, props.relativePath),
    threadRef: props.threadRef,
    workspaceMutationId: props.workspaceMutationId,
  };

  if (!editor) return null;
  return (
    <MarkdownRenderContext value={renderContext}>
      <Toolbar editor={editor} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </MarkdownRenderContext>
  );
}
