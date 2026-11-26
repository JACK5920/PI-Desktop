import { IconBot, IconCheck, IconCircleAlert, IconClock, IconPause, IconStop } from "../../../components/icons";

export type SubagentNodeStatus = "running" | "waiting" | "retrying" | "completed" | "aborted" | "timed_out" | "failed" | "stopped" | "denied" | "unknown";

/** Shared visual card for both PI delegates and OMP-native subagents. */
export function SubagentNodeCard({
  title,
  titleDetail,
  model,
  thinking,
  summary,
  summaryDetail,
  activity,
  steps,
  status,
  statusLabel,
  duration,
  expanded,
  controlsId,
  disabled,
  onClick,
}: {
  title: string;
  titleDetail?: string;
  model?: string;
  thinking?: string;
  summary?: string;
  summaryDetail?: string;
  activity?: string;
  steps?: string;
  status?: SubagentNodeStatus;
  statusLabel?: string;
  duration?: string;
  expanded?: boolean;
  controlsId?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const outcome = status ?? "unknown";
  const detail = [title, titleDetail, model, thinking, statusLabel, summaryDetail ?? summary, activity].filter(Boolean).join(" · ");
  return <button
    type="button"
    className={`subagent-topology-node-header outcome-${outcome}`}
    aria-expanded={expanded}
    aria-controls={expanded ? controlsId : undefined}
    disabled={disabled}
    title={detail}
    onClick={onClick}
  >
    <span className="subagent-topology-avatar" aria-hidden>
      <IconBot size={15} />
      <span className="subagent-topology-status-icon">
        {outcome === "completed" ? <IconCheck size={8} /> : outcome === "aborted" || outcome === "stopped" ? <IconStop size={7} /> : outcome === "waiting" ? <IconPause size={7} /> : outcome === "retrying" ? <IconClock size={8} /> : outcome === "running" ? <span /> : outcome === "unknown" ? <span className="subagent-topology-status-unknown" /> : <IconCircleAlert size={8} />}
      </span>
    </span>
    <span className="subagent-topology-node-copy">
      <span className="subagent-topology-node-title-row">
        <span className="subagent-topology-node-title">{title}</span>
        {titleDetail ? <span className="subagent-topology-node-model" title={titleDetail}>{titleDetail}</span> : null}
        {model || thinking ? <span className="subagent-topology-node-model" title={[model, thinking].filter(Boolean).join(" ")}><span className="subagent-topology-node-model-name">{model}</span>{thinking ? <span className="subagent-topology-node-thinking"> {thinking}</span> : null}</span> : null}
        <span className="subagent-topology-node-status">{statusLabel}{duration ? ` · ${duration}` : ""}</span>
      </span>
      {summary ? <span className="subagent-topology-node-summary" title={summary}>{summary}</span> : null}
      {activity ? <span className="subagent-topology-node-activity" title={activity}>{activity}</span> : null}
      {steps ? <span className="subagent-topology-node-steps">{steps}</span> : null}
    </span>
    {outcome === "running" ? <span className="tool-spinner" aria-label={statusLabel} /> : null}
  </button>;
}
