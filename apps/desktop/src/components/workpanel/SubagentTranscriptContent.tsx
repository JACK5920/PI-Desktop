import { Fragment } from "react";
import type { UiMessage } from "@pi-desktop/shared";
import type { SubagentRunItem } from "../../lib/assistant-turns";
import { reviewChangeFromMessage } from "../../lib/workspace-review";
import { AssistantErrorMessage, ThinkingRow } from "../../features/chat/transcript/shared";
import { ToolRow } from "../../features/chat/transcript/ToolRow";
import { ReviewChangeCard } from "../ReviewChangeCard";
import { Markdown } from "../Markdown";

export type SubagentTranscriptDisplayRow = SubagentRunItem | {
  kind: "image";
  message: UiMessage;
  source: string;
  alt: string;
};

export type SubagentTranscriptDisplayTurn = {
  task: string;
  rows: SubagentTranscriptDisplayRow[];
};

/** Shared PI/OMP subagent conversation presentation; engine adapters own the data and controls. */
export function SubagentTranscriptContent({
  turns,
  emptyLabel,
  isRunning = false,
  compactTasks = false,
}: {
  turns: readonly SubagentTranscriptDisplayTurn[];
  emptyLabel: string;
  isRunning?: boolean;
  compactTasks?: boolean;
}) {
  if (!turns.length) return <div className="subagent-transcript-empty" role="status">{emptyLabel}</div>;
  return <div className="subagent-transcript-list">
    {turns.map((turn, turnIndex) => <Fragment key={`turn-${turnIndex}`}>
      {turn.task ? <div className={`message-row user${compactTasks ? " omp-subagent-task-row" : ""}`}>
        <div className="message-col"><div className="message-bubble">
          {compactTasks
            ? <details className="omp-subagent-task-detail"><summary>{turn.task.replace(/[\t\r\n ]+/g, " ").trim().slice(0, 156)}{turn.task.trim().length > 156 ? "…" : ""}</summary><div className="message-user-text selectable">{turn.task}</div></details>
            : <div className="message-user-text selectable">{turn.task}</div>}
        </div></div>
      </div> : null}
      {turn.rows.map((row) => {
        if (row.kind === "tool") {
          return reviewChangeFromMessage(row.message)
            ? <ReviewChangeCard key={row.message.id} message={row.message} asToolRow />
            : <ToolRow key={row.message.id} message={row.message} />;
        }
        if (row.kind === "thinking") return <ThinkingRow key={`thinking-${row.message.id}`} message={row.message} streaming={isRunning && row.message.status === "streaming"} />;
        if (row.kind === "image") return <div className="message-row assistant" data-message-id={row.message.id} key={`image-${row.message.id}`}><div className="message-col"><div className="message-bubble"><img className="omp-native-agent-image" src={row.source} alt={row.alt} loading="lazy" /></div></div></div>;
        return <div className="message-row assistant" data-message-id={row.message.id} key={`answer-${row.message.id}`}>
          <div className="message-col"><div className="message-bubble">
            {row.message.content ? <div className="prose-chat selectable"><Markdown source={row.message.content} /></div> : null}
            {row.message.error ? <AssistantErrorMessage message={row.message} /> : null}
          </div></div>
        </div>;
      })}
    </Fragment>)}
  </div>;
}
