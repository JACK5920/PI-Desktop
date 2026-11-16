//! Every computer-use refusal, and the grant lifecycle that enforces them.
//!
//! The rules here are deliberately mechanical: a request carries no identity
//! the host trusts, so each one is re-checked against the live grant and a
//! fresh measurement of the target. Nothing in this file consults a permission
//! mode — the mode decides whether a grant may be minted and whether an input
//! step needs a card, and both of those happen before a request arrives here.

use std::thread;
use std::time::{Duration, Instant};

use super::backend::{Desktop, Measured, RawTarget};
use super::{
    ActResult, Action, ActionKind, Basis, CaptureMode, ComputerResult, Grant, GrantScope,
    GrantState, InputPolicy, Inspection, Node, Rect, Refusal, Target, TargetRefusal, MAX_NODES,
    MAX_TEXT_CHARS, MIN_IDLE_EXPIRY,
};

const TARGET_RESOLVE_ATTEMPTS: usize = 5;
const TARGET_RESOLVE_RETRY_DELAY: Duration = Duration::from_millis(100);

/// Application identifiers that may never be targeted, whatever the user
/// configures. These are credential surfaces: driving them with synthetic
/// input is indistinguishable from the user approving a secret release.
pub fn built_in_denylist() -> &'static [&'static str] {
    &[
        // macOS
        "com.apple.keychainaccess",
        "com.apple.SecurityAgent",
        "com.apple.systempreferences.securityagent",
        "com.apple.loginwindow",
        // Windows
        "credentialuibroker.exe",
        "consent.exe",
        "lsass.exe",
        "winlogon.exe",
        // Linux
        "polkit-gnome-authentication-agent-1",
        "gnome-keyring-prompt",
        "kwalletd5",
        "kwalletd6",
        "ksshaskpass",
        // Cross-platform password managers, by the names their windows expose.
        "1password",
        "com.1password.1password",
        "bitwarden",
        "com.bitwarden.desktop",
        "keepassxc",
        "org.keepassxc.keepassxc",
    ]
}

/// Application-level restrictions configured by the user.
#[derive(Debug, Clone, Copy)]
pub struct Restrictions {
    pub disable_all: bool,
    pub block_self_target: bool,
    pub block_secure_input: bool,
    pub enforce_denylist: bool,
    pub block_elevated_targets: bool,
}

impl Default for Restrictions {
    fn default() -> Self {
        Self {
            disable_all: false,
            block_self_target: true,
            block_secure_input: true,
            enforce_denylist: true,
            block_elevated_targets: true,
        }
    }
}

impl Restrictions {
    fn is_enabled(self, setting: bool) -> bool {
        !self.disable_all && setting
    }
}

/// Target policies combine the configured denylist with the user's switches.
#[derive(Debug, Clone)]
pub struct Denylist {
    user: Vec<String>,
    restrictions: Restrictions,
}

impl Default for Denylist {
    fn default() -> Self {
        Self::new(&[])
    }
}

impl Denylist {
    pub fn new(user_entries: &[String]) -> Self {
        Self::with_restrictions(user_entries, Restrictions::default())
    }

    pub fn with_restrictions(user_entries: &[String], restrictions: Restrictions) -> Self {
        Self {
            user: user_entries
                .iter()
                .map(|entry| entry.trim().to_ascii_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect(),
            restrictions,
        }
    }

    pub fn refuses(&self, app_key: &str, app_name: &str) -> bool {
        if !self
            .restrictions
            .is_enabled(self.restrictions.enforce_denylist)
        {
            return false;
        }
        let key = app_key.trim().to_ascii_lowercase();
        let name = app_name.trim().to_ascii_lowercase();
        let hits = |entry: &str| !entry.is_empty() && (key.contains(entry) || name.contains(entry));
        built_in_denylist().iter().any(|entry| hits(entry))
            || self.user.iter().any(|entry| hits(entry))
    }

    pub fn allows_sensitive_input(&self) -> bool {
        !self
            .restrictions
            .is_enabled(self.restrictions.block_secure_input)
    }
}

/// Our own bundle identifiers. `own_pid` is the real check; these catch helper
/// processes that run under a different pid but still draw our windows.
const SELF_APP_KEYS: &[&str] = &[
    "pi-desktop",
    "pi desktop",
    "com.pi-desktop",
    "pi-desktop-host-core",
];

/// Why this window cannot be picked, or `None` when it can.
///
/// Refusals follow the policy snapshot read from the user's settings.
pub fn refusal_for_target(
    raw: &RawTarget,
    self_pids: &[i32],
    denylist: &Denylist,
) -> Option<TargetRefusal> {
    if denylist
        .restrictions
        .is_enabled(denylist.restrictions.block_self_target)
        && self_pids.contains(&raw.target.pid)
    {
        return Some(TargetRefusal::SelfTarget);
    }
    let key = raw.target.app_key.trim().to_ascii_lowercase();
    if denylist
        .restrictions
        .is_enabled(denylist.restrictions.block_self_target)
        && SELF_APP_KEYS
            .iter()
            .any(|entry| key == *entry || key.starts_with(entry))
    {
        return Some(TargetRefusal::SelfTarget);
    }
    if denylist.refuses(&raw.target.app_key, &raw.app_name) {
        return Some(TargetRefusal::Denylisted);
    }
    if denylist
        .restrictions
        .is_enabled(denylist.restrictions.block_elevated_targets)
        && raw.elevated
    {
        return Some(TargetRefusal::Elevated);
    }
    None
}

/// Usable and refused targets, with reasons. Refused entries stay in the list
/// so a caller can explain itself instead of appearing to lose windows — the
/// loop shows them to the model as "this one is refused", which is how a
/// desktop grant avoids spending steps retrying a window it can never have.
pub fn list_targets(desktop: &dyn Desktop, denylist: &Denylist) -> ComputerResult<Vec<Target>> {
    let self_pids = desktop.self_pids();
    let raw = desktop.list_targets().map_err(Refusal::from)?;
    Ok(raw
        .into_iter()
        .map(|item| {
            let refused_reason = refusal_for_target(&item, &self_pids, denylist);
            Target {
                target_id: item.target.target_id.clone(),
                app_name: super::truncate_label(&item.app_name),
                title: super::truncate_label(&item.title),
                app_key: item.target.app_key.clone(),
                bounds: item.bounds,
                refused_reason,
            }
        })
        .collect())
}

pub struct GrantRequest {
    /// `None` mints a desktop-scope grant bound to the frontmost usable window
    /// (ADR 0350); `Some` pins that one window and refuses to move.
    pub target_id: Option<String>,
    pub session_id: String,
    pub input_policy: InputPolicy,
    pub capture: CaptureMode,
    pub action_budget: u64,
    pub idle_expiry: Duration,
}

/// Map a target refusal onto the request-level refusal that reports it.
fn refusal_error(reason: TargetRefusal) -> Refusal {
    match reason {
        TargetRefusal::SelfTarget => Refusal::SelfTargetRefused,
        TargetRefusal::Denylisted => Refusal::TargetDenylisted,
        TargetRefusal::Elevated => Refusal::TargetElevated,
        TargetRefusal::NoAccessibility => Refusal::OsPermissionMissing,
    }
}

/// The label a grant shows for the window it is bound to.
fn target_label(raw: &RawTarget) -> String {
    if raw.title.trim().is_empty() {
        super::truncate_label(&raw.app_name)
    } else {
        format!(
            "{} — {}",
            super::truncate_label(&raw.app_name),
            super::truncate_label(&raw.title)
        )
    }
}

/// Resolve one host-minted window id from a fresh enumeration. A transient
/// enumeration gap must not masquerade as an out-of-scope target, but retries
/// stay pinned to the requested id and never substitute another window.
fn find_target(desktop: &dyn Desktop, target_id: &str) -> ComputerResult<RawTarget> {
    let requested_pid = target_id.split_once(':').map(|(pid, _)| pid);
    let mut same_process_ids = Vec::<Vec<String>>::with_capacity(TARGET_RESOLVE_ATTEMPTS);
    let mut enumeration_errors = Vec::<String>::new();
    // Window enumeration and HWND revalidation can briefly disagree while a
    // window is activating. Retry the exact host-issued id for a bounded
    // interval; never substitute another window. A missing target is not a
    // scope violation: the grant's scope check is performed separately below.
    for attempt in 0..TARGET_RESOLVE_ATTEMPTS {
        match desktop.list_targets() {
            Ok(targets) => {
                same_process_ids.push(
                    targets
                        .iter()
                        .filter(|item| {
                            requested_pid.is_some_and(|pid| {
                                item.target.target_id.starts_with(&format!("{pid}:"))
                            })
                        })
                        .map(|item| item.target.target_id.clone())
                        .collect(),
                );
                if let Some(found) = targets
                    .into_iter()
                    .find(|item| item.target.target_id == target_id)
                {
                    return Ok(found);
                }
                // Some window managers briefly omit a still-live top-level
                // HWND from EnumWindows during activation. Ask the platform
                // backend to validate this exact previously observed ID
                // directly; it may not substitute another window.
                match desktop.resolve_target(target_id) {
                    Ok(Some(found)) if found.target.target_id == target_id => return Ok(found),
                    Ok(Some(found)) => tracing::warn!(
                        stage = "resolve-target-id-mismatch",
                        requested_target_id = target_id,
                        resolved_target_id = %found.target.target_id,
                        "backend returned a different target id; ignoring it"
                    ),
                    Ok(None) => {}
                    Err(
                        error @ (super::backend::DesktopError::Timeout
                        | super::backend::DesktopError::TargetGone
                        | super::backend::DesktopError::Failed(_)),
                    ) => enumeration_errors.push(format!(
                        "attempt {} direct resolution: {error:?}",
                        attempt + 1
                    )),
                    Err(error) => return Err(Refusal::from(error)),
                }
                if attempt + 1 < TARGET_RESOLVE_ATTEMPTS {
                    thread::sleep(TARGET_RESOLVE_RETRY_DELAY);
                }
            }
            Err(
                error @ (super::backend::DesktopError::Timeout
                | super::backend::DesktopError::TargetGone
                | super::backend::DesktopError::Failed(_)),
            ) => {
                enumeration_errors.push(format!("attempt {}: {error:?}", attempt + 1));
                if attempt + 1 < TARGET_RESOLVE_ATTEMPTS {
                    thread::sleep(TARGET_RESOLVE_RETRY_DELAY);
                }
            }
            Err(error) => return Err(Refusal::from(error)),
        }
    }
    tracing::warn!(
        stage = "resolve-target",
        target_id,
        attempts = TARGET_RESOLVE_ATTEMPTS,
        same_process_target_ids = ?same_process_ids,
        enumeration_errors = ?enumeration_errors,
        "computer-use target was not resolved"
    );
    Err(Refusal::TargetUnavailable)
}

/// The frontmost window this module does not refuse.
///
/// Backends enumerate front-to-back, so the first survivor is the window the
/// user is looking at. Our own windows and the denylist drop out here, which is
/// why "the frontmost window" can never be PI-Desktop's approval card even when
/// that is literally what is in front.
fn frontmost_usable(
    desktop: &dyn Desktop,
    self_pids: &[i32],
    denylist: &Denylist,
) -> ComputerResult<RawTarget> {
    let raw = desktop.list_targets().map_err(Refusal::from)?;
    let allowed = raw
        .into_iter()
        .filter(|item| refusal_for_target(item, self_pids, denylist).is_none())
        .collect::<Vec<_>>();
    // Do not mistake a shell/window-server root for a usable application.
    // `can_open` only proves UIA returned a root; an empty/single-node tree
    // cannot give the agent a real control to operate. Some Windows providers
    // time out briefly while another app is opening, so retry transient
    // inspection failures before concluding that no usable window exists.
    for item in &allowed {
        for attempt in 0..3 {
            match desktop.inspect_with_sensitive_input(
                &item.target,
                2,
                denylist.allows_sensitive_input(),
            ) {
                Ok(tree) if tree.nodes.len() > 1 => return Ok(item.clone()),
                Ok(_) => break, // A root-only tree is a stable, unusable target.
                Err(super::backend::DesktopError::SecureInputRefused) => {
                    return Err(Refusal::SecureInputRefused);
                }
                Err(
                    super::backend::DesktopError::Timeout
                    | super::backend::DesktopError::TargetGone
                    | super::backend::DesktopError::Failed(_),
                ) if attempt < 2 => thread::sleep(Duration::from_millis(35)),
                Err(_) => break,
            }
        }
    }
    if allowed.is_empty() {
        Err(Refusal::ScopeViolation)
    } else {
        Err(Refusal::TargetUnavailable)
    }
}

/// Mint the single active grant.
///
/// A `target_id` is re-resolved from a fresh enumeration here — never trusted
/// as a handle — so a stale or invented id cannot become authority over a
/// window that now belongs to something else. Without one, the grant covers the
/// desktop and starts bound to the frontmost usable window.
pub fn create_grant(
    desktop: &dyn Desktop,
    existing: Option<&Grant>,
    denylist: &Denylist,
    request: GrantRequest,
    now: Instant,
) -> ComputerResult<Grant> {
    if let Some(active) = existing {
        if active.state == GrantState::Active && !active.expired_at(now) {
            return Err(Refusal::GrantInUse);
        }
    }
    let self_pids = desktop.self_pids();
    let (scope, found) = match &request.target_id {
        Some(target_id) => {
            let found = find_target(desktop, target_id)?;
            if let Some(reason) = refusal_for_target(&found, &self_pids, denylist) {
                return Err(refusal_error(reason));
            }
            (GrantScope::Window, found)
        }
        None => (
            GrantScope::Desktop,
            frontmost_usable(desktop, &self_pids, denylist)?,
        ),
    };
    Ok(Grant {
        grant_id: format!("cug_{}", uuid::Uuid::new_v4().simple()),
        revision: 1,
        scope,
        target_label: target_label(&found),
        target: found.target,
        bounds: found.bounds,
        input_policy: request.input_policy,
        capture: request.capture,
        remaining_budget: request.action_budget.max(1),
        session_id: request.session_id,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_activity: now,
        idle_expiry: request.idle_expiry.max(MIN_IDLE_EXPIRY),
        state: GrantState::Active,
    })
}

/// Whether the agent may mint a grant for itself right now.
///
/// The grant is automatic (ADR 0350), so a user Stop that only revoked the
/// current grant would last exactly one tool call. It therefore holds for
/// `AGENT_REGRANT_COOLDOWN`: the agent's own retry is refused, while the user
/// asking again — a click in the desktop UI — is never blocked.
pub fn agent_mint_allowed(stopped_at: Option<Instant>, now: Instant) -> ComputerResult<()> {
    match stopped_at {
        Some(stopped) if now.duration_since(stopped) < super::AGENT_REGRANT_COOLDOWN => {
            Err(Refusal::StoppedByUser)
        }
        _ => Ok(()),
    }
}

/// Point a desktop-scope grant at another window.
///
/// Every refusal runs again against a fresh enumeration, so a rebind is exactly
/// as restricted as the original mint. The revision always moves, because every
/// `uid` and `basis` the caller holds describes the window it is leaving.
pub fn bind_target(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    denylist: &Denylist,
    target_id: &str,
) -> ComputerResult<()> {
    if grant.target.target_id == target_id {
        return Ok(());
    }
    if grant.scope != GrantScope::Desktop {
        // A window grant is the window it named. Moving it would turn the one
        // decision the caller made into a different one.
        return Err(Refusal::ScopeViolation);
    }
    let self_pids = desktop.self_pids();
    let found = find_target(desktop, target_id)?;
    if let Some(reason) = refusal_for_target(&found, &self_pids, denylist) {
        return Err(refusal_error(reason));
    }
    grant.revision = grant.revision.saturating_add(1);
    grant.target_label = target_label(&found);
    grant.target = found.target;
    grant.bounds = found.bounds;
    Ok(())
}

/// The grant a request may use, or the reason it may not.
pub fn usable_grant<'a>(
    grant: Option<&'a mut Grant>,
    grant_id: &str,
    session_id: Option<&str>,
    now: Instant,
) -> ComputerResult<&'a mut Grant> {
    let grant = grant.ok_or(Refusal::NoGrant)?;
    if grant.grant_id != grant_id {
        return Err(Refusal::NoGrant);
    }
    if grant.state != GrantState::Active {
        return Err(Refusal::GrantExpired);
    }
    if grant.expired_at(now) {
        grant.state = GrantState::Expired;
        return Err(Refusal::GrantExpired);
    }
    if let Some(session) = session_id {
        if grant.session_id != session {
            return Err(Refusal::GrantInUse);
        }
    }
    Ok(grant)
}

/// Re-measure the bound window and fold the result into the grant.
///
/// A window that moved or changed identity bumps the revision, which
/// invalidates every `uid` and `basis` the caller is holding. A window that is
/// gone ends a window-scope grant — there is nothing left that it describes —
/// while a desktop-scope grant falls back to the frontmost usable window,
/// through the same refusals, with the revision moved.
fn refresh(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    denylist: &Denylist,
    allow_desktop_rebind: bool,
) -> ComputerResult<Refreshed> {
    let measured = match desktop.measure(&grant.target) {
        Ok(measured) if measured.app_key == grant.target.app_key => measured,
        Ok(_) => {
            tracing::warn!(stage = "measure-target-identity", target_id = %grant.target.target_id, "computer-use target HWND now belongs to a different application");
            if grant.scope != GrantScope::Desktop || !allow_desktop_rebind {
                if grant.scope != GrantScope::Desktop {
                    grant.state = GrantState::Revoked;
                }
                return Err(Refusal::ScopeViolation);
            }
            let self_pids = desktop.self_pids();
            let found = frontmost_usable(desktop, &self_pids, denylist)?;
            grant.revision = grant.revision.saturating_add(1);
            grant.target_label = target_label(&found);
            grant.bounds = found.bounds;
            let measured = Measured {
                bounds: found.bounds,
                app_key: found.target.app_key.clone(),
                title: found.title.clone(),
            };
            grant.target = found.target;
            return Ok(Refreshed {
                measured,
                rebound: true,
            });
        }
        other => {
            // Either the window is gone, or its handle now belongs to a
            // different application: in both cases nothing the caller holds
            // still describes this window.
            if grant.scope != GrantScope::Desktop || !allow_desktop_rebind {
                if grant.scope != GrantScope::Desktop {
                    grant.state = GrantState::Revoked;
                }
                if let Err(error) = &other {
                    tracing::warn!(stage = "measure-target", target_id = %grant.target.target_id, error = ?error, "computer-use target could not be measured");
                }
                return Err(other
                    .err()
                    .map(Refusal::from)
                    .unwrap_or(Refusal::ScopeViolation));
            }
            let self_pids = desktop.self_pids();
            let found = frontmost_usable(desktop, &self_pids, denylist)?;
            grant.revision = grant.revision.saturating_add(1);
            grant.target_label = target_label(&found);
            grant.bounds = found.bounds;
            let measured = Measured {
                bounds: found.bounds,
                app_key: found.target.app_key.clone(),
                title: found.title.clone(),
            };
            grant.target = found.target;
            return Ok(Refreshed {
                measured,
                rebound: true,
            });
        }
    };
    if !grant.bounds.matches(&measured.bounds) {
        grant.revision = grant.revision.saturating_add(1);
        grant.bounds = measured.bounds;
    }
    Ok(Refreshed {
        measured,
        rebound: false,
    })
}

/// What a re-measurement did. `rebound` means the grant is now describing a
/// different window than the caller's request was built against.
struct Refreshed {
    measured: Measured,
    rebound: bool,
}

#[cfg(test)]
pub fn inspect(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    denylist: &Denylist,
    expected_revision: Option<u32>,
    now: Instant,
) -> ComputerResult<Inspection> {
    inspect_with_rebind(desktop, grant, denylist, expected_revision, now, true)
}

fn inspect_with_rebind(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    denylist: &Denylist,
    expected_revision: Option<u32>,
    now: Instant,
    allow_desktop_rebind: bool,
) -> ComputerResult<Inspection> {
    if denylist
        .restrictions
        .is_enabled(denylist.restrictions.block_secure_input)
        && desktop.secure_input_active()
    {
        return Err(Refusal::SecureInputRefused);
    }
    refresh(desktop, grant, denylist, allow_desktop_rebind)?;
    if let Some(expected) = expected_revision {
        if expected != grant.revision {
            return Err(Refusal::StaleRevision);
        }
    }
    let raw = desktop
        .inspect_with_sensitive_input(&grant.target, MAX_NODES, denylist.allows_sensitive_input())
        .map_err(|error| {
            tracing::warn!(stage = "inspect-target", target_id = %grant.target.target_id, error = ?error, "computer-use target inspection failed");
            Refusal::from(error)
        })?;
    grant.last_activity = now;
    // The tree the caller sees is the tree the host kept. When the host's own
    // node budget cut something away, the caller has to be told -- otherwise
    // it reads a list it believes is complete and concludes that an element
    // the window plainly shows does not exist.
    let total_nodes = raw.total_nodes;
    let nodes = bound_nodes(raw.nodes);
    let truncated = raw.truncated || nodes.len() < total_nodes;
    Ok(Inspection {
        grant_id: grant.grant_id.clone(),
        revision: grant.revision,
        bounds: grant.bounds,
        fidelity: raw.fidelity,
        nodes,
        truncated,
        secure_input: false,
    })
}

/// Bind a window if one was named, then inspect whatever is bound.
///
/// A failed inspection leaves the grant describing the window it already had:
/// the caller's request did not succeed, so the grant must not quietly end up
/// on a window nobody could read — the next `act` would then be aimed at a
/// window the caller never saw. The revision keeps the bump either way, so
/// nothing the caller is holding validates after a move it did not observe.
pub fn inspect_bound(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    denylist: &Denylist,
    target_id: Option<&str>,
    expected_revision: Option<u32>,
    now: Instant,
) -> ComputerResult<Inspection> {
    let restore = target_id.map(|_| {
        (
            grant.target.clone(),
            grant.target_label.clone(),
            grant.bounds,
        )
    });
    if let Some(target_id) = target_id {
        // A refused bind mutates nothing, so there is nothing to put back.
        bind_target(desktop, grant, denylist, target_id)?;
    }
    // A requested switch must inspect that exact window. The generic desktop
    // refresh path may rebind a stale desktop grant to a different frontmost
    // window, which would make a switch appear successful on the wrong app.
    let first = inspect_with_rebind(
        desktop,
        grant,
        denylist,
        expected_revision,
        now,
        target_id.is_none(),
    );
    let result = if matches!(
        &first,
        Err(Refusal::ScopeViolation | Refusal::TargetUnavailable)
    ) {
        if let Some(target_id) = target_id {
            let expected = grant.target.clone();
            let self_pids = desktop.self_pids();
            let still_same_target = find_target(desktop, target_id).ok().filter(|item| {
                item.target.pid == expected.pid
                    && item.target.app_key == expected.app_key
                    && refusal_for_target(item, &self_pids, denylist).is_none()
            });
            if let Some(found) = still_same_target {
                if !grant.bounds.matches(&found.bounds) {
                    grant.revision = grant.revision.saturating_add(1);
                }
                grant.target_label = target_label(&found);
                grant.target = found.target;
                grant.bounds = found.bounds;
                thread::sleep(TARGET_RESOLVE_RETRY_DELAY);
                tracing::info!(stage = "inspect-target-retry", target_id, "retrying inspection of the same validated window after a transient target failure");
                inspect_with_rebind(desktop, grant, denylist, None, now, false)
            } else {
                first
            }
        } else {
            first
        }
    } else {
        first
    };
    match result {
        Ok(inspection) => Ok(inspection),
        Err(refusal) => {
            if let Some((target, label, bounds)) = restore {
                grant.target = target;
                grant.target_label = label;
                grant.bounds = bounds;
            }
            Err(refusal)
        }
    }
}

/// Labels come from windows the user does not control, so they are bounded
/// here rather than trusted from a backend.
///
/// The node budget may not simply keep the head of the tree. A window with a
/// long sidebar or a long conversation puts hundreds of nodes in front of the
/// control the caller actually wants -- the composer of a chat window, for
/// instance, sits after the whole message history. Cutting the tail there
/// removes exactly the element the next step has to act on, so the run fails
/// with "no such element" while the window plainly shows it.
///
/// Keeping only the tail is just as wrong. The scope root is the node every
/// other node hangs off, and the ancestor chain of a kept tail node reaches
/// back to it. Dropping the head therefore breaks the tree the caller reads:
/// the surviving nodes have no root, and a caller that walks `parent` to
/// recognise a window finds nothing.
///
/// So the budget is spent by priority, not by position:
///
/// 1. the scope root and the ancestors of every kept node, because a node
///    without its chain describes no place;
/// 2. every control that can take content, because a composer that was cut
///    away leaves the caller with nothing it can type into;
/// 3. the remaining interactive controls, newest first, since a control the
///    user just used matters more than one from the top of the window;
/// 4. whatever is left goes to the newest content rows, because the tail of
///    a conversation is the part that is still about to change.
///
/// The kept indices are no longer contiguous, so `parent` is remapped onto
/// the new positions and the tree still describes itself.
fn bound_nodes(nodes: Vec<Node>) -> Vec<Node> {
    // A malformed tree can point a row at itself, at a later row, or in a
    // circle. The tree the caller reads has to stay acyclic: a node whose
    // parent chain never ends describes no place in the window, and a caller
    // that follows the chain can loop forever. So the parent links are
    // severed before anything else looks at them -- including the path that
    // does not need a cut at all.
    let mut nodes = nodes;
    for index in 0..nodes.len() {
        let mut seen = vec![false; nodes.len()];
        seen[index] = true;
        let mut cursor = nodes[index].parent;
        while let Some(parent) = cursor {
            if parent >= nodes.len() || seen[parent] {
                nodes[index].parent = None;
                break;
            }
            seen[parent] = true;
            cursor = nodes[parent].parent;
        }
    }

    if nodes.len() <= MAX_NODES {
        return truncate_labels(nodes);
    }

    // Ranked by how much a node must survive the cut.
    //
    // The scope root is the node nothing else hangs off; it is kept whatever
    // else happens, because it is the anchor the ancestor chains resolve to.
    let mut priority: Vec<(usize, u8)> = Vec::with_capacity(nodes.len());
    for (index, node) in nodes.iter().enumerate() {
        let rank = if node.parent.is_none() {
            0
        } else if node.actions.iter().any(|action| action.writes_content()) {
            1
        } else if node.actions.iter().any(|action| action.is_dispatchable()) {
            2
        } else {
            3
        };
        priority.push((index, rank));
    }

    // Within a rank the newer node wins: a control the user just used is more
    // relevant than one from the top of a long window, and the newest rows of
    // a conversation are the ones about to change.
    priority.sort_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)));

    // Every kept node needs its ancestor chain, or it hangs off a node that
    // is not in the tree: a node whose parent was cut describes no place in
    // the window, and the caller reads the tree to know where it is acting.
    //
    // So the ancestors are counted as part of the candidate's cost. A
    // candidate whose chain does not fit in the remaining budget is skipped
    // rather than taken and paid for afterwards -- taking it first and
    // adding the chain afterwards is what let the tree grow past the budget
    // (measured: 403 nodes returned for a 400-node budget).
    let mut chosen = vec![false; nodes.len()];
    let mut keep: Vec<usize> = Vec::with_capacity(MAX_NODES);
    for (index, _) in priority.iter() {
        if keep.len() >= MAX_NODES {
            break;
        }
        if chosen[*index] {
            continue;
        }
        // The chain this candidate needs, itself and its ancestors.
        //
        // The walk is bounded: a tree whose rows point at a later row, or at
        // themselves, would otherwise loop forever. The rows come from the
        // platform's own numbering, so a malformed one has to be survivable
        // rather than a panic.
        let mut chain: Vec<usize> = Vec::new();
        let mut cursor = Some(*index);
        while let Some(candidate) = cursor {
            if candidate >= nodes.len() || chosen[candidate] || chain.contains(&candidate) {
                break;
            }
            chain.push(candidate);
            cursor = nodes[candidate].parent;
        }
        if keep.len() + chain.len() > MAX_NODES {
            continue;
        }
        for candidate in &chain {
            chosen[*candidate] = true;
        }
        keep.extend(chain);
    }

    keep.sort_unstable();
    keep.dedup();
    // The kept indices are no longer contiguous, so `parent` has to be
    // remapped onto the new positions.
    let mut remap = vec![usize::MAX; nodes.len()];
    for (position, index) in keep.iter().enumerate() {
        remap[*index] = position;
    }
    let mut kept: Vec<Node> = keep
        .into_iter()
        .map(|index| {
            let mut node = nodes[index].clone();
            node.parent = node.parent.and_then(|parent| {
                // A parent row outside the tree cannot be remapped, and the
                // node then describes no place in the window. The rows come
                // from the platform's own numbering, so a malformed one has to
                // be survivable rather than a panic.
                let mapped = remap.get(parent).copied().unwrap_or(usize::MAX);
                if mapped == usize::MAX {
                    None
                } else {
                    Some(mapped)
                }
            });
            node
        })
        .collect();
    truncate_labels(std::mem::take(&mut kept))
}

fn truncate_labels(mut nodes: Vec<Node>) -> Vec<Node> {
    for node in &mut nodes {
        if let Some(label) = node.label.take() {
            node.label = Some(super::truncate_label(&label));
        }
        node.role = super::truncate_label(&node.role);
    }
    nodes
}

/// Validate one action against the live grant, without dispatching it.
///
/// Split out from `act` so the refusals can be tested without a platform and
/// so a caller that wants to pre-flight a step gets exactly the same verdict.
pub fn validate_action(
    grant: &Grant,
    action: &Action,
    measured_bounds: &Rect,
) -> ComputerResult<ActionKind> {
    let kind = action
        .kind
        .ok_or_else(|| Refusal::ActionRejected("missing action kind".into()))?;
    if kind.is_input() && grant.remaining_budget == 0 {
        return Err(Refusal::BudgetExhausted);
    }
    if action.uid.is_none() && action.point.is_none() {
        return Err(Refusal::ActionRejected(
            "action names neither an element nor a point".into(),
        ));
    }
    if let Some(uid) = &action.uid {
        if uid.trim().is_empty() || uid.len() > 256 {
            return Err(Refusal::ActionRejected("malformed element id".into()));
        }
    }
    if let Some(point) = action.point {
        let basis = action
            .basis
            .ok_or_else(|| Refusal::ActionRejected("coordinate action without a basis".into()))?;
        validate_basis(grant, &basis, measured_bounds)?;
        if !measured_bounds.contains(point.x, point.y) {
            return Err(Refusal::ScopeViolation);
        }
    }
    match kind {
        ActionKind::SetValue => {
            let text = action
                .text
                .as_deref()
                .ok_or_else(|| Refusal::ActionRejected("set_value without text".into()))?;
            if text.chars().count() > MAX_TEXT_CHARS {
                return Err(Refusal::ActionRejected(
                    "text exceeds the step limit".into(),
                ));
            }
        }
        ActionKind::TypeText => {
            let text = action
                .text
                .as_deref()
                .ok_or_else(|| Refusal::ActionRejected("type_text without text".into()))?;
            if text.chars().count() > MAX_TEXT_CHARS {
                return Err(Refusal::ActionRejected(
                    "text exceeds the step limit".into(),
                ));
            }
        }
        ActionKind::PressKeys => {
            let keys = action
                .keys
                .as_ref()
                .ok_or_else(|| Refusal::ActionRejected("press_keys without keys".into()))?;
            if keys.is_empty() || keys.len() > 16 {
                return Err(Refusal::ActionRejected(
                    "press_keys expects 1 to 16 chords".into(),
                ));
            }
            if keys
                .iter()
                .any(|chord| chord.trim().is_empty() || chord.len() > 64)
            {
                return Err(Refusal::ActionRejected("malformed key chord".into()));
            }
        }
        ActionKind::Select => {
            let option = action
                .option
                .as_deref()
                .ok_or_else(|| Refusal::ActionRejected("select without an option".into()))?;
            if option.trim().is_empty() || option.chars().count() > super::MAX_LABEL_CHARS {
                return Err(Refusal::ActionRejected("malformed select option".into()));
            }
        }
        ActionKind::Scroll => {
            let scroll = action
                .scroll
                .ok_or_else(|| Refusal::ActionRejected("scroll without a delta".into()))?;
            if !scroll.dx.is_finite() || !scroll.dy.is_finite() {
                return Err(Refusal::ActionRejected("non-finite scroll delta".into()));
            }
        }
        ActionKind::Drag => {
            let to = action
                .to
                .ok_or_else(|| Refusal::ActionRejected("drag without destination".into()))?;
            let basis = action
                .basis
                .ok_or_else(|| Refusal::ActionRejected("drag without a basis".into()))?;
            validate_basis(grant, &basis, measured_bounds)?;
            if !measured_bounds.contains(to.x, to.y) {
                return Err(Refusal::ScopeViolation);
            }
        }
        ActionKind::Click
        | ActionKind::DoubleClick
        | ActionKind::RightClick
        | ActionKind::Hover => {}
    }
    Ok(kind)
}

/// A basis is only as good as the geometry it was taken against: if the window
/// has moved since the capture, the coordinates in it now point somewhere else.
fn validate_basis(grant: &Grant, basis: &Basis, measured_bounds: &Rect) -> ComputerResult<()> {
    if basis.revision != grant.revision {
        return Err(Refusal::StaleRevision);
    }
    if !basis.bounds.matches(measured_bounds) {
        return Err(Refusal::StaleBasis);
    }
    Ok(())
}

/// Dispatch one action against the window the grant is bound to.
///
/// `act` never chooses a window: binding is `bind_target`'s job and happens on
/// an inspection. If the bound window vanished, the fallback inside `refresh`
/// moves the revision, so an action aimed at the old window fails closed
/// instead of landing on whatever is in front now.
pub fn act(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    denylist: &Denylist,
    expected_revision: Option<u32>,
    action: &Action,
    now: Instant,
) -> ComputerResult<ActResult> {
    if denylist
        .restrictions
        .is_enabled(denylist.restrictions.block_secure_input)
        && desktop.secure_input_active()
    {
        return Err(Refusal::SecureInputRefused);
    }
    let refreshed = refresh(desktop, grant, denylist, true)?;
    if refreshed.rebound {
        // A desktop grant whose window closed now describes another one. The
        // action was aimed at the window that is gone, so it is refused even if
        // the caller pinned no revision at all.
        return Err(Refusal::StaleRevision);
    }
    let measured = refreshed.measured;
    if let Some(expected) = expected_revision {
        if expected != grant.revision {
            return Err(Refusal::StaleRevision);
        }
    }
    let kind = validate_action(grant, action, &measured.bounds)?;
    let dispatched = desktop
        .perform_with_sensitive_input(
            &grant.target,
            action.uid.as_deref(),
            action,
            denylist.allows_sensitive_input(),
        )
        .map_err(Refusal::from)?;
    // The budget is spent on a dispatch that happened, not on an attempt that
    // was refused: a window that rejects every action must not silently burn
    // the grant, but a dispatched action always costs one.
    if kind.is_input() {
        grant.remaining_budget = grant.remaining_budget.saturating_sub(1);
    }
    grant.last_activity = now;
    if grant.remaining_budget == 0 {
        grant.state = GrantState::Expired;
    }
    // A content write is confirmed by reading the field back, because the
    // tree the caller reads never shows what a field holds. The comparison
    // happens inside the backend, so the content itself never leaves it.
    let verified = match (kind, action.text.as_deref()) {
        (ActionKind::SetValue | ActionKind::TypeText, Some(text)) => {
            desktop.confirm_write(&grant.target, action.uid.as_deref(), text)
        }
        _ => None,
    };
    Ok(ActResult {
        grant_id: grant.grant_id.clone(),
        revision: grant.revision,
        remaining_budget: grant.remaining_budget,
        dispatched,
        verified,
    })
}

pub fn revoke(grant: &mut Grant, expired: bool) {
    grant.state = if expired {
        GrantState::Expired
    } else {
        GrantState::Revoked
    };
    grant.remaining_budget = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(uid: &str, role: &str, actions: Vec<ActionKind>, parent: Option<usize>) -> Node {
        Node {
            uid: uid.to_string(),
            identity: Some(uid.to_string()),
            role: role.to_string(),
            label: Some(format!("label-{uid}")),
            has_value: actions.contains(&ActionKind::SetValue),
            enabled: true,
            focused: false,
            bounds: None,
            parent,
            actions,
        }
    }

    /// A window shaped like a real chat window: a scope root, a long run of
    /// message text, and the composer at the very end.
    fn chat_window(text_rows: usize) -> Vec<Node> {
        let mut nodes = vec![node("root", "document", vec![ActionKind::Scroll], None)];
        for index in 0..text_rows {
            nodes.push(node(
                &format!("text-{index}"),
                "text",
                vec![ActionKind::Scroll],
                Some(0),
            ));
        }
        // The composer: a group that holds the field and the buttons.
        let group = nodes.len();
        nodes.push(node("group", "group", vec![ActionKind::Click], Some(0)));
        nodes.push(node(
            "composer",
            "edit",
            vec![ActionKind::SetValue, ActionKind::TypeText],
            Some(group),
        ));
        nodes.push(node("send", "button", vec![ActionKind::Click], Some(group)));
        nodes
    }

    #[test]
    fn a_tree_that_fits_the_budget_is_returned_unchanged() {
        let nodes = chat_window(10);
        let kept = bound_nodes(nodes.clone());
        assert_eq!(kept.len(), nodes.len());
        assert_eq!(kept[0].uid, "root");
        assert_eq!(kept[kept.len() - 2].uid, "composer");
    }

    #[test]
    fn the_kept_tree_never_exceeds_the_budget() {
        // The ancestor chain is added when a node is kept, so a budget that is
        // applied before the chain is added is not a budget at all: the tree
        // grew past it. Measured on a Chromium chat window, 403 nodes came
        // back for a 400-node budget.
        //
        // The shape is drawn rather than written out: the bug needs a node
        // whose parent was not picked yet, and hand-writing a tree that
        // produces that reliably is what made this test pass while the bug
        // was still there.
        let mut seed: u64 = 0x5eed_1234_9abc_def0;
        let mut next = move || {
            // xorshift: a fixed sequence, so a failure is reproducible.
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for shape in 0..64 {
            let count = MAX_NODES + 40;
            let mut nodes: Vec<Node> = Vec::with_capacity(count);
            nodes.push(node("root", "document", vec![ActionKind::Scroll], None));
            for index in 0..count {
                // The parent is an earlier row most of the time, but not
                // always: a row whose parent comes later is ordinary in a real
                // tree, and it is what makes the chain cost something.
                let parent = if next() % 4 == 0 {
                    None
                } else if next() % 2 == 0 {
                    Some(index + 1 + (next() % 8) as usize)
                } else {
                    Some((next() % (index.max(1) as u64)) as usize)
                };
                let role = match next() % 4 {
                    0 => "button",
                    1 => "text",
                    2 => "group",
                    _ => "edit",
                };
                let actions = match role {
                    "button" => vec![ActionKind::Click],
                    "text" => vec![ActionKind::Scroll],
                    "group" => vec![ActionKind::Scroll],
                    _ => vec![ActionKind::SetValue, ActionKind::TypeText],
                };
                nodes.push(node(&format!("n-{index}"), role, actions, parent));
            }
            let kept = bound_nodes(nodes);
            assert!(
                kept.len() <= MAX_NODES,
                "shape {shape}: the tree grew past the budget: {} nodes",
                kept.len()
            );
        }
    }

    #[test]
    fn a_cyclic_parent_chain_is_cut() {
        // The rows come from the platform's own numbering, so a malformed one
        // has to be survivable. A tree whose parent chain never ends describes
        // no place in the window, and a caller that follows the chain can loop
        // forever.
        let mut nodes = vec![
            node("root", "document", vec![ActionKind::Scroll], None),
            node("a", "group", vec![ActionKind::Scroll], Some(2)),
            node("b", "group", vec![ActionKind::Scroll], Some(1)),
        ];
        // A row that points at itself.
        nodes.push(node("self", "group", vec![ActionKind::Scroll], Some(3)));
        // A row that points past the end of the tree.
        nodes.push(node("forward", "group", vec![ActionKind::Scroll], Some(99)));

        let kept = bound_nodes(nodes);

        // Every kept node's chain has to end, and no chain may repeat.
        for node in &kept {
            let mut seen = vec![false; kept.len()];
            let mut cursor = node.parent;
            while let Some(parent) = cursor {
                assert!(
                    parent < kept.len(),
                    "the parent index is out of range: {parent} of {}",
                    kept.len()
                );
                assert!(!seen[parent], "the parent chain loops at {parent}");
                seen[parent] = true;
                cursor = kept[parent].parent;
            }
        }
    }

    #[test]
    fn the_budget_keeps_the_scope_root() {
        // The root is the node every other node hangs off. Dropping it leaves
        // the caller with a tree that describes no place in the window.
        let nodes = chat_window(MAX_NODES + 200);
        let kept = bound_nodes(nodes);
        assert_eq!(kept[0].uid, "root");
        assert!(
            kept[0].parent.is_none(),
            "the scope root must not gain a parent"
        );
    }

    #[test]
    fn the_budget_keeps_the_composer_and_its_ancestors() {
        // The composer sits behind the whole message history. A budget that
        // only kept the head of the tree cut it away, and the run then failed
        // with "no such element" while the window plainly showed it.
        let nodes = chat_window(MAX_NODES + 200);
        let kept = bound_nodes(nodes);
        let composer = kept
            .iter()
            .find(|node| node.uid == "composer")
            .expect("the composer must survive the cut");
        assert!(composer.actions.contains(&ActionKind::SetValue));
        // Its parent has to be in the tree as well, and the parent index has
        // to point at it after the remap.
        let parent = composer.parent.expect("a kept node keeps its parent");
        assert_eq!(kept[parent].uid, "group");
        assert_eq!(kept[kept[parent].parent.unwrap()].uid, "root");
    }

    #[test]
    fn every_kept_node_keeps_a_parent_that_is_also_kept() {
        // `parent` is an index into this very list, so a node whose parent was
        // cut describes no place in the window.
        let nodes = chat_window(MAX_NODES + 200);
        let kept = bound_nodes(nodes);
        for (index, node) in kept.iter().enumerate() {
            if let Some(parent) = node.parent {
                assert!(
                    parent < index,
                    "a parent must come before its child: {node:?}"
                );
                assert!(
                    parent < kept.len(),
                    "the parent index must stay inside the list: {node:?}"
                );
            }
        }
    }

    #[test]
    fn the_budget_never_returns_more_than_the_budget() {
        let nodes = chat_window(MAX_NODES * 3);
        let kept = bound_nodes(nodes);
        assert!(kept.len() <= MAX_NODES, "kept {} nodes", kept.len());
    }

    #[test]
    fn a_write_capable_control_outranks_a_read_only_row() {
        // A read-only label and a text field can sit next to each other. The
        // field is what the caller has to act on, so it survives the cut and
        // the label does not have to.
        let mut nodes = vec![node("root", "document", vec![ActionKind::Scroll], None)];
        for index in 0..(MAX_NODES + 50) {
            nodes.push(node(
                &format!("text-{index}"),
                "text",
                vec![ActionKind::Scroll],
                Some(0),
            ));
        }
        let group = nodes.len();
        nodes.push(node("group", "group", vec![ActionKind::Click], Some(0)));
        nodes.push(node(
            "field",
            "edit",
            vec![ActionKind::SetValue, ActionKind::TypeText],
            Some(group),
        ));
        let kept = bound_nodes(nodes);
        assert!(
            kept.iter().any(|node| node.uid == "field"),
            "the writable field must survive the cut"
        );
    }
}
