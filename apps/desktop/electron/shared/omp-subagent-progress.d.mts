export function ompSubagentsFromTaskFrame(frame: Record<string, any>): Array<Record<string, any> & {
  id: string;
  name: string;
  status: string;
  lastKnownStatus: string;
  observedActive: boolean;
  parentToolCallId: string;
  evidenceSource: "task_result";
}>;
