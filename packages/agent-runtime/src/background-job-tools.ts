/** Model job controls route to their existing owner; only Bash crosses Host RPC. */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TObject } from "typebox";
import { Type } from "typebox";
import {
  BACKGROUND_JOBS_VERSION,
  type BackgroundJobSnapshot,
  type BackgroundJobSummary,
  type JobReference,
} from "@pi-desktop/shared";
import type { RuntimeHost } from "./host-client.js";

const jobSchema = Type.Object({
  kind: Type.Union([Type.Literal("bash"), Type.Literal("delegation")]),
  id: Type.String({ minLength: 1 }),
}, { additionalProperties: false, description: "An explicit job returned by Bash, Task or TaskList. For a delegation, a delegationIds list selecting other delegates takes precedence over job.id; omit it, pass an empty list, or select only job.id to target that one delegate. For a Bash job, omit delegationIds or pass an empty list; mode may be all/any and minCompleted may be 1 when a strict model supplies selector defaults." });

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jobReference(params: unknown): JobReference | undefined {
  if (!record(params) || params.job === undefined) return undefined;
  const job = params.job;
  if (!record(job) || (job.kind !== "bash" && job.kind !== "delegation") ||
      typeof job.id !== "string" || !job.id.trim() || Object.keys(job).some(key => key !== "id" && key !== "kind")) {
    throw new Error("job must contain a kind (bash or delegation) and a nonempty id");
  }
  return { kind: job.kind, id: job.id };
}

function target(params: unknown): JobReference | undefined {
  const job = jobReference(params);
  if (!job || !record(params)) return undefined;
  if (job.kind === "delegation" && params.delegationIds !== undefined) {
    const delegationIds = params.delegationIds;
    if (!Array.isArray(delegationIds) || delegationIds.some(id => typeof id !== "string")) {
      throw new Error("delegationIds must be an array of delegation ids. To select multiple subagents, omit job and pass delegationIds.");
    }
    // The native multi-delegation selector is authoritative when a strict
    // model emits it beside a job reference for a different delegate.
    if (delegationIds.some(id => id !== job.id)) return undefined;
  }
  if (["delegationIds", "mode", "minCompleted"].some(key => params[key] !== undefined)) {
    if (job.kind === "delegation" && params.delegationIds !== undefined &&
        Array.isArray(params.delegationIds) && params.delegationIds.every(id => id === job.id)) {
      return job;
    }
    throw new Error("job cannot be combined with delegationIds, mode or minCompleted");
  }
  return job;
}

/** TaskWait's strict schemas may return both a job and its native selectors. */
function waitTarget(params: unknown): JobReference | undefined {
  const job = jobReference(params);
  if (!job || !record(params)) return undefined;
  const delegationIds = params.delegationIds;
  if (job.kind === "delegation") {
    if (delegationIds !== undefined) {
      if (!Array.isArray(delegationIds) || delegationIds.some(id => typeof id !== "string")) {
        throw new Error("delegationIds must be an array of delegation ids");
      }
      // The native multi-delegation wait owns its selector semantics. A job
      // reference emitted beside other ids must not block that valid request.
      if (delegationIds.some(id => id !== job.id)) return undefined;
    }
    return job;
  }

  if (delegationIds !== undefined && (!Array.isArray(delegationIds) || delegationIds.some(id => typeof id !== "string"))) {
    throw new Error("delegationIds must be an array of delegation ids");
  }
  if (Array.isArray(delegationIds) && delegationIds.length > 0) {
    throw new Error("A Bash job accepts only an empty delegationIds list. To select subagents, omit job and use delegationIds.");
  }
  if (params.mode !== undefined && params.mode !== "all" && params.mode !== "any") {
    throw new Error("A Bash job accepts only mode all or any. To select subagents, omit job and use delegationIds.");
  }
  if (params.minCompleted !== undefined && params.minCompleted !== 1) {
    throw new Error("A Bash job accepts only minCompleted 1. To select subagents, omit job and use delegationIds.");
  }
  return job;
}

/** Observe late rejections and release the listener on either completion path. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("Job wait aborted"), { errorCode: "TOOL_ABORTED" }));
    signal?.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    if (signal?.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

type Result = AgentToolResult<unknown>;
type Options = {
  host: RuntimeHost;
  sessionId: string;
  remote: boolean;
  defaultTimeoutSeconds: number;
  maxTimeoutSeconds: number;
  /** The runtime also interrupts this wait when new steering input arrives. */
  wait: (run: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal) => Promise<Result>;
};

function observation(snapshot: BackgroundJobSnapshot, status: string): Result {
  return {
    content: [{ type: "text", text: JSON.stringify({ status, ...snapshot }) }],
    details: { status, job: snapshot },
  };
}

export function buildJobTools(
  delegates: { wait: AgentTool; list: AgentTool; stop: AgentTool },
  options: Options,
): AgentTool[] {
  let capability: Promise<boolean> | undefined;
  const supported = () => capability ??= (async () => {
    if (options.remote) return false;
    try {
      const response = await options.host.call("backgroundJobs.capabilities", { sessionId: options.sessionId });
      return record(response) && response.version === BACKGROUND_JOBS_VERSION && response.supported === true;
    } catch (error) {
      if (record(error) && (error.code === -32601 || error.errorCode === "METHOD_NOT_FOUND" ||
          (record(error.rpc) && error.rpc.code === -32601))) return false;
      capability = undefined;
      throw error;
    }
  })();

  const requireSupported = async () => {
    if (!await supported()) throw new Error("This Host/workspace does not support background Bash job controls.");
  };
  const call = <T>(method: string, params: Record<string, unknown> = {}) =>
    options.host.call<T>(method, { ...params, sessionId: options.sessionId });

  const wait: AgentTool = {
    ...delegates.wait,
    description: `${delegates.wait.description}\nFor a background Bash command, pass its job reference ({kind: "bash", id: backgroundTaskId}). Returns state, exitCode and bounded stdout/stderr tails. Timeout or interrupted waiting leaves the process running. Bash completion is not automatically delivered; call TaskWait again when needed. Omit job to keep the existing subagent defaults.`,
    parameters: Type.Object({ ...(delegates.wait.parameters as TObject).properties, job: Type.Optional(jobSchema) }),
    execute: async (id, input, signal, update) => {
      const params = record(input) ? input : {};
      const job = waitTarget(params);
      if (!job) {
        // When the native delegation list selected other delegates, remove
        // only the adapter's `job` field and preserve TaskWait's own selectors.
        const { job: _job, ...delegationParams } = params;
        return delegates.wait.execute(id, delegationParams, signal, update);
      }
      if (job.kind === "delegation") {
        return delegates.wait.execute(id, {
          delegationIds: [job.id],
          ...(params.timeoutSeconds === undefined ? {} : { timeoutSeconds: params.timeoutSeconds }),
        }, signal, update);
      }
      const seconds = params.timeoutSeconds ?? options.defaultTimeoutSeconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1 || seconds > options.maxTimeoutSeconds) {
        throw new Error(`timeoutSeconds must be between 1 and ${options.maxTimeoutSeconds}`);
      }
      return options.wait(async waitSignal => {
        if (waitSignal.aborted) throw Object.assign(new Error("Job wait aborted"), { errorCode: "TOOL_ABORTED" });
        const budgetMs = Math.ceil(seconds * 1000);
        const deadline = performance.now() + budgetMs;
        const timerAbort = new AbortController();
        const signal = AbortSignal.any([waitSignal, timerAbort.signal]);
        const timer = setTimeout(() => timerAbort.abort(), budgetMs);
        let snapshot: BackgroundJobSnapshot | undefined;
        try {
          await abortable(requireSupported(), signal);
          while (!signal.aborted && performance.now() < deadline) {
            // Read once immediately so a deadline during a later long poll
            // can return the last observed state.
            const timeoutMs = snapshot ? Math.min(1000, Math.ceil(deadline - performance.now())) : 0;
            snapshot = await abortable(call<BackgroundJobSnapshot>("backgroundJobs.wait", {
              id: job.id, timeoutMs: Math.max(0, timeoutMs),
            }), signal);
            if (snapshot.state !== "running") return observation(snapshot, "completed");
          }
        } catch (error) {
          if (!timerAbort.signal.aborted || waitSignal.aborted ||
              !record(error) || error.errorCode !== "TOOL_ABORTED") throw error;
        } finally {
          clearTimeout(timer);
        }
        if (snapshot) return observation(snapshot, "timeout");
        const result = { status: "timeout", job, snapshotAvailable: false };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }, signal);
    },
  };
  const list: AgentTool = {
    ...delegates.list,
    description: `${delegates.list.description}\nAlso lists this session's retained background Bash jobs when supported. Use the returned job reference with TaskWait or TaskStop. Finished Bash history is bounded and expires when the Host restarts.`,
    execute: async (...args) => {
      const result = await delegates.list.execute(...args);
      const available = await supported();
      const tasks = available ? (await call<{ tasks: BackgroundJobSummary[] }>("backgroundJobs.list")).tasks : [];
      const details = record(result.details) ? result.details : {};
      return {
        ...result,
        content: [...result.content, { type: "text", text: available
          ? `Background Bash jobs: ${JSON.stringify(tasks)}`
          : "Background Bash job controls are unavailable on this Host/workspace." }],
        details: { ...details, backgroundJobs: { supported: available, tasks } },
      };
    },
  };
  const stop: AgentTool = {
    ...delegates.stop,
    description: `${delegates.stop.description}\nPass job to stop one explicit Bash or delegation job. Omitting job never stops Bash processes. A Bash stopRequested flag acknowledges a request; only the returned terminal state confirms the outcome.`,
    parameters: Type.Object({ ...(delegates.stop.parameters as TObject).properties, job: Type.Optional(jobSchema) }),
    execute: async (id, input, signal, update) => {
      const params = record(input) ? input : {};
      const job = target(params);
      if (!job) {
        const { job: _job, ...delegationParams } = params;
        return delegates.stop.execute(id, delegationParams, signal, update);
      }
      if (job.kind === "delegation") {
        return delegates.stop.execute(id, { delegationIds: [job.id] }, signal, update);
      }
      await requireSupported();
      if (signal?.aborted) throw Object.assign(new Error("Job stop aborted before dispatch"), { errorCode: "TOOL_ABORTED" });
      const snapshot = await call<BackgroundJobSnapshot>("backgroundJobs.stop", { id: job.id, timeoutMs: 1000 });
      return observation(snapshot, snapshot.state === "running" ? "stopPending" : "completed");
    },
  };
  return [wait, list, stop];
}
