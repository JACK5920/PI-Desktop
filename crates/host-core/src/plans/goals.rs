use super::*;
use crate::plans::execution::execution_from_proposal;
use rusqlite::{types::Type, OptionalExtension, Transaction};
use serde_json::Value;

pub const GOAL_DEFAULT_ROUNDS_PER_CYCLE: i64 = 8;
pub const GOAL_MAX_ROUNDS_PER_CYCLE: i64 = 32;
pub const GOAL_DEFAULT_TOKENS_PER_CYCLE: i64 = 250_000;
pub const GOAL_DEFAULT_DURATION_MS_PER_CYCLE: i64 = 60 * 60 * 1_000;
pub const GOAL_MIN_DURATION_MS_PER_CYCLE: i64 = 60 * 1_000;
pub const GOAL_MAX_DURATION_MS_PER_CYCLE: i64 = 24 * 60 * 60 * 1_000;
const GOAL_MAX_SAFE_TOKEN_BUDGET: i64 = 9_007_199_254_740_991;

pub(crate) fn default_goal_budget_defaults() -> Value {
    json!({
        "maxRounds": GOAL_DEFAULT_ROUNDS_PER_CYCLE,
        "maxTokens": GOAL_DEFAULT_TOKENS_PER_CYCLE,
        "maxDurationMs": GOAL_DEFAULT_DURATION_MS_PER_CYCLE,
        "tokenBudgetUnlimited": true
    })
}

pub(crate) fn is_valid_goal_budget_defaults(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let max_rounds = object.get("maxRounds").and_then(Value::as_i64);
    let max_tokens = object.get("maxTokens").and_then(Value::as_i64);
    let max_duration_ms = object.get("maxDurationMs").and_then(Value::as_i64);
    let token_budget_unlimited = object.get("tokenBudgetUnlimited").and_then(Value::as_bool);

    max_rounds.is_some_and(|value| (1..=GOAL_MAX_ROUNDS_PER_CYCLE).contains(&value))
        && max_tokens.is_some_and(|value| (1..=GOAL_MAX_SAFE_TOKEN_BUDGET).contains(&value))
        && max_duration_ms.is_some_and(|value| {
            (GOAL_MIN_DURATION_MS_PER_CYCLE..=GOAL_MAX_DURATION_MS_PER_CYCLE).contains(&value)
        })
        && token_budget_unlimited.is_some()
}

pub(crate) fn normalize_goal_budget_defaults(value: Option<&Value>) -> Value {
    value
        .filter(|value| is_valid_goal_budget_defaults(value))
        .cloned()
        .unwrap_or_else(default_goal_budget_defaults)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalBudget {
    pub max_rounds: i64,
    /// The last finite token budget; retained while token limiting is disabled.
    pub max_tokens: i64,
    pub max_duration_ms: i64,
    pub token_budget_unlimited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalCriterionReport {
    pub criterion: String,
    pub status: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalProgressReport {
    pub outcome: String,
    pub summary: String,
    pub criteria: Vec<GoalCriterionReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GoalLifecycle {
    pub proposal_id: String,
    pub session_id: String,
    pub title: String,
    pub status: String,
    pub current_execution_id: Option<String>,
    pub cycle: i64,
    pub cycle_started_at: i64,
    pub round_in_cycle: i64,
    pub run_count: i64,
    pub max_rounds: i64,
    pub max_tokens: i64,
    pub max_duration_ms: i64,
    pub token_budget_unlimited: bool,
    pub tokens_used: i64,
    pub elapsed_ms: i64,
    pub stop_reason: Option<String>,
    pub latest_report: Option<GoalProgressReport>,
    pub updated_at: String,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalControlResult {
    pub goal: GoalLifecycle,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<PlanExecution>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalBudgetUpdateResult {
    pub goal: GoalLifecycle,
}

fn report_from_json(
    raw: Option<String>,
    column: usize,
) -> rusqlite::Result<Option<GoalProgressReport>> {
    raw.map(|value| {
        serde_json::from_str(&value).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
        })
    })
    .transpose()
}

fn goal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GoalLifecycle> {
    let updated_at: i64 = row.get(10)?;
    Ok(GoalLifecycle {
        proposal_id: row.get(0)?,
        session_id: row.get(1)?,
        title: row.get(12)?,
        status: row.get(2)?,
        current_execution_id: row.get(3)?,
        cycle: row.get(4)?,
        cycle_started_at: row.get(18)?,
        round_in_cycle: row.get(5)?,
        run_count: row.get(6)?,
        max_rounds: row.get(7)?,
        max_tokens: row.get(13)?,
        max_duration_ms: row.get(14)?,
        tokens_used: row.get(15)?,
        elapsed_ms: row.get(16)?,
        token_budget_unlimited: row.get(17)?,
        stop_reason: row.get(8)?,
        latest_report: report_from_json(row.get(9)?, 9)?,
        updated_at: ms_to_ts(updated_at),
        version: row.get(11)?,
    })
}

const GOAL_COLUMNS: &str = "proposal_id, session_id, status, current_execution_id,
    cycle, round_in_cycle, run_count, max_rounds, stop_reason,
    latest_report_json, updated_at, version,
    (SELECT title FROM plan_approvals WHERE request_id = goal_lifecycles.proposal_id),
    max_tokens, max_duration_ms, tokens_used, elapsed_ms,
    token_budget_unlimited, cycle_started_at";

pub(crate) fn current_for_session(
    db: &Database,
    session_id: &str,
) -> Result<Option<GoalLifecycle>> {
    let sql = format!(
        "SELECT {GOAL_COLUMNS} FROM goal_lifecycles
         WHERE session_id = ?1 AND status <> 'cleared'
         ORDER BY updated_at DESC, rowid DESC LIMIT 1"
    );
    Ok(db
        .conn()
        .prepare_cached(&sql)?
        .query_row(params![session_id], goal_from_row)
        .optional()?)
}

pub(crate) fn current_goals(db: &Database) -> Result<Vec<GoalLifecycle>> {
    let sql = format!(
        "SELECT {GOAL_COLUMNS} FROM goal_lifecycles
         WHERE status <> 'cleared' AND rowid = (
           SELECT candidate.rowid FROM goal_lifecycles candidate
           WHERE candidate.session_id = goal_lifecycles.session_id
             AND candidate.status <> 'cleared'
           ORDER BY candidate.updated_at DESC, candidate.rowid DESC LIMIT 1
         ) ORDER BY updated_at DESC"
    );
    let mut statement = db.conn().prepare_cached(&sql)?;
    let rows = statement.query_map([], goal_from_row)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(crate) fn has_open_goal_tx(tx: &Transaction<'_>, session_id: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM goal_lifecycles
           WHERE session_id = ?1 AND status IN ('active', 'paused', 'blocked', 'interrupted')
         )",
        params![session_id],
        |row| row.get(0),
    )?)
}

pub(crate) fn has_open_goal(db: &Database, session_id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(
           SELECT 1 FROM goal_lifecycles
           WHERE session_id = ?1 AND status IN ('active', 'paused', 'blocked', 'interrupted')
         )",
        params![session_id],
        |row| row.get(0),
    )?)
}

pub(crate) fn create_goal_tx(
    tx: &Transaction<'_>,
    proposal_id: &str,
    session_id: &str,
    execution_id: &str,
    now: i64,
) -> Result<()> {
    if has_open_goal_tx(tx, session_id)? {
        return Err(plan_error("GOAL_ALREADY_ACTIVE"));
    }
    let settings_json: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE ns = 'app' AND key = 'app'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let settings = settings_json
        .map(|raw| serde_json::from_str::<Value>(&raw))
        .transpose()?;
    let budget_value = normalize_goal_budget_defaults(
        settings
            .as_ref()
            .and_then(|settings| settings.get("goalBudgetDefaults")),
    );
    let budget: GoalBudget = serde_json::from_value(budget_value)?;
    tx.execute(
        "INSERT INTO goal_lifecycles (
           proposal_id, session_id, status, current_execution_id, cycle,
           round_in_cycle, run_count, max_rounds, max_tokens, max_duration_ms,
           token_budget_unlimited, tokens_used, elapsed_ms, cycle_started_at,
           created_at, updated_at
         ) VALUES (?1, ?2, 'active', ?3, 1, 1, 1, ?4, ?5, ?6, ?7, 0, 0, ?8, ?8, ?8)",
        params![
            proposal_id,
            session_id,
            execution_id,
            budget.max_rounds,
            budget.max_tokens,
            budget.max_duration_ms,
            budget.token_budget_unlimited,
            now
        ],
    )?;
    tx.execute(
        "INSERT INTO goal_runs (
           execution_id, proposal_id, cycle, round_in_cycle, run_count,
           status, created_at, updated_at
         ) VALUES (?1, ?2, 1, 1, 1, 'queued', ?3, ?3)",
        params![execution_id, proposal_id, now],
    )?;
    Ok(())
}

pub(crate) fn claim_run_tx(tx: &Transaction<'_>, execution_id: &str, now: i64) -> Result<()> {
    let changed = tx.execute(
        "UPDATE goal_runs SET status = 'running', updated_at = ?1
         WHERE execution_id = ?2 AND status = 'queued'
           AND EXISTS (
             SELECT 1 FROM goal_lifecycles lifecycle
             WHERE lifecycle.proposal_id = goal_runs.proposal_id
               AND lifecycle.current_execution_id = goal_runs.execution_id
               AND lifecycle.status = 'active'
           )",
        params![now, execution_id],
    )?;
    if changed != 1 {
        return Err(plan_error("GOAL_EXECUTION_STALE"));
    }
    Ok(())
}

fn validate_report(report: &GoalProgressReport) -> Result<()> {
    if !matches!(report.outcome.as_str(), "continue" | "complete" | "blocked")
        || report.summary.trim().is_empty()
        || report.summary.len() > 4_000
        || report.criteria.is_empty()
        || report.criteria.len() > 50
    {
        return Err(plan_error("GOAL_REPORT_INVALID"));
    }
    let mut all_met = true;
    for criterion in &report.criteria {
        if criterion.criterion.trim().is_empty()
            || criterion.criterion.len() > 1_000
            || !matches!(criterion.status.as_str(), "met" | "unmet")
            || criterion.evidence.len() > 10
            || criterion.evidence.is_empty()
            || criterion
                .evidence
                .iter()
                .any(|evidence| evidence.trim().is_empty() || evidence.len() > 2_000)
        {
            return Err(plan_error("GOAL_REPORT_INVALID"));
        }
        all_met &= criterion.status == "met";
    }
    if (report.outcome == "complete") != all_met {
        return Err(plan_error("GOAL_REPORT_CRITERIA_MISMATCH"));
    }
    Ok(())
}

fn cycle_tokens_used_tx(tx: &Transaction<'_>, proposal_id: &str, cycle: i64) -> Result<i64> {
    let mut statement = tx.prepare_cached(
        "SELECT turns.usage_json
         FROM goal_runs
         JOIN turns ON turns.id = goal_runs.report_turn_id
         WHERE goal_runs.proposal_id = ?1 AND goal_runs.cycle = ?2",
    )?;
    let rows = statement.query_map(params![proposal_id, cycle], |row| {
        row.get::<_, Option<String>>(0)
    })?;
    let mut total = 0_i64;
    for raw in rows {
        let Some(raw) = raw? else { continue };
        let usage: serde_json::Value = serde_json::from_str(&raw)?;
        total = total.saturating_add(
            usage
                .get("totalTokens")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
                .max(0),
        );
    }
    Ok(total)
}

fn budget_snapshot_tx(
    tx: &Transaction<'_>,
    proposal_id: &str,
    cycle: i64,
    cycle_started_at: i64,
    now: i64,
) -> Result<(i64, i64)> {
    Ok((
        cycle_tokens_used_tx(tx, proposal_id, cycle)?,
        now.saturating_sub(cycle_started_at).max(0),
    ))
}

pub(crate) fn record_report(
    db: &Database,
    session_id: &str,
    proposal_id: &str,
    execution_id: &str,
    turn_id: &str,
    report: &GoalProgressReport,
) -> Result<GoalLifecycle> {
    validate_report(report)?;
    let raw_report = serde_json::to_string(report)?;
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE goal_runs
         SET report_json = ?1, report_turn_id = ?2, updated_at = ?3
         WHERE execution_id = ?4 AND proposal_id = ?5 AND status = 'running'
           AND report_json IS NULL
           AND EXISTS (
             SELECT 1 FROM goal_lifecycles lifecycle
             WHERE lifecycle.proposal_id = goal_runs.proposal_id
               AND lifecycle.session_id = ?6
               AND lifecycle.current_execution_id = goal_runs.execution_id
               AND lifecycle.status = 'active'
           )
           AND EXISTS (
             SELECT 1 FROM turns
             WHERE turns.id = ?7 AND turns.session_id = ?6 AND turns.status = 'running'
           )",
        params![
            raw_report,
            turn_id,
            now,
            execution_id,
            proposal_id,
            session_id,
            turn_id
        ],
    )?;
    if changed != 1 {
        return Err(plan_error("GOAL_REPORT_STALE"));
    }
    let (cycle, cycle_started_at): (i64, i64) = tx.query_row(
        "SELECT cycle, cycle_started_at FROM goal_lifecycles
         WHERE proposal_id = ?1 AND session_id = ?2 AND current_execution_id = ?3
           AND status = 'active'",
        params![proposal_id, session_id, execution_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (tokens_used, elapsed_ms) =
        budget_snapshot_tx(&tx, proposal_id, cycle, cycle_started_at, now)?;
    tx.execute(
        "UPDATE goal_lifecycles
         SET latest_report_json = ?1, tokens_used = ?2, elapsed_ms = ?3,
             updated_at = ?4, version = version + 1
         WHERE proposal_id = ?5 AND session_id = ?6 AND status = 'active'
           AND current_execution_id = ?7",
        params![
            raw_report,
            tokens_used,
            elapsed_ms,
            now,
            proposal_id,
            session_id,
            execution_id
        ],
    )?;
    audit::append_tx(
        &tx,
        "goal_progress_reported",
        Some(session_id),
        json!({
            "proposalId": proposal_id,
            "executionId": execution_id,
            "turnId": turn_id,
            "outcome": report.outcome,
            "criteriaCount": report.criteria.len(),
            "metCount": report.criteria.iter().filter(|item| item.status == "met").count(),
        }),
    )?;
    tx.commit()?;
    current_for_session(db, session_id)?.ok_or_else(|| plan_error("GOAL_NOT_FOUND"))
}

pub(crate) fn finish_run_tx(
    tx: &Transaction<'_>,
    proposal: &PlanProposal,
    execution_id: &str,
    status: &str,
    error_code: Option<&str>,
    now: i64,
) -> Result<Option<PlanExecution>> {
    let run = tx
        .query_row(
            "SELECT report_json FROM goal_runs
             WHERE execution_id = ?1 AND proposal_id = ?2",
            params![execution_id, proposal.id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?;
    let Some(report_json) = run else {
        return Ok(None);
    };
    let current = tx.query_row(
        "SELECT status, current_execution_id, cycle, round_in_cycle, run_count,
                max_rounds, session_id, max_tokens, max_duration_ms, cycle_started_at,
                token_budget_unlimited
         FROM goal_lifecycles WHERE proposal_id = ?1",
        params![proposal.id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, bool>(10)?,
            ))
        },
    )?;
    if current.1.as_deref() != Some(execution_id) {
        return Err(plan_error("GOAL_EXECUTION_STALE"));
    }
    if status == EXECUTION_INTERRUPTED {
        tx.execute(
            "UPDATE goal_runs SET status = 'interrupted', updated_at = ?1
             WHERE execution_id = ?2 AND status IN ('queued', 'running')",
            params![now, execution_id],
        )?;
        if current.0 == "active" {
            let (_, elapsed_ms) = budget_snapshot_tx(tx, &proposal.id, current.2, current.9, now)?;
            tx.execute(
                "UPDATE goal_lifecycles
                 SET status = 'interrupted', stop_reason = ?1, elapsed_ms = ?2, updated_at = ?3,
                     version = version + 1
                 WHERE proposal_id = ?4 AND current_execution_id = ?5 AND status = 'active'",
                params![
                    error_code.unwrap_or("PLAN_EXECUTION_INTERRUPTED"),
                    elapsed_ms,
                    now,
                    proposal.id,
                    execution_id
                ],
            )?;
        }
        return Ok(None);
    }

    tx.execute(
        "UPDATE goal_runs SET status = 'completed', updated_at = ?1
         WHERE execution_id = ?2 AND status IN ('queued', 'running')",
        params![now, execution_id],
    )?;
    if current.0 != "active" {
        return Ok(None);
    }
    let (tokens_used, elapsed_ms) =
        budget_snapshot_tx(tx, &proposal.id, current.2, current.9, now)?;
    tx.execute(
        "UPDATE goal_lifecycles SET tokens_used = ?1, elapsed_ms = ?2
         WHERE proposal_id = ?3 AND current_execution_id = ?4 AND status = 'active'",
        params![tokens_used, elapsed_ms, proposal.id, execution_id],
    )?;
    let report = report_json
        .as_deref()
        .map(serde_json::from_str::<GoalProgressReport>)
        .transpose()?;
    let Some(report) = report else {
        tx.execute(
            "UPDATE goal_lifecycles
             SET status = 'blocked', stop_reason = 'GOAL_REPORT_REQUIRED',
                 updated_at = ?1, version = version + 1
             WHERE proposal_id = ?2 AND current_execution_id = ?3 AND status = 'active'",
            params![now, proposal.id, execution_id],
        )?;
        return Ok(None);
    };
    match report.outcome.as_str() {
        "complete" => {
            tx.execute(
                "UPDATE goal_lifecycles
                 SET status = 'completed', current_execution_id = NULL,
                     stop_reason = NULL, updated_at = ?1, version = version + 1
                 WHERE proposal_id = ?2 AND current_execution_id = ?3 AND status = 'active'",
                params![now, proposal.id, execution_id],
            )?;
            Ok(None)
        }
        "blocked" => {
            tx.execute(
                "UPDATE goal_lifecycles
                 SET status = 'blocked', stop_reason = ?1, updated_at = ?2,
                     version = version + 1
                 WHERE proposal_id = ?3 AND current_execution_id = ?4 AND status = 'active'",
                params![report.summary, now, proposal.id, execution_id],
            )?;
            Ok(None)
        }
        "continue" if (!current.10 && tokens_used >= current.7) || elapsed_ms >= current.8 => {
            tx.execute(
                "UPDATE goal_lifecycles
                 SET status = 'paused', stop_reason = 'GOAL_BUDGET_EXHAUSTED',
                     updated_at = ?1, version = version + 1
                 WHERE proposal_id = ?2 AND current_execution_id = ?3 AND status = 'active'",
                params![now, proposal.id, execution_id],
            )?;
            Ok(None)
        }
        "continue" if current.3 >= current.5 => {
            tx.execute(
                "UPDATE goal_lifecycles
                 SET status = 'paused', stop_reason = 'GOAL_AUTO_ROUND_LIMIT',
                     updated_at = ?1, version = version + 1
                 WHERE proposal_id = ?2 AND current_execution_id = ?3 AND status = 'active'",
                params![now, proposal.id, execution_id],
            )?;
            Ok(None)
        }
        "continue" => {
            let next_round = current.3 + 1;
            let next_run_count = current.4 + 1;
            let next_execution_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO goal_runs (
                   execution_id, proposal_id, cycle, round_in_cycle, run_count,
                   status, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, 'queued', ?6, ?6)",
                params![
                    next_execution_id,
                    proposal.id,
                    current.2,
                    next_round,
                    next_run_count,
                    now
                ],
            )?;
            tx.execute(
                "UPDATE goal_lifecycles
                 SET current_execution_id = ?1, round_in_cycle = ?2,
                     run_count = ?3, stop_reason = NULL, updated_at = ?4,
                     version = version + 1
                 WHERE proposal_id = ?5 AND current_execution_id = ?6 AND status = 'active'",
                params![
                    next_execution_id,
                    next_round,
                    next_run_count,
                    now,
                    proposal.id,
                    execution_id
                ],
            )?;
            tx.execute(
                "UPDATE plan_approvals
                 SET execution_id = ?1, execution_state = 'queued', error_code = NULL,
                     updated_at = ?2, version = version + 1
                 WHERE request_id = ?3 AND execution_id = ?4 AND kind = 'goal'
                   AND execution_state = 'completed'",
                params![next_execution_id, now, proposal.id, execution_id],
            )?;
            let updated = get_proposal_tx(tx, &proposal.id)?;
            updated
                .as_ref()
                .map(execution_from_proposal)
                .transpose()
                .map(Option::flatten)
        }
        _ => Err(plan_error("GOAL_REPORT_INVALID")),
    }
}

fn validate_budget(budget: GoalBudget) -> Result<()> {
    if !(1..=GOAL_MAX_ROUNDS_PER_CYCLE).contains(&budget.max_rounds)
        || !(1..=GOAL_MAX_SAFE_TOKEN_BUDGET).contains(&budget.max_tokens)
        || !(GOAL_MIN_DURATION_MS_PER_CYCLE..=GOAL_MAX_DURATION_MS_PER_CYCLE)
            .contains(&budget.max_duration_ms)
    {
        return Err(plan_error("GOAL_BUDGET_INVALID"));
    }
    Ok(())
}

pub(crate) fn update_budget(
    db: &Database,
    session_id: &str,
    proposal_id: &str,
    budget: GoalBudget,
) -> Result<GoalBudgetUpdateResult> {
    validate_budget(budget)?;
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    let status: Option<String> = tx
        .query_row(
            "SELECT status FROM goal_lifecycles
             WHERE session_id = ?1 AND proposal_id = ?2",
            params![session_id, proposal_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(status) = status else {
        return Err(plan_error("GOAL_NOT_FOUND"));
    };
    if !matches!(
        status.as_str(),
        "active" | "paused" | "blocked" | "interrupted"
    ) {
        return Err(plan_error("GOAL_STATE_CONFLICT"));
    }
    let changed = tx.execute(
        "UPDATE goal_lifecycles
         SET max_rounds = ?1, max_tokens = ?2, max_duration_ms = ?3,
             token_budget_unlimited = ?4, updated_at = ?5, version = version + 1
         WHERE session_id = ?6 AND proposal_id = ?7
           AND status IN ('active', 'paused', 'blocked', 'interrupted')",
        params![
            budget.max_rounds,
            budget.max_tokens,
            budget.max_duration_ms,
            budget.token_budget_unlimited,
            now,
            session_id,
            proposal_id
        ],
    )?;
    if changed != 1 {
        return Err(plan_error("GOAL_STATE_CONFLICT"));
    }
    let goal = tx.query_row(
        &format!("SELECT {GOAL_COLUMNS} FROM goal_lifecycles WHERE proposal_id = ?1"),
        params![proposal_id],
        goal_from_row,
    )?;
    audit::append_tx(
        &tx,
        "goal_budget_updated",
        Some(session_id),
        json!({
            "proposalId": proposal_id,
            "maxRounds": budget.max_rounds,
            "maxTokens": budget.max_tokens,
            "maxDurationMs": budget.max_duration_ms,
            "tokenBudgetUnlimited": budget.token_budget_unlimited,
        }),
    )?;
    tx.commit()?;
    Ok(GoalBudgetUpdateResult { goal })
}

fn get_proposal_tx(tx: &Transaction<'_>, proposal_id: &str) -> Result<Option<PlanProposal>> {
    let sql = format!("SELECT {PROPOSAL_COLUMNS} FROM plan_approvals WHERE request_id = ?1");
    Ok(tx
        .prepare_cached(&sql)?
        .query_row(params![proposal_id], proposal_from_row)
        .optional()?)
}

pub(crate) fn control(
    db: &Database,
    session_id: &str,
    proposal_id: &str,
    action: &str,
) -> Result<GoalControlResult> {
    if !matches!(action, "pause" | "resume" | "clear") {
        return Err(plan_error("GOAL_ACTION_INVALID"));
    }
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    let Some(mut goal) = tx
        .prepare_cached(&format!(
            "SELECT {GOAL_COLUMNS} FROM goal_lifecycles
             WHERE session_id = ?1 AND proposal_id = ?2 AND status <> 'cleared'
             ORDER BY updated_at DESC, rowid DESC LIMIT 1"
        ))?
        .query_row(params![session_id, proposal_id], goal_from_row)
        .optional()?
    else {
        return Err(plan_error("GOAL_NOT_FOUND"));
    };
    let mut execution = None;
    match action {
        "pause" => {
            if goal.status != "active" {
                if goal.status == "paused" {
                    tx.commit()?;
                    return Ok(GoalControlResult { goal, execution });
                }
                return Err(plan_error("GOAL_STATE_CONFLICT"));
            }
            let frozen_elapsed_ms = now
                .saturating_sub(goal.cycle_started_at)
                .max(goal.elapsed_ms);
            tx.execute(
                "UPDATE goal_lifecycles SET status = 'paused', stop_reason = 'user_paused',
                    elapsed_ms = ?2, updated_at = ?1, version = version + 1
                 WHERE proposal_id = ?3 AND status = 'active'",
                params![now, frozen_elapsed_ms, goal.proposal_id],
            )?;
            interrupt_current_run_tx(&tx, &goal, now)?;
            goal.elapsed_ms = frozen_elapsed_ms;
        }
        "clear" => {
            if goal.status != "cleared" {
                tx.execute(
                    "UPDATE goal_lifecycles SET status = 'cleared', stop_reason = 'user_cleared',
                        current_execution_id = NULL, updated_at = ?1, version = version + 1
                     WHERE proposal_id = ?2 AND status <> 'cleared'",
                    params![now, goal.proposal_id],
                )?;
                interrupt_current_run_tx(&tx, &goal, now)?;
            }
        }
        "resume" => {
            if !matches!(goal.status.as_str(), "paused" | "blocked" | "interrupted") {
                return Err(plan_error("GOAL_STATE_CONFLICT"));
            }
            let proposal = get_proposal_tx(&tx, &goal.proposal_id)?
                .ok_or_else(|| plan_error("GOAL_NOT_FOUND"))?;
            if proposal.status != STATUS_APPROVED || proposal.kind != KIND_GOAL {
                return Err(plan_error("GOAL_NOT_RESUMABLE"));
            }
            let next_execution_id = Uuid::new_v4().to_string();
            let next_cycle = goal.cycle + 1;
            let next_run_count = goal.run_count + 1;
            tx.execute(
                "INSERT INTO goal_runs (
                   execution_id, proposal_id, cycle, round_in_cycle, run_count,
                   status, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 1, ?4, 'queued', ?5, ?5)",
                params![
                    next_execution_id,
                    goal.proposal_id,
                    next_cycle,
                    next_run_count,
                    now
                ],
            )?;
            tx.execute(
                "UPDATE goal_lifecycles
                 SET status = 'active', current_execution_id = ?1, cycle = ?2,
                     round_in_cycle = 1, run_count = ?3, tokens_used = 0,
                     elapsed_ms = 0, cycle_started_at = ?4, stop_reason = NULL,
                     updated_at = ?4, version = version + 1
                 WHERE proposal_id = ?5 AND status IN ('paused', 'blocked', 'interrupted')",
                params![
                    next_execution_id,
                    next_cycle,
                    next_run_count,
                    now,
                    goal.proposal_id
                ],
            )?;
            tx.execute(
                "UPDATE plan_approvals SET execution_id = ?1, execution_state = 'queued',
                    error_code = NULL, updated_at = ?2, version = version + 1
                 WHERE request_id = ?3 AND status = 'approved' AND kind = 'goal'",
                params![next_execution_id, now, goal.proposal_id],
            )?;
            goal.current_execution_id = Some(next_execution_id);
            goal.status = "active".into();
            goal.cycle = next_cycle;
            goal.round_in_cycle = 1;
            goal.run_count = next_run_count;
            goal.tokens_used = 0;
            goal.elapsed_ms = 0;
            goal.cycle_started_at = now;
            goal.stop_reason = None;
            goal.updated_at = ms_to_ts(now);
            goal.version += 1;
            execution = execution_from_proposal(&PlanProposal {
                execution_id: goal.current_execution_id.clone(),
                execution_state: Some(EXECUTION_QUEUED.into()),
                ..proposal
            })?;
        }
        _ => unreachable!("action was validated"),
    }
    if action != "resume" {
        audit::append_tx(
            &tx,
            "goal_lifecycle_changed",
            Some(session_id),
            json!({
                "proposalId": goal.proposal_id,
                "action": action,
                "status": if action == "pause" { "paused" } else { "cleared" },
            }),
        )?;
        if action == "pause" {
            goal.status = "paused".into();
            goal.stop_reason = Some("user_paused".into());
        } else {
            goal.status = "cleared".into();
            goal.stop_reason = Some("user_cleared".into());
            goal.current_execution_id = None;
        }
        goal.updated_at = ms_to_ts(now);
        goal.version += 1;
    } else {
        audit::append_tx(
            &tx,
            "goal_lifecycle_changed",
            Some(session_id),
            json!({
                "proposalId": goal.proposal_id,
                "action": action,
                "status": "active",
                "executionId": goal.current_execution_id,
                "cycle": goal.cycle,
                "roundInCycle": goal.round_in_cycle,
            }),
        )?;
    }
    tx.commit()?;
    Ok(GoalControlResult { goal, execution })
}

fn interrupt_current_run_tx(tx: &Transaction<'_>, goal: &GoalLifecycle, now: i64) -> Result<()> {
    let Some(execution_id) = goal.current_execution_id.as_deref() else {
        return Ok(());
    };
    tx.execute(
        "UPDATE goal_runs SET status = 'interrupted', updated_at = ?1
         WHERE execution_id = ?2 AND status IN ('queued', 'running')",
        params![now, execution_id],
    )?;
    tx.execute(
        "UPDATE plan_approvals
         SET execution_state = 'interrupted', error_code = 'PLAN_EXECUTION_INTERRUPTED',
             updated_at = ?1, version = version + 1
         WHERE execution_id = ?2 AND execution_state IN ('queued', 'running')",
        params![now, execution_id],
    )?;
    Ok(())
}

impl PlanManager {
    pub fn goal_for_session(
        &self,
        db: &Database,
        session_id: &str,
    ) -> Result<Option<GoalLifecycle>> {
        current_for_session(db, session_id)
    }

    pub fn current_goals(&self, db: &Database) -> Result<Vec<GoalLifecycle>> {
        current_goals(db)
    }

    pub fn report_goal(
        &self,
        db: &Database,
        session_id: &str,
        proposal_id: &str,
        execution_id: &str,
        turn_id: &str,
        report: &GoalProgressReport,
    ) -> Result<GoalLifecycle> {
        record_report(db, session_id, proposal_id, execution_id, turn_id, report)
    }

    pub fn control_goal(
        &self,
        db: &Database,
        session_id: &str,
        proposal_id: &str,
        action: &str,
    ) -> Result<GoalControlResult> {
        control(db, session_id, proposal_id, action)
    }

    pub fn update_goal_budget(
        &self,
        db: &Database,
        session_id: &str,
        proposal_id: &str,
        budget: GoalBudget,
    ) -> Result<GoalBudgetUpdateResult> {
        update_budget(db, session_id, proposal_id, budget)
    }
}
