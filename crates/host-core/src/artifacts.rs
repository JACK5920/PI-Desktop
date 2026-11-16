use anyhow::Result;
use rusqlite::params;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::db::{ms_to_ts, now_ms, Database};

/// Files a session produced via Write/Edit tools (04-data-storage §4.9).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub session_id: String,
    pub session_title: Option<String>,
    pub path: String,
    pub op: String,
    pub turn_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub source: String,
    pub confidence: String,
    pub exists_after: bool,
    /// Live path status at query time. `exists_after` remains the immutable
    /// observation captured when the event was recorded.
    pub exists_now: bool,
    pub size_bytes: Option<i64>,
    pub sha256: Option<String>,
    pub previous_path: Option<String>,
    pub turn_status: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceFileStamp {
    pub size_bytes: u64,
    pub modified_ns: u128,
    pub sha256: Option<String>,
}

/// Snapshot only the selected workspace (never external/scratch paths). Keep
/// traversal bounded and skip build/cache trees so a shell call cannot make
/// artifact accounting proportional to node_modules or target directories.
pub fn snapshot_workspace(
    root: &Path,
) -> Result<std::collections::BTreeMap<PathBuf, WorkspaceFileStamp>> {
    let mut out = std::collections::BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    let mut hashed_bytes = 0u64;
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if out.len() >= 5000 {
                return Ok(out);
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if !matches!(
                    name.as_str(),
                    ".git"
                        | "node_modules"
                        | "target"
                        | "target2"
                        | "dist"
                        | "build"
                        | ".next"
                        | ".cache"
                ) {
                    pending.push(path);
                }
                continue;
            }
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let modified_ns = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let sha256 = if meta.len() <= 4 * 1024 * 1024
                && hashed_bytes.saturating_add(meta.len()) <= 64 * 1024 * 1024
            {
                match std::fs::read(&path) {
                    Ok(bytes) => {
                        hashed_bytes = hashed_bytes.saturating_add(meta.len());
                        Some(hex::encode(Sha256::digest(bytes)))
                    }
                    Err(_) => None,
                }
            } else {
                None
            };
            out.insert(
                path,
                WorkspaceFileStamp {
                    size_bytes: meta.len(),
                    modified_ns,
                    sha256,
                },
            );
        }
    }
    Ok(out)
}

pub fn record_workspace_diff(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    tool_call_id: &str,
    before: &std::collections::BTreeMap<PathBuf, WorkspaceFileStamp>,
    after: &std::collections::BTreeMap<PathBuf, WorkspaceFileStamp>,
) -> Result<usize> {
    let removed: Vec<_> = before
        .iter()
        .filter(|(path, _)| !after.contains_key(*path))
        .collect();
    let added: Vec<_> = after
        .iter()
        .filter(|(path, stamp)| before.get(*path) != Some(*stamp))
        .collect();
    let mut renamed_old = std::collections::HashSet::new();
    let mut count = 0;
    for (path, stamp) in &added {
        let rename_from = stamp.sha256.as_ref().and_then(|hash| {
            removed
                .iter()
                .find(|(old, old_stamp)| {
                    !renamed_old.contains(*old) && old_stamp.sha256.as_ref() == Some(hash)
                })
                .map(|(old, _)| (*old).clone())
        });
        if let Some(old) = &rename_from {
            renamed_old.insert(old.clone());
        }
        let op = if rename_from.is_some() {
            "rename"
        } else if before.contains_key(*path) {
            "edit"
        } else {
            "create"
        };
        record_observed(
            db,
            session_id,
            turn_id,
            Some(tool_call_id),
            path,
            op,
            "workspace_diff",
            "observed",
            rename_from.as_deref(),
        )?;
        count += 1;
    }
    for (path, _) in removed {
        if renamed_old.contains(path) {
            continue;
        }
        record_observed(
            db,
            session_id,
            turn_id,
            Some(tool_call_id),
            path,
            "delete",
            "workspace_diff",
            "observed",
            None,
        )?;
        count += 1;
    }
    Ok(count)
}

fn file_evidence(path: &Path) -> (bool, Option<u64>, Option<String>) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (false, None, None);
    };
    if !meta.is_file() {
        return (true, Some(meta.len()), None);
    }
    // Hash normal source/document outputs only; large generated assets retain
    // size + existence evidence without an unbounded read.
    if meta.len() > 16 * 1024 * 1024 {
        return (true, Some(meta.len()), None);
    }
    let Ok(bytes) = std::fs::read(path) else {
        return (true, Some(meta.len()), None);
    };
    (
        true,
        Some(meta.len()),
        Some(hex::encode(Sha256::digest(bytes))),
    )
}

pub fn record_observed(
    db: &Database,
    session_id: &str,
    turn_id: Option<&str>,
    tool_call_id: Option<&str>,
    path: &Path,
    op: &str,
    source: &str,
    confidence: &str,
    previous_path: Option<&Path>,
) -> Result<()> {
    let path_text = path.to_string_lossy().to_string();
    let previous_text = previous_path.map(|p| p.to_string_lossy().to_string());
    let (exists, size_bytes, sha256) = file_evidence(path);
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "INSERT INTO artifact_events (id, session_id, turn_id, tool_call_id, path, previous_path, op, source, confidence, exists_after, size_bytes, sha256, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![uuid::Uuid::new_v4().to_string(), session_id, turn_id, tool_call_id, path_text, previous_text, op, source, confidence, exists, size_bytes.map(|size| size.min(i64::MAX as u64) as i64), sha256, now],
    )?;
    if exists {
        tx.execute(
            "INSERT INTO artifacts (session_id, path, op, turn_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, path) DO UPDATE SET op=excluded.op, turn_id=COALESCE(excluded.turn_id, artifacts.turn_id), updated_at=excluded.updated_at",
            params![session_id, path_text, op, turn_id, now],
        )?;
        if let Some(previous) = previous_text.as_deref() {
            tx.execute(
                "DELETE FROM artifacts WHERE session_id=?1 AND path=?2",
                params![session_id, previous],
            )?;
        }
    } else {
        tx.execute(
            "DELETE FROM artifacts WHERE session_id=?1 AND path=?2",
            params![session_id, path_text],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Upsert: one row per (session, file); repeat edits refresh op + timestamp.
pub fn record(
    db: &Database,
    session_id: &str,
    path: &str,
    op: &str,
    turn_id: Option<&str>,
) -> Result<()> {
    record_on(db.conn(), session_id, path, op, turn_id)
}

/// Register an artifact as part of the plan submission transaction.
pub fn record_tx(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    path: &str,
    op: &str,
    turn_id: Option<&str>,
) -> Result<()> {
    record_on(tx, session_id, path, op, turn_id)
}

fn record_on(
    conn: &rusqlite::Connection,
    session_id: &str,
    path: &str,
    op: &str,
    turn_id: Option<&str>,
) -> Result<()> {
    let file_path = Path::new(path);
    let (exists, size_bytes, sha256) = file_evidence(file_path);
    let now = now_ms();
    conn.prepare_cached(
        "INSERT INTO artifacts (session_id, path, op, turn_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id, path) DO UPDATE SET
               op = excluded.op,
               turn_id = COALESCE(excluded.turn_id, artifacts.turn_id),
               updated_at = excluded.updated_at",
    )?
    .execute(params![session_id, path, op, turn_id, now])?;
    conn.execute(
        "INSERT INTO artifact_events (id, session_id, turn_id, tool_call_id, path, previous_path, op, source, confidence, exists_after, size_bytes, sha256, created_at)
         VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, 'host_tool', 'confirmed', ?6, ?7, ?8, ?9)",
        params![uuid::Uuid::new_v4().to_string(), session_id, turn_id, path, op, exists, size_bytes.map(|size| size.min(i64::MAX as u64) as i64), sha256, now],
    )?;
    Ok(())
}

pub fn list(
    db: &Database,
    session_id: Option<&str>,
    turn_id: Option<&str>,
    limit: i64,
) -> Result<Vec<Artifact>> {
    list_page(db, session_id, turn_id, limit, 0)
}

pub fn list_page(
    db: &Database,
    session_id: Option<&str>,
    turn_id: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<Artifact>> {
    let limit = limit.clamp(1, 500);
    let offset = offset.max(0);
    let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Artifact> {
        let path: String = row.get(3)?;
        let exists_now = std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_file());
        Ok(Artifact {
            id: row.get(0)?,
            session_id: row.get(1)?,
            session_title: row.get(2)?,
            path,
            op: row.get(4)?,
            turn_id: row.get(5)?,
            tool_call_id: row.get(6)?,
            source: row.get(7)?,
            confidence: row.get(8)?,
            exists_after: row.get(9)?,
            exists_now,
            size_bytes: row.get(10)?,
            sha256: row.get(11)?,
            previous_path: row.get(12)?,
            turn_status: row.get(13)?,
            updated_at: ms_to_ts(row.get(14)?),
        })
    };
    let mut out = Vec::new();
    if let Some(session_id) = session_id {
        let mut stmt = db.conn().prepare_cached(
            "SELECT e.id, e.session_id, s.title, e.path, e.op, e.turn_id, e.tool_call_id, e.source, e.confidence, e.exists_after, e.size_bytes, e.sha256, e.previous_path, t.status, e.created_at
             FROM artifact_events e JOIN sessions s ON s.id=e.session_id LEFT JOIN turns t ON t.id=e.turn_id
             WHERE e.session_id=?1 AND (?3 IS NULL OR e.turn_id=?3)
             UNION ALL
             SELECT 'legacy:' || a.session_id || ':' || a.path, a.session_id, s.title, a.path, a.op, a.turn_id, NULL, 'legacy_index', 'unverified', 1, NULL, NULL, NULL, NULL, a.updated_at
             FROM artifacts a JOIN sessions s ON s.id=a.session_id WHERE a.session_id=?1 AND ?3 IS NULL
               AND NOT EXISTS (SELECT 1 FROM artifact_events e WHERE e.session_id=a.session_id AND e.path=a.path)
             ORDER BY 15 DESC, 1 DESC LIMIT ?2 OFFSET ?4",
        )?;
        let rows = stmt.query_map(params![session_id, limit, turn_id, offset], map_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    } else {
        let mut stmt = db.conn().prepare_cached(
            "SELECT e.id, e.session_id, s.title, e.path, e.op, e.turn_id, e.tool_call_id, e.source, e.confidence, e.exists_after, e.size_bytes, e.sha256, e.previous_path, t.status, e.created_at
             FROM artifact_events e JOIN sessions s ON s.id=e.session_id LEFT JOIN turns t ON t.id=e.turn_id
             WHERE (?2 IS NULL OR e.session_id=?2) AND (?3 IS NULL OR e.turn_id=?3)
             UNION ALL
             SELECT 'legacy:' || a.session_id || ':' || a.path, a.session_id, s.title, a.path, a.op, a.turn_id, NULL, 'legacy_index', 'unverified', 1, NULL, NULL, NULL, NULL, a.updated_at
             FROM artifacts a JOIN sessions s ON s.id=a.session_id WHERE (?2 IS NULL OR a.session_id=?2) AND ?3 IS NULL AND NOT EXISTS (SELECT 1 FROM artifact_events e WHERE e.session_id=a.session_id AND e.path=a.path)
             ORDER BY 15 DESC, 1 DESC LIMIT ?1 OFFSET ?4",
        )?;
        let rows = stmt.query_map(params![limit, session_id, turn_id, offset], map_row)?;
        out.extend(rows.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    Ok(out)
}

/// Count the rows represented by `list` without applying its display limit.
/// The count intentionally describes recorded change events (plus legacy
/// index entries), not unique current files.
pub fn count(db: &Database, session_id: Option<&str>, turn_id: Option<&str>) -> Result<usize> {
    let count: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM (
             SELECT e.id FROM artifact_events e
             WHERE (?1 IS NULL OR e.session_id=?1) AND (?2 IS NULL OR e.turn_id=?2)
             UNION ALL
             SELECT a.path FROM artifacts a
             WHERE (?1 IS NULL OR a.session_id=?1) AND ?2 IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM artifact_events e
                 WHERE e.session_id=a.session_id AND e.path=a.path
               )
         )",
        params![session_id, turn_id],
        |row| row.get(0),
    )?;
    Ok(count.max(0) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    #[test]
    fn record_keeps_turn_history_while_current_index_remains_session_scoped() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let other_session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        record(&db, &session.id, "/tmp/a.txt", "write", Some("turn-1")).unwrap();
        record(&db, &session.id, "/tmp/a.txt", "edit", None).unwrap();
        record(&db, &session.id, "/tmp/b.txt", "write", None).unwrap();
        record(&db, &other_session.id, "/tmp/other.txt", "write", None).unwrap();
        let all = list(&db, Some(&session.id), None, 50).unwrap();
        assert_eq!(all.len(), 3);
        let a = all
            .iter()
            .find(|x| x.path == "/tmp/a.txt" && x.op == "write")
            .unwrap();
        assert_eq!(a.op, "write");
        assert_eq!(a.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(list(&db, Some(&session.id), None, 50).unwrap().len(), 3);
        assert_eq!(
            list(&db, Some(&session.id), Some("turn-1"), 50)
                .unwrap()
                .len(),
            1
        );
        // Session-scoped listing does not expose another session's files.
        sessions::delete_session(&db, &session.id).unwrap();
        assert_eq!(list(&db, None, None, 50).unwrap().len(), 1);
        // Session delete cascades for the remaining session too.
        sessions::delete_session(&db, &other_session.id).unwrap();
        assert!(list(&db, None, None, 50).unwrap().is_empty());
    }

    #[test]
    fn workspace_diff_records_created_deleted_and_renamed_files_as_observed() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let root = std::env::temp_dir().join(format!("pi-artifact-diff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let old = root.join("old.txt");
        std::fs::write(&old, b"same-content").unwrap();
        let before = snapshot_workspace(&root).unwrap();
        std::fs::rename(&old, root.join("new.txt")).unwrap();
        std::fs::write(root.join("created.txt"), b"created").unwrap();
        let after = snapshot_workspace(&root).unwrap();
        record_workspace_diff(&db, &session.id, Some("turn-1"), "bash-1", &before, &after).unwrap();
        let listed = list(&db, Some(&session.id), Some("turn-1"), 50).unwrap();
        assert!(listed.iter().any(|entry| entry.op == "rename"
            && entry.previous_path.as_deref() == Some(old.to_string_lossy().as_ref())));
        assert!(listed.iter().any(|entry| entry.op == "create"
            && entry.source == "workspace_diff"
            && entry.confidence == "observed"));
        let mut before_delete = after;
        std::fs::remove_file(root.join("created.txt")).unwrap();
        let after_delete = snapshot_workspace(&root).unwrap();
        record_workspace_diff(
            &db,
            &session.id,
            Some("turn-2"),
            "bash-2",
            &before_delete,
            &after_delete,
        )
        .unwrap();
        let deleted = list(&db, Some(&session.id), Some("turn-2"), 50).unwrap();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].op, "delete");
        assert!(!deleted[0].exists_after);
        before_delete.clear();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn list_page_reports_full_event_count_and_paginates_audit_history() {
        let db = test_db();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let root = std::env::temp_dir().join(format!("pi-artifact-pages-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("deliverable.md");
        std::fs::write(&path, "deliverable").unwrap();
        record_observed(
            &db,
            &session.id,
            Some("turn-1"),
            Some("call-1"),
            &path,
            "create",
            "host_tool",
            "confirmed",
            None,
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        std::fs::remove_file(&path).unwrap();
        record_observed(
            &db,
            &session.id,
            Some("turn-1"),
            Some("call-2"),
            &path,
            "delete",
            "workspace_diff",
            "observed",
            None,
        )
        .unwrap();

        assert_eq!(count(&db, Some(&session.id), Some("turn-1")).unwrap(), 2);
        let first = list_page(&db, Some(&session.id), Some("turn-1"), 1, 0).unwrap();
        let second = list_page(&db, Some(&session.id), Some("turn-1"), 1, 1).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        let mut page_ops = vec![first[0].op.as_str(), second[0].op.as_str()];
        page_ops.sort_unstable();
        assert_eq!(page_ops, vec!["create", "delete"]);
        assert!(!first[0].exists_now && !second[0].exists_now);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn schema_v32_migrates_to_append_only_artifact_ledger() {
        let dir =
            std::env::temp_dir().join(format!("pi-artifact-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute_batch("DROP TABLE artifact_events; PRAGMA user_version=32;")
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::db::SCHEMA_VERSION);
        let exists: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_events')",
            [], |row| row.get(0),
        ).unwrap();
        assert!(exists);
        drop(db);
        let _ = std::fs::remove_dir_all(dir);
    }
}
