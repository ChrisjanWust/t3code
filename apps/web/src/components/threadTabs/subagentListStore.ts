import { create } from "zustand";

type TabKeySet = Readonly<Record<string, true>>;

interface SubagentListState {
  /** Tabs whose subagent tree the user folded away. */
  readonly collapsed: TabKeySet;
  /** Tabs whose finished subagents the user unfolded. */
  readonly previousOpen: TabKeySet;
  readonly toggle: (list: "collapsed" | "previousOpen", tabKey: string) => void;
}

export const useSubagentListStore = create<SubagentListState>()((set) => ({
  collapsed: {},
  previousOpen: {},
  toggle: (list, tabKey) =>
    set((state) => {
      const { [tabKey]: wasSet, ...rest } = state[list];
      return { [list]: wasSet ? rest : { ...rest, [tabKey]: true } };
    }),
}));
