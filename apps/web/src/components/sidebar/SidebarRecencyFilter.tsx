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
  return (
    <Menu>
      <MenuTrigger
        render={
          <SidebarHeaderIconButton
            label={
              value === null
                ? "Filter threads by recent activity"
                : `Showing threads active in the last ${SIDEBAR_RECENCY_LABELS[value]}`
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
          <MenuGroupLabel>Active in the last</MenuGroupLabel>
          <MenuRadioGroup
            value={value ?? ANY_TIME}
            onValueChange={(next: SidebarRecencyWindow | typeof ANY_TIME) =>
              onChange(next === ANY_TIME ? null : next)
            }
          >
            {SIDEBAR_RECENCY_WINDOWS.map((window) => (
              <MenuRadioItem key={window} value={window} closeOnClick>
                {SIDEBAR_RECENCY_LABELS[window]}
              </MenuRadioItem>
            ))}
            <MenuRadioItem value={ANY_TIME} closeOnClick>
              Any time
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
