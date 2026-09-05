import { createContext, useContext, type ReactNode } from "react";

import { usePile, type PileApi } from "@/lib/use-pile";

const PileContext = createContext<PileApi | null>(null);

export function PileProvider({ children }: { children: ReactNode }) {
  const pile = usePile();
  return <PileContext.Provider value={pile}>{children}</PileContext.Provider>;
}

export function useSharedPile(): PileApi {
  const ctx = useContext(PileContext);
  if (!ctx) throw new Error("useSharedPile must be used inside PileProvider");
  return ctx;
}
