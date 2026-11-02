use super::{create_migration_backup, Connection, Context, Path, Result, GOAL_LIFECYCLE_SCHEMA};
use rusqlite::Transaction;

/// Schema v28 stores mutable Goal lifecycle and per-run checkpoints outside
/// the immutable Plan/Goal approval row. Existing Goal executions have no
/// criterion-level evidence, so they are retained as interrupted and require
/// an explicit user resume rather than being reported complete or replayed.
fn migrate_v27_to_v28_tx(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(GOAL_LIFECYCLE_SCHEMA)?;
    tx.execute_batch(
        "INSERT INTO goal_lifecycles (
           proposal_id, session_id, status, current_execution_id, cycle,
           round_in_cycle, run_count, max_rounds, max_tokens,
           max_duration_ms, tokens_used, elapsed_ms, cycle_started_at, stop_reason,
           created_at, updated_at
         )
         SELECT request_id, session_id, 'interrupted',
                execution_id, 1, 1, 1, 8, 250000, 3600000, 0, 0, updated_at,
                'migration_requires_review',
                created_at, updated_at
         FROM (
           SELECT request_id, session_id, execution_id, created_at, updated_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_id ORDER BY updated_at DESC, rowid DESC
                  ) AS recency
           FROM plan_approvals
           WHERE COALESCE(kind, 'plan') = 'goal'
             AND status = 'approved'
             AND execution_id IS NOT NULL
         )
         WHERE recency = 1
         ON CONFLICT(proposal_id) DO NOTHING;

         INSERT INTO goal_runs (
           execution_id, proposal_id, cycle, round_in_cycle, run_count,
           status, created_at, updated_at
         )
         SELECT approval.execution_id, approval.request_id, 1, 1, 1,
                CASE WHEN execution_state = 'completed' THEN 'completed'
                     ELSE 'interrupted' END,
                approval.created_at, approval.updated_at
         FROM plan_approvals approval
         JOIN goal_lifecycles lifecycle ON lifecycle.proposal_id = approval.request_id
         ON CONFLICT(execution_id) DO NOTHING;",
    )?;
    tx.pragma_update(None, "user_version", 28i64)?;
    Ok(())
}

pub(crate) fn migrate_v27_to_v28(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 27)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v27_to_v28_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v27 to v28 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
