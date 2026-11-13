import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

interface ThreadTabOrderState {
  /** Thread ids by worktree key, in the order the user's last drag or fork left them. */
  readonly orderByWorktreeKey: Readonly<Record<string, readonly string[]>>;
  readonly setOrder: (worktreeKey: string, order: readonly string[]) => void;
}

export const useThreadTabOrderStore = create<ThreadTabOrderState>()(
  persist(
    (set) => ({
      orderByWorktreeKey: {},
      setOrder: (worktreeKey, order) =>
        set((state) => ({
          orderByWorktreeKey: { ...state.orderByWorktreeKey, [worktreeKey]: order },
        })),
    }),
    {
      name: "t3code:thread-tab-order:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ orderByWorktreeKey }) => ({ orderByWorktreeKey }),
    },
  ),
);
