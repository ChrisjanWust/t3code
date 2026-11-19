import { create } from "zustand";

type TabKeySet = Readonly<Record<string, true>>;

interface SubagentListState {
  /** Tabs whose subagent tree the user folded away. */
  readonly collapsed: TabKeySet;
  /** Tabs whose subagents the user expanded past the newest few. */
  readonly expanded: TabKeySet;
  readonly toggle: (list: "collapsed" | "expanded", tabKey: string) => void;
}

export const useSubagentListStore = create<SubagentListState>()((set) => ({
  collapsed: {},
  expanded: {},
  toggle: (list, tabKey) =>
    set((state) => {
      const { [tabKey]: wasSet, ...rest } = state[list];
      return { [list]: wasSet ? rest : { ...rest, [tabKey]: true } };
    }),
}));
