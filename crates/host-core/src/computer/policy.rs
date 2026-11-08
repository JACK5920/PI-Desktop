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
    Ok(Inspection {
        grant_id: grant.grant_id.clone(),
        revision: grant.revision,
        bounds: grant.bounds,
        fidelity: raw.fidelity,
        nodes: bound_nodes(raw.nodes),
        truncated: raw.truncated,
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
fn bound_nodes(nodes: Vec<Node>) -> Vec<Node> {
    nodes
        .into_iter()
        .take(MAX_NODES)
        .map(|mut node| {
            node.label = node.label.map(|label| super::truncate_label(&label));
            node.role = super::truncate_label(&node.role);
            node
        })
        .collect()
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
    Ok(ActResult {
        grant_id: grant.grant_id.clone(),
        revision: grant.revision,
        remaining_budget: grant.remaining_budget,
        dispatched,
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
