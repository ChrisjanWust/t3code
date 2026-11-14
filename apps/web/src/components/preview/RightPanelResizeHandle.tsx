import type { ComponentProps } from "react";
import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props extends Pick<
  ComponentProps<"div">,
  "tabIndex" | "onKeyDown" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax"
> {
  handlers: ResizableWidthHandlers;
  /** The panel edge the handle straddles. */
  edge?: "left" | "right";
  className?: string;
  label?: string;
}

export function RightPanelResizeHandle({
  handlers,
  edge = "left",
  className,
  label,
  ...separatorProps
}: Props) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      {...separatorProps}
      className={cn(
        // no-drag: the desktop title bar would otherwise turn the handle's top into a window drag.
        "group absolute inset-y-0 z-40 w-1 cursor-col-resize touch-none select-none [-webkit-app-region:no-drag] any-pointer-coarse:w-4",
        edge === "left"
          ? "left-0 any-pointer-coarse:-left-2"
          : "right-0 any-pointer-coarse:-right-2",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 w-px bg-transparent transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60",
          edge === "left"
            ? "left-0 -translate-x-1/2 any-pointer-coarse:left-2"
            : "right-0 translate-x-1/2 any-pointer-coarse:right-2",
        )}
      />
    </div>
  );
}
