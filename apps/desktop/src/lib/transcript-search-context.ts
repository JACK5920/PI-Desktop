import { createContext } from "react";
import type { TranscriptSearchTarget } from "./transcript-reading";

export const TranscriptSearchContext = createContext<TranscriptSearchTarget | null>(null);

export type TranscriptSourceTarget = Omit<TranscriptSearchTarget, "requestId">;
export const TranscriptSourceNavigationContext = createContext<
  ((target: TranscriptSourceTarget) => void) | null
>(null);
