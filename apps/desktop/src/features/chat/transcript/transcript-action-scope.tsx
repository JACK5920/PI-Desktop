import { createContext, useContext } from "react";

/** Whether transcript history actions target the currently active session. */
export const TranscriptHistoryActionsContext = createContext(true);

export function useTranscriptHistoryActionsAllowed(): boolean {
  return useContext(TranscriptHistoryActionsContext);
}
