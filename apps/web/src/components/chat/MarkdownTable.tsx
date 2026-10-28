import { Check, Copy, Maximize2, Minimize2 } from "lucide";
import { useRef, useState, type ComponentProps } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { getClientSettings } from "../../hooks/useSettings";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import {
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../../markdown-clipboard";
import { MorphIcon } from "../MorphIcon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMarkdownActionFailure } from "./markdownActionFailure";

/**
 * Whether the wrap toggle changes anything: a cell is clipped in the unwrapped
 * layout, or wrapping narrows a table too wide for its scroller. Short tables
 * hide it. Measures with the container briefly toggled and restores it before
 * the browser paints.
 */
function wrapChangesTable(container: HTMLElement, table: HTMLTableElement): boolean {
  const viewport = table.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const scrollLeft = viewport?.scrollLeft ?? 0;
  const previous = container.dataset.expanded;
  container.dataset.expanded = "false";
  try {
    for (const row of table.rows) {
      for (const cell of row.cells) {
        if (cell.scrollWidth > cell.clientWidth) return true;
      }
    }
    const unwrappedWidth = table.offsetWidth;
    container.dataset.expanded = "true";
    return table.offsetWidth < unwrappedWidth;
  } finally {
    if (previous === undefined) delete container.dataset.expanded;
    else container.dataset.expanded = previous;
    // Either layout can be narrower and clamp a sideways scroll, which is negative in RTL.
    if (viewport && scrollLeft !== 0) viewport.scrollLeft = scrollLeft;
  }
}

export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(() => getClientSettings().wordWrap);
  const [canToggleWrap, setCanToggleWrap] = useState(false);
  const { copyToClipboard, isCopied: copied } = useCopyToClipboard<"markdown" | "csv">({
    timeout: 1200,
    onError: (cause, format) =>
      reportMarkdownActionFailure({ operation: "copy-table", format }, cause),
  });
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  // React calls this with null when a previous attach returned no cleanup.
  const attachContainer = (container: HTMLDivElement | null) => {
    containerRef.current = container;
    const table = container?.querySelector("table");
    if (!container || !table) return;
    const measure = () => setCanToggleWrap(wrapChangesTable(container, table));
    measure();
    // A streamed cell can grow until it clips while the table keeps its size, and a
    // narrower column can clip a cell without this component rendering.
    const mutations = new MutationObserver(measure);
    mutations.observe(table, { childList: true, characterData: true, subtree: true });
    const stopResize = observeResize(table, measure);
    return () => {
      mutations.disconnect();
      stopResize();
      containerRef.current = null;
    };
  };

  const handleCopy = (format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table) return;
    copyToClipboard(
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table),
      format,
    );
  };

  return (
    <div
      ref={attachContainer}
      // An RTL table hugs the right edge. dir on the row would also flip the scroller, whose
      // Base UI scroll fades assume LTR.
      className={cn(
        "chat-markdown-table-container flex",
        props.dir === "rtl" && "flex-row-reverse",
      )}
      data-expanded={expanded ? "true" : "false"}
    >
      <div className="min-w-0">
        <ScrollArea radius="none" chainVerticalScroll scrollFade className="w-full max-w-full">
          <table {...props}>{children}</table>
        </ScrollArea>
        <div className="mt-0.5 -mx-1 flex items-center justify-between select-none">
          {canToggleWrap ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant={expanded ? "secondary" : "ghost-muted"}
                    size="icon-xs"
                    aria-pressed={expanded}
                    onClick={() => setExpanded((value) => !value)}
                    aria-label={expandLabel}
                  />
                }
              >
                <MorphIcon className="size-3" icon={expanded ? Minimize2 : Maximize2} />
              </TooltipTrigger>
              <TooltipPopup side="top">{expandLabel}</TooltipPopup>
            </Tooltip>
          ) : (
            <span />
          )}
          <Menu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost-muted"
                        size="icon-xs"
                        aria-label={copyLabel}
                      />
                    }
                  />
                }
              >
                <MorphIcon className="size-3" icon={copied ? Check : Copy} />
              </TooltipTrigger>
              <TooltipPopup side="top">{copyLabel}</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
              <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </div>
  );
}
