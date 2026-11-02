use super::*;
use crate::sessions;

fn test_db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

fn plan_session(db: &Database, workspace: &Path) -> sessions::SessionSummary {
    sessions::create_session(
        db,
        Some("Plan".into()),
        Some("plan".into()),
        None,
        None,
        Some(workspace.to_string_lossy().into_owned()),
    )
    .unwrap()
}

fn live_turn(db: &Database, session_id: &str) -> String {
    sessions::begin_turn(db, session_id, None, None).unwrap()
}

fn submit(manager: &PlanManager, db: &Database, root: &Path, call: &str) -> PlanProposal {
    let session = plan_session(db, root);
    let turn = live_turn(db, &session.id);
    manager
        .submit(
            db,
            PlanSubmitParams {
                workspace_root: root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: call,
                kind: KIND_PLAN,
                title: "Build API",
                markdown: "# Plan\n- implement",
                question: "Proceed?",
            },
        )
        .unwrap()
}

fn approve_goal(
    manager: &PlanManager,
    db: &Database,
    root: &Path,
    call: &str,
) -> (PlanProposal, PlanExecution, String) {
    let session = sessions::create_session(
        db,
        Some("Goal".into()),
        Some("goal".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn_id = live_turn(db, &session.id);
    let proposal = manager
        .submit(
            db,
            PlanSubmitParams {
                workspace_root: root,
                session_id: &session.id,
                turn_id: &turn_id,
                tool_call_id: call,
                kind: KIND_GOAL,
                title: "Reach the target",
                markdown: "# Goal\n\n## Acceptance criteria\n- verification passes",
                question: "Approve?",
            },
        )
        .unwrap();
    let resolved = manager
        .resolve(
            db,
            PlanResolveParams {
                workspace_root: Some(root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("ask"),
            },
        )
        .unwrap();
    (
        proposal,
        resolved.execution.expect("approved Goal has execution"),
        turn_id,
    )
}

fn goal_report(outcome: &str, status: &str) -> GoalProgressReport {
    GoalProgressReport {
        outcome: outcome.into(),
        summary: "Ran the required verification command.".into(),
        criteria: vec![GoalCriterionReport {
            criterion: "verification passes".into(),
            status: status.into(),
            evidence: vec!["cargo test -p host-core: passed".into()],
        }],
    }
}

#[test]
fn title_slug_and_filename_are_descriptive_and_local_minute_shaped() {
    let now = Local::now();
    let filename = plan_filename(KIND_PLAN, "Build API / v2", now, 1);
    assert!(filename.starts_with("build-api-v2-"));
    assert!(filename.ends_with(".md"));
    assert!(filename.is_ascii());
    assert_eq!(filename.len(), "build-api-v2-YYYYMMDD-HHmm.md".len());
    assert_eq!(title_slug("中文 / ???", KIND_PLAN), "中文");
    assert_eq!(title_slug("中文 / ???", KIND_GOAL), "中文");
    assert!(plan_filename(KIND_PLAN, "中文审批卡片", now, 1).starts_with("中文审批卡片-"));
}

#[test]
fn enter_plan_mode_uses_the_active_turn_and_tool_identity() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = live_turn(&db, &session.id);

    PlanManager
        .enter(&db, &session.id, &turn, "enter-plan-call", KIND_PLAN)
        .unwrap();

    assert_eq!(
        sessions::session_mode(&db, &session.id).unwrap().as_deref(),
        Some("plan")
    );
    let audit_payload: String = db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'plan_entered' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
    let audit_payload: serde_json::Value = serde_json::from_str(&audit_payload).unwrap();
    assert_eq!(audit_payload["turnId"], turn);
    assert_eq!(audit_payload["toolCallId"], "enter-plan-call");
}

#[test]
fn enter_plan_mode_rejects_a_stale_turn_without_a_mode_write() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();

    let error = PlanManager
        .enter(&db, &session.id, "stale-turn", "enter-plan-call", KIND_PLAN)
        .unwrap_err();
    assert_eq!(error.to_string(), "PLAN_APPROVAL_STALE");
    assert_eq!(
        sessions::session_mode(&db, &session.id).unwrap().as_deref(),
        Some("agent")
    );
}

#[test]
fn publication_collides_without_overwriting() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let first = submit(&manager, &db, &root, "call-1");
    let second_session = plan_session(&db, &root);
    let turn2 = live_turn(&db, &second_session.id);
    let second = manager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &second_session.id,
                turn_id: &turn2,
                tool_call_id: "call-2",
                kind: KIND_PLAN,
                title: "Build API",
                markdown: "second",
                question: "Proceed?",
            },
        )
        .unwrap();
    assert_ne!(
        first.artifact.as_ref().unwrap().relative_path,
        second.artifact.as_ref().unwrap().relative_path
    );
    assert_eq!(
        fs::read(root.join(&first.artifact.unwrap().relative_path)).unwrap(),
        b"# Plan\n- implement"
    );
}

#[test]
fn oversized_markdown_is_rejected_before_artifact_creation() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = plan_session(&db, &root);
    let turn = live_turn(&db, &session.id);
    let error = PlanManager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: "call-1",
                kind: KIND_PLAN,
                title: "Too large",
                markdown: &"x".repeat(PLAN_MAX_MARKDOWN_BYTES + 1),
                question: "Proceed?",
            },
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "PLAN_MARKDOWN_TOO_LARGE");
    assert!(!root.join(".pi").exists());
}

#[cfg(unix)]
#[test]
fn existing_plan_symlink_is_rejected() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    let outside = dir.path().join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(root.join(".pi")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".pi/plan")).unwrap();
    let session = plan_session(&db, &root);
    let turn = live_turn(&db, &session.id);
    let error = PlanManager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: "call-1",
                kind: KIND_PLAN,
                title: "Plan",
                markdown: "body",
                question: "?",
            },
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "PLAN_ARTIFACT_PATH_UNSAFE");
}

#[test]
fn pending_rows_are_interrupted_during_database_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (session_id, proposal_id);
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    {
        let db = Database::open(&path).unwrap();
        let session = plan_session(&db, &root);
        session_id = session.id;
        let turn = live_turn(&db, &session_id);
        proposal_id = PlanManager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &session_id,
                    turn_id: &turn,
                    tool_call_id: "call-1",
                    kind: KIND_PLAN,
                    title: "Plan",
                    markdown: "body",
                    question: "?",
                },
            )
            .unwrap()
            .id;
    }
    let db = Database::open(&path).unwrap();
    let pending = PlanManager
        .pending_for_session(&db, Some(&session_id))
        .unwrap();
    assert!(pending.is_empty());
    let proposal = get_proposal(&db, &proposal_id).unwrap().unwrap();
    assert_eq!(proposal.status, STATUS_INTERRUPTED);
    assert_eq!(
        proposal.error_code.as_deref(),
        Some("PLAN_APPROVAL_INTERRUPTED")
    );
}

#[test]
fn reject_has_no_side_effects_and_allows_new_turn_submission() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let first_artifact_path = proposal.artifact.as_ref().unwrap().relative_path.clone();
    let first_artifact_bytes = fs::read(root.join(&first_artifact_path)).unwrap();
    let before = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    let result = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "reject",
                target_permission_mode: None,
            },
        )
        .unwrap();
    let after = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    assert_eq!(result.status, STATUS_REJECTED);
    assert_eq!(before.mode, after.mode);
    assert_eq!(before.permission_mode, after.permission_mode);
    assert!(result.execution.is_none());
    assert!(manager
        .pending_for_session(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());
    let ended = sessions::end_turn(&db, &proposal.turn_id, "completed", None, None, false).unwrap();
    assert!(ended.updated);
    let next_turn = live_turn(&db, &proposal.session_id);
    let revised = manager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &proposal.session_id,
                turn_id: &next_turn,
                tool_call_id: "call-2",
                kind: KIND_PLAN,
                title: "Build API revised",
                markdown: "# Plan\n- revise",
                question: "Proceed with the revision?",
            },
        )
        .unwrap();
    assert_ne!(revised.id, proposal.id);
    assert_eq!(revised.status, STATUS_PENDING);
    assert_eq!(revised.turn_id, next_turn);
    assert_ne!(
        revised.artifact.as_ref().unwrap().relative_path,
        first_artifact_path
    );
    assert_eq!(
        fs::read(root.join(&first_artifact_path)).unwrap(),
        first_artifact_bytes
    );
    assert_eq!(
        manager
            .pending_for_session(&db, Some(&proposal.session_id))
            .unwrap()
            .iter()
            .map(|pending| pending.id.as_str())
            .collect::<Vec<_>>(),
        vec![revised.id.as_str()]
    );
    let rejected = get_proposal(&db, &proposal.id).unwrap().unwrap();
    assert_eq!(rejected.status, STATUS_REJECTED);
    assert_eq!(
        rejected.artifact.unwrap().relative_path,
        first_artifact_path
    );
    let execution_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM plan_approvals WHERE execution_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(execution_count, 0);
}

#[test]
fn approval_switches_session_and_creates_outbox_atomically() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let result = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("accept-edits"),
            },
        )
        .unwrap();
    let execution = result.execution.unwrap();
    assert_eq!(result.status, STATUS_APPROVED);
    assert_eq!(execution.state, EXECUTION_QUEUED);
    let session = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    assert_eq!(session.mode, "agent");
    assert_eq!(session.permission_mode, "accept-edits");
    assert!(db.get_setting("app").unwrap().is_none());
    assert_eq!(manager.queued_executions(&db, None).unwrap().len(), 1);
}

#[test]
fn duplicate_resolution_returns_committed_result_and_conflict_is_stale() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let first = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    let duplicate = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    assert_eq!(duplicate.proposal.version, first.proposal.version);
    assert_eq!(duplicate.execution.unwrap().id, first.execution.unwrap().id);
    assert_eq!(
        manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "reject",
                    target_permission_mode: None,
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_APPROVAL_CONFLICT"
    );
}

#[test]
fn approval_deadline_expires_lazily_and_rejects_late_resolution() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let expires_at = proposal
        .expires_at
        .as_deref()
        .map(crate::db::ts_to_ms)
        .unwrap();
    assert!(expires_at >= now_ms() + PLAN_APPROVAL_TIMEOUT_MS - 1_000);
    db.conn()
        .execute(
            "UPDATE plan_approvals SET expires_at = ?1 WHERE request_id = ?2",
            params![now_ms() - 1, proposal.id],
        )
        .unwrap();

    assert!(manager
        .pending_for_session(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());
    let stored = get_proposal(&db, &proposal.id).unwrap().unwrap();
    assert_eq!(stored.status, STATUS_EXPIRED);
    assert_eq!(stored.error_code.as_deref(), Some("PLAN_APPROVAL_TIMEOUT"));
    assert_eq!(
        manager
            .state_for_session(&db, &proposal.session_id)
            .unwrap(),
        "planning"
    );
    assert_eq!(
        manager
            .resolution_for(&db, &proposal.id)
            .unwrap()
            .unwrap()
            .status,
        STATUS_EXPIRED
    );

    sessions::end_turn(&db, &proposal.turn_id, "aborted", None, None, false).unwrap();
    assert!(gate_session_configure(
        &db,
        &proposal.session_id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .is_ok());
    assert_eq!(
        manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "reject",
                    target_permission_mode: None,
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_APPROVAL_TIMEOUT"
    );
}

#[test]
fn claim_and_finish_are_durable_cas_transitions() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let approved = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    let id = approved.execution.as_ref().unwrap().id.clone();
    let running = manager.claim_execution(&db, &id).unwrap();
    assert_eq!(running.state, EXECUTION_RUNNING);
    assert!(manager.claim_execution(&db, &id).is_err());
    let completed = manager
        .finish_execution(&db, &id, EXECUTION_COMPLETED, None)
        .unwrap();
    assert_eq!(completed.state, EXECUTION_COMPLETED);
    assert!(manager
        .finish_execution(&db, &id, EXECUTION_INTERRUPTED, Some("late"))
        .is_err());
}

#[test]
fn configure_gate_blocks_pending_and_active_execution_changes() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    assert_eq!(
        gate_session_configure(
            &db,
            &proposal.session_id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap_err()
        .to_string(),
        "PLAN_CONFIGURATION_BLOCKED"
    );
    for blocked in [
        gate_session_configure(
            &db,
            &proposal.session_id,
            "plan",
            Some("other-provider"),
            None,
            None,
            None,
        ),
        gate_session_configure(
            &db,
            &proposal.session_id,
            "plan",
            None,
            Some("other-model"),
            None,
            None,
        ),
        gate_session_configure(
            &db,
            &proposal.session_id,
            "plan",
            None,
            None,
            Some("high"),
            None,
        ),
    ] {
        assert_eq!(
            blocked.unwrap_err().to_string(),
            "PLAN_CONFIGURATION_BLOCKED"
        );
    }
    manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    assert_eq!(
        gate_session_configure(&db, &proposal.session_id, "plan", None, None, None, None,)
            .unwrap_err()
            .to_string(),
        "PLAN_CONFIGURATION_BLOCKED"
    );
}

#[test]
fn configure_gate_blocks_changes_while_a_turn_is_running() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
    assert_eq!(
        gate_session_configure(
            &db,
            &session.id,
            "agent",
            Some("provider-2"),
            None,
            None,
            None,
        )
        .unwrap_err()
        .to_string(),
        "PLAN_CONFIGURATION_BLOCKED"
    );
    sessions::end_turn(&db, &turn, "aborted", None, None, false).unwrap();
    assert!(gate_session_configure(
        &db,
        &session.id,
        "agent",
        Some("provider-2"),
        None,
        None,
        None,
    )
    .is_ok());
}

fn goal_session(db: &Database, workspace: &Path) -> sessions::SessionSummary {
    sessions::create_session(
        db,
        Some("Goal".into()),
        Some("goal".into()),
        None,
        None,
        Some(workspace.to_string_lossy().into_owned()),
    )
    .unwrap()
}

#[test]
fn every_kind_publishes_into_its_own_artifact_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    for kind in [KIND_PLAN, KIND_GOAL] {
        let kind = normalize_kind(kind).unwrap();
        let (artifact, path) =
            publish_artifact(&root, kind, "Ship checkout", "# Contract\n- done").unwrap();
        assert!(
            artifact.relative_path.starts_with(&format!(".pi/{kind}/")),
            "{} should live under .pi/{kind}/",
            artifact.relative_path
        );
        assert!(path.is_file());
        // A path claiming the other kind's directory must not resolve.
        let other = if kind == KIND_PLAN {
            KIND_GOAL
        } else {
            KIND_PLAN
        };
        assert_eq!(
            safe_artifact_path(&root, other, &artifact.relative_path)
                .unwrap_err()
                .to_string(),
            "PLAN_ARTIFACT_PATH_UNSAFE"
        );
    }
}

#[test]
fn goal_contract_round_trips_through_its_own_kind() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let session = goal_session(&db, &root);
    let turn = live_turn(&db, &session.id);
    let proposal = manager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: "goal-call-1",
                kind: KIND_GOAL,
                title: "Ship checkout",
                markdown: "# Goal\n## Acceptance criteria\n- tests pass",
                question: "Approve this goal?",
            },
        )
        .unwrap();
    assert_eq!(proposal.kind, KIND_GOAL);
    assert!(proposal
        .artifact
        .as_ref()
        .unwrap()
        .relative_path
        .starts_with(".pi/goal/"));
    assert_eq!(
        manager.active_kind(&db, &session.id).unwrap(),
        Some(KIND_GOAL)
    );
    assert_eq!(
        manager.state_for_session(&db, &session.id).unwrap(),
        "awaiting_approval"
    );

    let resolution = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("accept-edits"),
            },
        )
        .unwrap();
    let execution = resolution.execution.unwrap();
    assert_eq!(execution.kind, KIND_GOAL);
    assert_eq!(execution.state, EXECUTION_QUEUED);
    // Approval hands the session back to Agent so execution can act.
    let session = sessions::get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(session.summary.mode, "agent");
    assert_eq!(
        manager.active_kind(&db, &proposal.session_id).unwrap(),
        None
    );
    assert_eq!(
        manager.queued_executions(&db, None).unwrap()[0].kind,
        KIND_GOAL
    );
    assert_eq!(
        manager
            .enter(&db, &proposal.session_id, &turn, "goal-again", KIND_GOAL)
            .unwrap_err()
            .to_string(),
        "GOAL_ALREADY_ACTIVE"
    );
}

#[test]
fn submitting_the_other_contract_kind_is_rejected() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let goal = goal_session(&db, &root);
    let goal_turn = live_turn(&db, &goal.id);
    assert_eq!(
        manager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &goal.id,
                    turn_id: &goal_turn,
                    tool_call_id: "wrong-kind-1",
                    kind: KIND_PLAN,
                    title: "Plan in a goal session",
                    markdown: "# Plan",
                    question: "Proceed?",
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_KIND_MISMATCH"
    );

    let plan = plan_session(&db, &root);
    let plan_turn = live_turn(&db, &plan.id);
    assert_eq!(
        manager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &plan.id,
                    turn_id: &plan_turn,
                    tool_call_id: "wrong-kind-2",
                    kind: KIND_GOAL,
                    title: "Goal in a plan session",
                    markdown: "# Goal",
                    question: "Approve?",
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_KIND_MISMATCH"
    );
    // Neither rejected submission may leave an artifact behind.
    assert!(!root.join(".pi").join("goal").exists());
    assert!(!root.join(".pi").join("plan").exists());
}

#[test]
fn entering_goal_mode_writes_the_goal_mode_and_kind() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = live_turn(&db, &session.id);

    PlanManager
        .enter(&db, &session.id, &turn, "enter-goal-call", KIND_GOAL)
        .unwrap();

    assert_eq!(
        sessions::session_mode(&db, &session.id).unwrap().as_deref(),
        Some("goal")
    );
    let audit_payload: String = db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'plan_entered' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
    let audit_payload: serde_json::Value = serde_json::from_str(&audit_payload).unwrap();
    assert_eq!(audit_payload["kind"], "goal");

    // A second entry is refused whatever kind it asks for.
    assert_eq!(
        PlanManager
            .enter(&db, &session.id, &turn, "enter-plan-call", KIND_PLAN)
            .unwrap_err()
            .to_string(),
        "PLAN_ALREADY_ACTIVE"
    );
    assert_eq!(
        PlanManager
            .enter(&db, &session.id, &turn, "enter-bogus-call", "sprint")
            .unwrap_err()
            .to_string(),
        "PLAN_INVALID_ARGUMENT"
    );
}

#[test]
fn goal_reports_are_persisted_and_complete_only_with_criterion_evidence() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let (proposal, queued, turn_id) = approve_goal(&manager, &db, &root, "goal-report");
    let running = manager.claim_execution(&db, &queued.id).unwrap();
    assert_eq!(running.state, EXECUTION_RUNNING);

    let report = goal_report("complete", "met");
    assert_eq!(
        manager
            .report_goal(
                &db,
                &proposal.session_id,
                &proposal.id,
                &running.id,
                "not-a-live-turn",
                &report,
            )
            .unwrap_err()
            .to_string(),
        "GOAL_REPORT_STALE"
    );
    let active = manager
        .report_goal(
            &db,
            &proposal.session_id,
            &proposal.id,
            &running.id,
            &turn_id,
            &report,
        )
        .unwrap();
    assert_eq!(active.status, "active");
    assert_eq!(active.latest_report, Some(report));

    let finished = manager
        .finish_execution(&db, &running.id, EXECUTION_COMPLETED, None)
        .unwrap();
    assert_eq!(finished.state, EXECUTION_COMPLETED);
    let completed = manager
        .goal_for_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(completed.status, "completed");
    assert_eq!(completed.current_execution_id, None);
    assert_eq!(
        completed.latest_report.unwrap().criteria[0].evidence.len(),
        1
    );
}

#[test]
fn continuing_goal_creates_a_distinct_queued_round_and_then_finishes() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let (proposal, first, turn_id) = approve_goal(&manager, &db, &root, "goal-continue");
    manager.claim_execution(&db, &first.id).unwrap();
    manager
        .report_goal(
            &db,
            &proposal.session_id,
            &proposal.id,
            &first.id,
            &turn_id,
            &goal_report("continue", "unmet"),
        )
        .unwrap();

    let second = manager
        .finish_execution(&db, &first.id, EXECUTION_COMPLETED, None)
        .unwrap();
    assert_ne!(second.id, first.id);
    assert_eq!(second.state, EXECUTION_QUEUED);
    let second_state = manager
        .goal_for_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(second_state.status, "active");
    assert_eq!(second_state.run_count, 2);
    assert_eq!(second_state.cycle, 1);
    assert_eq!(second_state.round_in_cycle, 2);

    manager.claim_execution(&db, &second.id).unwrap();
    manager
        .report_goal(
            &db,
            &proposal.session_id,
            &proposal.id,
            &second.id,
            &turn_id,
            &goal_report("complete", "met"),
        )
        .unwrap();
    manager
        .finish_execution(&db, &second.id, EXECUTION_COMPLETED, None)
        .unwrap();
    assert_eq!(
        manager
            .goal_for_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap()
            .status,
        "completed"
    );
}

#[test]
fn pause_interrupts_without_replay_and_resume_starts_a_new_cycle() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let (proposal, first, turn_id) = approve_goal(&manager, &db, &root, "goal-pause");
    manager.claim_execution(&db, &first.id).unwrap();

    let paused = manager
        .control_goal(&db, &proposal.session_id, &proposal.id, "pause")
        .unwrap();
    assert_eq!(paused.goal.status, "paused");
    assert_eq!(paused.goal.stop_reason.as_deref(), Some("user_paused"));
    assert_eq!(paused.execution, None);
    let old_execution = manager
        .finish_execution(&db, &first.id, EXECUTION_INTERRUPTED, Some("user_paused"))
        .unwrap();
    assert_eq!(old_execution.state, EXECUTION_INTERRUPTED);

    let resumed = manager
        .control_goal(&db, &proposal.session_id, &proposal.id, "resume")
        .unwrap();
    let second = resumed.execution.unwrap();
    assert_ne!(second.id, first.id);
    assert_eq!(second.state, EXECUTION_QUEUED);
    assert_eq!(resumed.goal.status, "active");
    assert_eq!(resumed.goal.cycle, 2);
    assert_eq!(resumed.goal.round_in_cycle, 1);
    assert_eq!(resumed.goal.run_count, 2);

    manager.claim_execution(&db, &second.id).unwrap();
    assert_eq!(
        manager
            .report_goal(
                &db,
                &proposal.session_id,
                &proposal.id,
                &first.id,
                &turn_id,
                &goal_report("continue", "unmet"),
            )
            .unwrap_err()
            .to_string(),
        "GOAL_REPORT_STALE"
    );
}

#[test]
fn goal_control_requires_the_current_proposal_id() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let (proposal, execution, _) = approve_goal(&manager, &db, &root, "goal-control-identity");

    let error = manager
        .control_goal(
            &db,
            &proposal.session_id,
            "stale-or-unknown-proposal",
            "pause",
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "GOAL_NOT_FOUND");

    let unchanged = manager
        .goal_for_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(unchanged.proposal_id, proposal.id);
    assert_eq!(unchanged.title, "Reach the target");
    assert_eq!(unchanged.status, "active");
    assert_eq!(
        unchanged.current_execution_id.as_deref(),
        Some(execution.id.as_str())
    );
    let queued = manager
        .queued_executions(&db, Some(&proposal.session_id))
        .unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].id, execution.id);
    let global = manager.current_goals(&db).unwrap();
    assert_eq!(global.len(), 1);
    assert_eq!(global[0].title, "Reach the target");
}

#[test]
fn a_goal_round_limit_pauses_until_explicit_resume() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let (proposal, first, turn_id) = approve_goal(&manager, &db, &root, "goal-limit");
    db.conn()
        .execute(
            "UPDATE goal_lifecycles SET max_rounds = 1 WHERE proposal_id = ?1",
            params![proposal.id],
        )
        .unwrap();
    manager.claim_execution(&db, &first.id).unwrap();
    manager
        .report_goal(
            &db,
            &proposal.session_id,
            &proposal.id,
            &first.id,
            &turn_id,
            &goal_report("continue", "unmet"),
        )
        .unwrap();
    manager
        .finish_execution(&db, &first.id, EXECUTION_COMPLETED, None)
        .unwrap();
    let stopped = manager
        .goal_for_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(stopped.status, "paused");
    assert_eq!(
        stopped.stop_reason.as_deref(),
        Some("GOAL_AUTO_ROUND_LIMIT")
    );
    assert!(manager
        .queued_executions(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());

    let resumed = manager
        .control_goal(&db, &proposal.session_id, &proposal.id, "resume")
        .unwrap();
    assert_eq!(resumed.goal.status, "active");
    assert_eq!(resumed.goal.cycle, 2);
    assert_eq!(resumed.goal.round_in_cycle, 1);
    assert!(resumed.execution.is_some());
}

#[test]
fn a_goal_token_budget_pauses_auto_continuation_and_resets_on_resume() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let (proposal, execution, turn_id) = approve_goal(&manager, &db, &root, "goal-token-budget");
    db.conn()
        .execute(
            "UPDATE goal_lifecycles SET max_tokens = 100 WHERE proposal_id = ?1",
            params![proposal.id],
        )
        .unwrap();
    db.conn()
        .execute(
            "UPDATE turns SET usage_json = ?1 WHERE id = ?2",
            params![json!({"totalTokens": 100}).to_string(), turn_id],
        )
        .unwrap();

    manager.claim_execution(&db, &execution.id).unwrap();
    manager
        .report_goal(
            &db,
            &proposal.session_id,
            &proposal.id,
            &execution.id,
            &turn_id,
            &goal_report("continue", "unmet"),
        )
        .unwrap();
    manager
        .finish_execution(&db, &execution.id, EXECUTION_COMPLETED, None)
        .unwrap();

    let paused = manager
        .goal_for_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(paused.status, "paused");
    assert_eq!(paused.stop_reason.as_deref(), Some("GOAL_BUDGET_EXHAUSTED"));
    assert_eq!(paused.tokens_used, 100);
    assert!(manager
        .queued_executions(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());

    let resumed = manager
        .control_goal(&db, &proposal.session_id, &proposal.id, "resume")
        .unwrap();
    assert_eq!(resumed.goal.cycle, 2);
    assert_eq!(resumed.goal.tokens_used, 0);
    assert_eq!(resumed.goal.elapsed_ms, 0);
    assert!(resumed.execution.is_some());
}

#[test]
fn a_goal_time_budget_pauses_auto_continuation_after_the_current_round() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let (proposal, execution, turn_id) = approve_goal(&manager, &db, &root, "goal-time-budget");
    let expired_at = crate::db::now_ms() - 10_000;
    db.conn()
        .execute(
            "UPDATE goal_lifecycles
             SET max_duration_ms = 5_000, cycle_started_at = ?1
             WHERE proposal_id = ?2",
            params![expired_at, proposal.id],
        )
        .unwrap();

    manager.claim_execution(&db, &execution.id).unwrap();
    manager
        .report_goal(
            &db,
            &proposal.session_id,
            &proposal.id,
            &execution.id,
            &turn_id,
            &goal_report("continue", "unmet"),
        )
        .unwrap();
    manager
        .finish_execution(&db, &execution.id, EXECUTION_COMPLETED, None)
        .unwrap();

    let paused = manager
        .goal_for_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(paused.status, "paused");
    assert_eq!(paused.stop_reason.as_deref(), Some("GOAL_BUDGET_EXHAUSTED"));
    assert!(paused.elapsed_ms >= 5_000);
    assert!(manager
        .queued_executions(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());
}

#[test]
fn schema_v27_goal_migration_never_assumes_completion_or_replays_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (session_id, old_execution_id) = {
        let db = Database::open(&path).unwrap();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let (proposal, _, _) = approve_goal(&manager, &db, &root, "goal-v27");
        let latest_timestamp = crate::db::now_ms() + 60_000;
        db.conn()
            .execute(
                "UPDATE plan_approvals SET execution_state = 'completed' WHERE request_id = ?1",
                params![proposal.id],
            )
            .unwrap();
        // A session may have several approved Goal contracts in its history.
        // The schema migration should restore only the most recent lifecycle,
        // rather than violating the one-open-Goal invariant on older data.
        db.conn()
            .execute(
                "INSERT INTO plan_approvals (
                   request_id, session_id, turn_id, tool_call_id, kind, plan_json,
                   title, question, status, created_at, updated_at,
                   artifact_relative_path, artifact_sha256, artifact_size_bytes,
                   version, execution_id, execution_state, target_permission_mode
                 ) VALUES (
                   'legacy-latest-goal', ?1, 'legacy-turn', 'legacy-call', 'goal',
                   '# New Goal', 'New Goal', 'Approve?', 'approved', ?2, ?2,
                   '.pi/goal/latest.md', 'hash', 12, 1,
                   'legacy-latest-execution', 'completed', 'ask'
                 )",
                params![proposal.session_id, latest_timestamp],
            )
            .unwrap();
        (proposal.session_id, "legacy-latest-execution".to_owned())
    };
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP TABLE goal_runs;
             DROP TABLE goal_lifecycles;
             PRAGMA user_version = 27;",
        )
        .unwrap();
    }

    let migrated = Database::open(&path).unwrap();
    let manager = PlanManager;
    let lifecycle = manager
        .goal_for_session(&migrated, &session_id)
        .unwrap()
        .unwrap();
    assert_eq!(lifecycle.proposal_id, "legacy-latest-goal");
    assert_eq!(lifecycle.title, "New Goal");
    assert_eq!(lifecycle.status, "interrupted");
    assert_eq!(
        lifecycle.stop_reason.as_deref(),
        Some("migration_requires_review")
    );
    assert_eq!(lifecycle.latest_report, None);
    assert!(manager
        .queued_executions(&migrated, Some(&session_id))
        .unwrap()
        .is_empty());
    let lifecycle_count: i64 = migrated
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM goal_lifecycles WHERE session_id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(lifecycle_count, 1);

    let resumed = manager
        .control_goal(&migrated, &session_id, "legacy-latest-goal", "resume")
        .unwrap();
    let new_execution = resumed.execution.unwrap();
    assert_ne!(new_execution.id, old_execution_id);
    assert_ne!(new_execution.id, "legacy-latest-execution");
    assert_eq!(new_execution.state, EXECUTION_QUEUED);
    assert_eq!(resumed.goal.cycle, 2);
    assert_eq!(resumed.goal.status, "active");
    let version: i64 = migrated
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::db::SCHEMA_VERSION);
}

#[test]
fn host_restart_interrupts_goal_and_requires_a_new_manual_resume_execution() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (session_id, proposal_id, old_execution_id) = {
        let db = Database::open(&path).unwrap();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let (proposal, execution, _) = approve_goal(&PlanManager, &db, &root, "goal-restart");
        PlanManager.claim_execution(&db, &execution.id).unwrap();
        (proposal.session_id, proposal.id, execution.id)
    };

    let db = Database::open(&path).unwrap();
    let manager = PlanManager;
    let interrupted = manager.goal_for_session(&db, &session_id).unwrap().unwrap();
    assert_eq!(interrupted.status, "interrupted");
    assert_eq!(interrupted.title, "Reach the target");
    assert_eq!(interrupted.stop_reason.as_deref(), Some("host_restart"));
    assert_eq!(
        interrupted.current_execution_id.as_deref(),
        Some(old_execution_id.as_str())
    );
    assert!(manager
        .queued_executions(&db, Some(&session_id))
        .unwrap()
        .is_empty());
    let old_run_status: String = db
        .conn()
        .query_row(
            "SELECT status FROM goal_runs WHERE execution_id = ?1",
            params![old_execution_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(old_run_status, "interrupted");

    let resumed = manager
        .control_goal(&db, &session_id, &proposal_id, "resume")
        .unwrap();
    let new_execution = resumed.execution.unwrap();
    assert_ne!(new_execution.id, old_execution_id);
    assert_eq!(new_execution.state, EXECUTION_QUEUED);
    assert_eq!(resumed.goal.status, "active");
    assert_eq!(resumed.goal.run_count, interrupted.run_count + 1);
    assert_eq!(resumed.goal.cycle, interrupted.cycle + 1);
    assert_eq!(resumed.goal.proposal_id, proposal_id);
}

#[path = "history_tests.rs"]
mod history;
