import { T, useGT, useMessages } from "gt-react";
import { ClockIcon } from "lucide-react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import {
  SIDEBAR_RECENCY_LABELS,
  SIDEBAR_RECENCY_WINDOWS,
  type SidebarRecencyWindow,
} from "./sidebarRecency.logic";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const ANY_TIME = "any";

export function SidebarRecencyFilter({
  value,
  onChange,
}: {
  value: SidebarRecencyWindow | null;
  onChange: (value: SidebarRecencyWindow | null) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              value === null
                ? gt("Filter threads by recent activity")
                : gt("Showing threads active in the last {duration}", {
                    duration: messages(SIDEBAR_RECENCY_LABELS[value]),
                  })
            }
          />
        }
      >
        {value === null ? (
          <ClockIcon className="size-4" />
        ) : (
          <span className="text-xs text-sidebar-foreground tabular-nums">{value}</span>
        )}
      </MenuTrigger>
      <MenuPopup align="start" collisionAvoidance={{ side: "flip", align: "shift" }}>
        <MenuGroup>
          <MenuGroupLabel>
            <T>Active in the last</T>
          </MenuGroupLabel>
          <MenuRadioGroup
            value={value ?? ANY_TIME}
            onValueChange={(next: SidebarRecencyWindow | typeof ANY_TIME) =>
              onChange(next === ANY_TIME ? null : next)
            }
          >
            {SIDEBAR_RECENCY_WINDOWS.map((window) => (
              <MenuRadioItem key={window} value={window} closeOnClick>
                {messages(SIDEBAR_RECENCY_LABELS[window])}
              </MenuRadioItem>
            ))}
            <MenuRadioItem value={ANY_TIME} closeOnClick>
              <T>Any time</T>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
