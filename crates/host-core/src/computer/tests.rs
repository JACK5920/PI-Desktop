//! Refusal coverage for computer use. These are the tests ADR 0349 names as
//! landing gates, and they run on every platform because the fake backend
//! stands in for the native one: the rules being checked are policy's, not the
//! platform's.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::backend::{
    Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef,
};
use super::policy::{self, Denylist, GrantRequest};
use super::{
    Action, ActionKind, Basis, Capabilities, CaptureMode, Fidelity, Grant, GrantState, InputPolicy,
    Node, PermissionState, Point, Rect, Refusal, Scroll,
};

const OWN_PID: i32 = 4_242;

#[test]
fn pointer_drag_target_check_includes_mouse_down_origin_and_every_move() {
    let target_bounds = Rect {
        x: 100.0,
        y: 50.0,
        width: 300.0,
        height: 200.0,
    };
    let origin = Point { x: 140.0, y: 85.0 };
    let movement = [Point { x: 250.0, y: 120.0 }];
    let mut visited = Vec::new();
    assert!(!super::pointer_drag_points_stay_in_target(
        target_bounds,
        origin,
        &movement,
        |point| {
            visited.push(point);
            point != origin
        },
    ));
    assert_eq!(
        visited,
        vec![origin],
        "refuse before checking or dispatching movement when the mouse-down target is covered"
    );

    visited.clear();
    assert!(super::pointer_drag_points_stay_in_target(
        target_bounds,
        origin,
        &movement,
        |point| {
            visited.push(point);
            true
        },
    ));
    assert_eq!(visited, vec![origin, movement[0]]);
}

#[cfg(target_os = "windows")]
#[derive(Default, Debug)]
struct WindowsTargetTrialStats {
    attempts: usize,
    first_attempt_failures: usize,
    recovered_within_100ms: usize,
    unrecovered: usize,
    late_recoveries: usize,
    target_mismatches: usize,
}

#[cfg(target_os = "windows")]
fn same_process_target_ids(desktop: &dyn Desktop, target_id: &str) -> Vec<String> {
    let Some((pid, _)) = target_id.split_once(':') else {
        return Vec::new();
    };
    desktop
        .list_targets()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.target.target_id.starts_with(&format!("{pid}:")))
        .map(|item| item.target.target_id)
        .collect()
}

#[cfg(target_os = "windows")]
fn fixture_pinned_grant(
    desktop: &dyn Desktop,
    target_id: &str,
    session_id: String,
) -> Result<super::Grant, Refusal> {
    policy::create_grant(
        desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some(target_id.to_owned()),
            session_id,
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
}

#[cfg(target_os = "windows")]
fn record_pinned_grant_with_retry(
    desktop: &dyn Desktop,
    target_id: &str,
    phase: &str,
    trial: usize,
    stats: &mut WindowsTargetTrialStats,
) -> Option<super::Grant> {
    stats.attempts += 1;
    match fixture_pinned_grant(
        desktop,
        target_id,
        format!("computer-target-{phase}-{trial}"),
    ) {
        Ok(grant) if grant.target.target_id == target_id => Some(grant),
        first => {
            stats.first_attempt_failures += 1;
            let same_process_target_ids = same_process_target_ids(desktop, target_id);
            let first_error = match first {
                Ok(mut grant) => {
                    stats.target_mismatches += 1;
                    policy::revoke(&mut grant, false);
                    "grant returned success for a different target id".to_owned()
                }
                Err(error) => format!("{error:?}"),
            };
            let retry_started = Instant::now();
            match fixture_pinned_grant(
                desktop,
                target_id,
                format!("computer-target-{phase}-{trial}-retry"),
            ) {
                Ok(grant) if grant.target.target_id == target_id => {
                    let recovery_ms = retry_started.elapsed().as_millis();
                    if recovery_ms <= 100 {
                        stats.recovered_within_100ms += 1;
                    } else {
                        stats.late_recoveries += 1;
                    }
                    eprintln!(
                        "COMPUTER_USE_TARGET_RETRY {}",
                        serde_json::json!({
                            "phase": phase,
                            "trial": trial,
                            "firstError": first_error,
                            "sameProcessTargetIds": same_process_target_ids,
                            "recoveryMs": recovery_ms,
                        })
                    );
                    Some(grant)
                }
                retry => {
                    stats.unrecovered += 1;
                    let retry_error = format!("{retry:?}");
                    if let Ok(mut grant) = retry {
                        stats.target_mismatches += 1;
                        policy::revoke(&mut grant, false);
                    }
                    eprintln!(
                        "COMPUTER_USE_TARGET_FAILURE {}",
                        serde_json::json!({
                            "phase": phase,
                            "trial": trial,
                            "firstError": first_error,
                            "retryError": retry_error,
                            "sameProcessTargetIds": same_process_target_ids,
                        })
                    );
                    None
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn record_bind_with_retry(
    desktop: &dyn Desktop,
    grant: &mut super::Grant,
    target_id: &str,
    phase: &str,
    trial: usize,
    stats: &mut WindowsTargetTrialStats,
) -> bool {
    stats.attempts += 1;
    match policy::bind_target(desktop, grant, &Denylist::default(), target_id) {
        Ok(()) if grant.target.target_id == target_id => true,
        first => {
            stats.first_attempt_failures += 1;
            let same_process_target_ids = same_process_target_ids(desktop, target_id);
            let first_error = match first {
                Ok(()) => {
                    stats.target_mismatches += 1;
                    "bind returned success for a different target id".to_owned()
                }
                Err(error) => format!("{error:?}"),
            };
            let retry_started = Instant::now();
            match policy::bind_target(desktop, grant, &Denylist::default(), target_id) {
                Ok(()) if grant.target.target_id == target_id => {
                    let recovery_ms = retry_started.elapsed().as_millis();
                    if recovery_ms <= 100 {
                        stats.recovered_within_100ms += 1;
                    } else {
                        stats.late_recoveries += 1;
                    }
                    eprintln!(
                        "COMPUTER_USE_TARGET_RETRY {}",
                        serde_json::json!({
                            "phase": phase,
                            "trial": trial,
                            "firstError": first_error,
                            "sameProcessTargetIds": same_process_target_ids,
                            "recoveryMs": recovery_ms,
                        })
                    );
                    true
                }
                retry => {
                    stats.unrecovered += 1;
                    if matches!(retry, Ok(())) {
                        stats.target_mismatches += 1;
                    }
                    eprintln!(
                        "COMPUTER_USE_TARGET_FAILURE {}",
                        serde_json::json!({
                            "phase": phase,
                            "trial": trial,
                            "firstError": first_error,
                            "retryError": format!("{retry:?}"),
                            "sameProcessTargetIds": same_process_target_ids,
                        })
                    );
                    false
                }
            }
        }
    }
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn node(uid: &str, role: &str, actions: Vec<ActionKind>) -> Node {
    Node {
        uid: uid.into(),
        role: role.into(),
        label: Some("Save".into()),
        has_value: false,
        enabled: true,
        focused: false,
        bounds: Some(rect(10.0, 20.0, 80.0, 24.0)),
        parent: None,
        actions,
    }
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires interactive Windows UIA device acceptance"]
fn windows_backend_drives_only_the_isolated_fixture_window() {
    use std::fs;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use std::thread;
    use std::time::SystemTime;

    let _ = tracing_subscriber::fmt()
        .with_test_writer()
        .with_max_level(tracing::Level::DEBUG)
        .try_init();

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock is after the Unix epoch")
        .as_nanos();
    let suffix = format!("{}-{nonce}", std::process::id());
    let title = format!("PI-CU-FIXTURE-{suffix}");
    let secondary_title = format!("PI-CU-SECONDARY-{suffix}");
    // Keep fixture artifacts inside this checkout's build output rather than
    // creating another project/temp directory elsewhere on the machine.
    let fixture_dir = std::env::current_exe()
        .expect("test executable path")
        .parent()
        .expect("test executable directory")
        .to_path_buf();
    let script_path = fixture_dir.join(format!("{title}.ps1"));
    let secondary_script_path = fixture_dir.join(format!("{secondary_title}.ps1"));
    let state_path = fixture_dir.join(format!("{title}.txt"));
    let state_path_display = state_path.display().to_string();
    let focus_command_path = fixture_dir.join(format!("{title}-focus-command.txt"));
    let focus_command_path_display = focus_command_path.display().to_string();
    let focus_state_path = fixture_dir.join(format!("{title}-focus-state.txt"));
    let focus_state_path_display = focus_state_path.display().to_string();
    let pointer_state_path = fixture_dir.join(format!("{title}-pointer.txt"));
    let pointer_state_path_display = pointer_state_path.display().to_string();
    let double_click_state_path = fixture_dir.join(format!("{title}-double-click.txt"));
    let double_click_state_path_display = double_click_state_path.display().to_string();
    let scroll_state_path = fixture_dir.join(format!("{title}-scroll.txt"));
    let scroll_state_path_display = scroll_state_path.display().to_string();
    let combo_state_path = fixture_dir.join(format!("{title}-combo.txt"));
    let combo_state_display = combo_state_path.display().to_string();
    let list_state_path = fixture_dir.join(format!("{title}-list.txt"));
    let list_state_display = list_state_path.display().to_string();
    let script = format!(
        r#"Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = '{title}'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(520, 340)
$label = New-Object System.Windows.Forms.Label
$label.Name = 'FixtureStatus'
$label.Text = 'CU-FIXTURE-IDLE'
$label.Location = New-Object System.Drawing.Point(16, 18)
$label.AutoSize = $true
$hoverTarget = New-Object System.Windows.Forms.Label
$hoverTarget.Name = 'FixtureHover'
$hoverTarget.AccessibleName = 'CU-FIXTURE-HOVER'
$hoverTarget.Text = 'Hover target'
$hoverTarget.Location = New-Object System.Drawing.Point(220, 18)
$hoverTarget.AutoSize = $true
$hoverTarget.add_MouseEnter({{ [System.IO.File]::WriteAllText('{pointer_state_path_display}', 'hover') }})
$hoverTarget.add_MouseUp({{ param($sender, $event); if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Right) {{ [System.IO.File]::WriteAllText('{pointer_state_path_display}', 'right-click') }} }})
$button = New-Object System.Windows.Forms.Button
$button.Name = 'FixtureAction'
$button.AccessibleName = 'CU-FIXTURE-ACTION'
$button.Text = 'Run fixture action'
$button.Location = New-Object System.Drawing.Point(16, 56)
$button.add_Click({{ $label.Text = 'CU-FIXTURE-CLICKED' }})
$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Name = 'FixtureText'
$textBox.AccessibleName = 'CU-FIXTURE-EDIT'
$textBox.Location = New-Object System.Drawing.Point(16, 100)
$textBox.Width = 300
$textBox.add_TextChanged({{ [System.IO.File]::WriteAllText('{state_path_display}', $textBox.Text) }})
$secureTextBox = New-Object System.Windows.Forms.TextBox
$secureTextBox.Name = 'FixtureSecureText'
$secureTextBox.AccessibleName = 'CU-FIXTURE-SECURE'
$secureTextBox.UseSystemPasswordChar = $true
$secureTextBox.Location = New-Object System.Drawing.Point(340, 146)
$secureTextBox.Width = 140
$focusTimer = New-Object System.Windows.Forms.Timer
$focusTimer.Interval = 50
$focusTimer.add_Tick({{
    if ([System.IO.File]::Exists('{focus_command_path_display}')) {{
        $command = [System.IO.File]::ReadAllText('{focus_command_path_display}')
        [System.IO.File]::Delete('{focus_command_path_display}')
        $form.Activate()
        if ($command -eq 'secure') {{ $focused = $secureTextBox.Focus() }} else {{ $focused = $textBox.Focus() }}
        [System.IO.File]::WriteAllText('{focus_state_path_display}', "$($command):$focused")
    }}
}})
$focusTimer.Start()
$combo = New-Object System.Windows.Forms.ComboBox
$combo.Name = 'FixtureCombo'
$combo.AccessibleName = 'CU-FIXTURE-COMBO'
$combo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
[void]$combo.Items.Add('One')
[void]$combo.Items.Add('Two')
[void]$combo.Items.Add('Three')
$combo.SelectedIndex = 0
$combo.Location = New-Object System.Drawing.Point(16, 140)
$combo.add_SelectedIndexChanged({{ [System.IO.File]::WriteAllText('{combo_state_display}', $combo.SelectedItem) }})
$comboTimer = New-Object System.Windows.Forms.Timer
$comboTimer.Interval = 50
$comboTimer.add_Tick({{ [System.IO.File]::WriteAllText('{combo_state_display}', $combo.SelectedItem) }})
$comboTimer.Start()
$list = New-Object System.Windows.Forms.ListBox
$list.Name = 'FixtureList'
$list.AccessibleName = 'CU-FIXTURE-LIST'
$list.Location = New-Object System.Drawing.Point(340, 18)
$list.Size = New-Object System.Drawing.Size(140, 120)
[void]$list.Items.Add('Alpha')
[void]$list.Items.Add('Gamma')
[void]$list.Items.Add('Epsilon')
$list.SelectedIndex = 0
$list.add_SelectedIndexChanged({{ [System.IO.File]::WriteAllText('{list_state_display}', $list.SelectedItem) }})
$doubleClickList = New-Object System.Windows.Forms.ListView
$doubleClickList.Name = 'FixtureDoubleClickList'
$doubleClickList.AccessibleName = 'CU-FIXTURE-DOUBLECLICK-LIST'
$doubleClickList.View = [System.Windows.Forms.View]::List
$doubleClickList.Location = New-Object System.Drawing.Point(220, 56)
$doubleClickList.Size = New-Object System.Drawing.Size(100, 24)
$doubleClickItem = New-Object System.Windows.Forms.ListViewItem('CU-FIXTURE-DOUBLE-ACTIVATE')
[void]$doubleClickList.Items.Add($doubleClickItem)
$script:doubleClickActivations = 0
[System.IO.File]::WriteAllText('{double_click_state_path_display}', '0')
$doubleClickList.add_ItemActivate({{
    $script:doubleClickActivations++
    [System.IO.File]::WriteAllText('{double_click_state_path_display}', [string]$script:doubleClickActivations)
}})
$scrollPanel = New-Object System.Windows.Forms.Panel
$scrollPanel.Name = 'FixtureScroll'
$scrollPanel.AccessibleName = 'CU-FIXTURE-SCROLL'
$scrollPanel.Location = New-Object System.Drawing.Point(16, 180)
$scrollPanel.Size = New-Object System.Drawing.Size(300, 100)
$scrollPanel.AutoScroll = $true
for ($i = 0; $i -lt 12; $i++) {{
    $scrollLabel = New-Object System.Windows.Forms.Label
    $scrollLabel.Text = "Scroll row $i"
    $scrollLabel.Location = New-Object System.Drawing.Point(4, ($i * 24))
    $scrollLabel.AutoSize = $true
    $scrollPanel.Controls.Add($scrollLabel)
}}
$scrollPanel.add_Scroll({{ [System.IO.File]::WriteAllText('{scroll_state_path_display}', [string]$scrollPanel.VerticalScroll.Value) }})
$dragTarget = New-Object System.Windows.Forms.Panel
$dragTarget.Name = 'FixtureDrag'
$dragTarget.AccessibleName = 'CU-FIXTURE-DRAG'
$dragTarget.Location = New-Object System.Drawing.Point(340, 180)
$dragTarget.Size = New-Object System.Drawing.Size(140, 100)
$dragTarget.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
$script:fixtureDragging = $false
$script:fixtureDragMoved = $false
$dragTarget.add_MouseDown({{ param($sender, $event); if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {{ $script:fixtureDragging = $true; $script:fixtureDragMoved = $false }} }})
$dragTarget.add_MouseMove({{ param($sender, $event); if ($script:fixtureDragging) {{ $script:fixtureDragMoved = $true }} }})
$dragTarget.add_MouseUp({{ param($sender, $event); $script:fixtureDragging = $false; [System.IO.File]::WriteAllText('{pointer_state_path_display}', "drag-end:$script:fixtureDragMoved") }})
$form.add_Shown({{ $form.Activate(); $button.Focus() | Out-Null }})
$form.Controls.Add($label)
$form.Controls.Add($hoverTarget)
$form.Controls.Add($button)
$form.Controls.Add($textBox)
$form.Controls.Add($secureTextBox)
$form.Controls.Add($combo)
$form.Controls.Add($list)
$form.Controls.Add($doubleClickList)
$form.Controls.Add($scrollPanel)
$form.Controls.Add($dragTarget)
[System.Windows.Forms.Application]::Run($form)
"#
    );
    fs::write(&script_path, script).expect("write isolated fixture application script");
    fs::write(
        &secondary_script_path,
        format!(
            r#"Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = '{secondary_title}'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(320, 180)
[System.Windows.Forms.Application]::Run($form)
"#
        ),
    )
    .expect("write isolated secondary-window fixture script");
    let mut child: Child = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script_path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("start isolated Windows Forms fixture");
    let mut secondary_child: Option<Child> = None;

    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let desktop = super::backend::active();
        let capabilities = desktop.capabilities();
        assert_eq!(capabilities.platform, "win32");
        assert_eq!(capabilities.backend, "windows-uia");

        let deadline = Instant::now() + Duration::from_secs(10);
        let target = loop {
            let targets = desktop.list_targets().expect("enumerate desktop windows");
            if let Some(target) = targets.into_iter().find(|target| target.title == title) {
                break target;
            }
            assert!(
                Instant::now() < deadline,
                "fixture window did not appear: {title}"
            );
            thread::sleep(Duration::from_millis(50));
        };
        let canonical_target_id = target.target.target_id.clone();
        for attempt in 0..50 {
            assert!(
                desktop
                    .resolve_target(&canonical_target_id)
                    .unwrap_or_else(|error| {
                        panic!("resolve exact fixture target on attempt {attempt}: {error:?}")
                    })
                    .is_some(),
                "a live fixture window must resolve from its exact host-issued id"
            );
        }
        let display_label = format!(
            "{canonical_target_id} {} — {}",
            target.app_name, target.title
        );
        assert!(
            desktop
                .resolve_target(&display_label)
                .expect("reject a UI label passed as a target id")
                .is_none(),
            "app name and title must never be accepted as part of a target id"
        );

        // Add and remove another independent process while the original
        // target remains live. Its exact host-issued id must stay resolvable;
        // enumeration churn must not redirect it to the new foreground window.
        secondary_child = Some(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&secondary_script_path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("start isolated secondary-window fixture"),
        );
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let targets = desktop
                .list_targets()
                .expect("enumerate windows with second process");
            if targets
                .iter()
                .any(|candidate| candidate.title == secondary_title)
            {
                assert!(
                    targets.iter().any(|candidate| candidate.target.target_id == canonical_target_id),
                    "the original target must remain in enumeration while another fixture process starts"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "secondary fixture did not appear: {secondary_title}"
            );
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            desktop
                .resolve_target(&canonical_target_id)
                .expect("resolve original id while second process is live")
                .map(|resolved| resolved.target.target_id),
            Some(canonical_target_id.clone()),
            "starting another process must not substitute the foreground window for the exact target"
        );
        let mut secondary = secondary_child
            .take()
            .expect("secondary fixture process handle");
        let _ = secondary.kill();
        let _ = secondary.wait();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let targets = desktop
                .list_targets()
                .expect("enumerate windows after second process exits");
            if !targets
                .iter()
                .any(|candidate| candidate.title == secondary_title)
            {
                assert!(
                    desktop
                        .resolve_target(&canonical_target_id)
                        .expect("resolve original id after second process exits")
                        .is_some(),
                    "the original target must remain resolvable after unrelated window removal"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "secondary fixture remained after its process exited"
            );
            thread::sleep(Duration::from_millis(50));
        }
        let inspection = desktop
            .inspect(&target.target, 400)
            .expect("inspect isolated fixture UIA tree");
        let button = inspection
            .nodes
            .iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-ACTION"))
            .expect("UIA should expose only the fixture action by its accessible name");
        assert!(button.actions.contains(&ActionKind::Click));

        // Exercise the real Windows secure-input guard against an isolated
        // Password TextBox, then verify that it clears after focus returns to
        // an ordinary field. No password content is entered or read.
        fs::write(&focus_command_path, "secure").expect("request secure-field focus");
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&focus_state_path).ok().as_deref() != Some("secure:True") {
            assert!(
                Instant::now() < deadline,
                "isolated secure fixture field did not receive focus"
            );
            thread::sleep(Duration::from_millis(25));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while !desktop.secure_input_active() {
            assert!(
                Instant::now() < deadline,
                "focused password field was not detected by the secure-input guard"
            );
            thread::sleep(Duration::from_millis(25));
        }
        fs::write(&focus_command_path, "normal").expect("request ordinary-field focus");
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&focus_state_path).ok().as_deref() != Some("normal:True") {
            assert!(
                Instant::now() < deadline,
                "ordinary fixture field did not regain focus"
            );
            thread::sleep(Duration::from_millis(25));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while desktop.secure_input_active() {
            assert!(
                Instant::now() < deadline,
                "secure-input guard remained active after focus left the password field"
            );
            thread::sleep(Duration::from_millis(25));
        }

        desktop
            .perform(
                &target.target,
                Some(&button.uid),
                &Action {
                    kind: Some(ActionKind::Click),
                    ..Action::default()
                },
            )
            .expect("invoke the action through the fixture window's UIA pattern");

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let inspection = desktop
                .inspect(&target.target, 400)
                .expect("re-inspect fixture after action");
            if inspection
                .nodes
                .iter()
                .any(|item| item.label.as_deref() == Some("CU-FIXTURE-CLICKED"))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fixture action did not update its label"
            );
            thread::sleep(Duration::from_millis(50));
        }

        // Exercise the native mouse-event fallbacks and verify observable
        // state changes instead of treating a successful dispatch as proof.
        let pointer_target = desktop
            .inspect(&target.target, 400)
            .expect("inspect pointer-action fixture")
            .nodes
            .into_iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-HOVER"))
            .expect("fixture label is available for pointer actions");
        for kind in [ActionKind::RightClick] {
            desktop
                .perform(
                    &target.target,
                    Some(&pointer_target.uid),
                    &Action {
                        kind: Some(kind),
                        ..Action::default()
                    },
                )
                .unwrap_or_else(|error| panic!("dispatch {kind:?}: {error:?}"));
            let expected = "right-click";
            let deadline = Instant::now() + Duration::from_secs(3);
            while fs::read_to_string(&pointer_state_path).ok().as_deref() != Some(expected) {
                assert!(
                    Instant::now() < deadline,
                    "{kind:?} did not update fixture state"
                );
                thread::sleep(Duration::from_millis(25));
            }
        }

        let initial_double_click_deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&double_click_state_path).ok().as_deref() != Some("0") {
            assert!(
                Instant::now() < initial_double_click_deadline,
                "fixture did not initialize the ListView activation counter"
            );
            thread::sleep(Duration::from_millis(25));
        }
        for activation in 1..=50 {
            let double_click_list = desktop
                .inspect(&target.target, 400)
                .expect("inspect ListView double-click fixture")
                .nodes
                .into_iter()
                .find(|node| node.label.as_deref() == Some("CU-FIXTURE-DOUBLECLICK-LIST"))
                .expect("UIA should expose the dedicated double-click ListView by its name");
            assert!(
                double_click_list.actions.contains(&ActionKind::DoubleClick),
                "ListView must advertise DoubleClick"
            );
            desktop
                .perform(
                    &target.target,
                    Some(&double_click_list.uid),
                    &Action {
                        kind: Some(ActionKind::DoubleClick),
                        ..Action::default()
                    },
                )
                .unwrap_or_else(|error| {
                    panic!(
                        "ListView double-click activation {activation} dispatch failed: {error:?}"
                    )
                });
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let observed = fs::read_to_string(&double_click_state_path)
                    .ok()
                    .and_then(|value| value.trim().parse::<usize>().ok());
                if observed == Some(activation) {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "ListView activation {activation}/50 was not observed; counter={observed:?}"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }

        let hover = desktop
            .inspect(&target.target, 400)
            .expect("inspect hover fixture")
            .nodes
            .into_iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-HOVER"))
            .expect("fixture hover target is accessible");
        desktop
            .perform(
                &target.target,
                Some(&hover.uid),
                &Action {
                    kind: Some(ActionKind::Hover),
                    ..Action::default()
                },
            )
            .expect("move pointer to fixture hover target");
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&pointer_state_path).ok().as_deref() != Some("hover") {
            assert!(
                Instant::now() < deadline,
                "hover did not update fixture state"
            );
            thread::sleep(Duration::from_millis(25));
        }

        let scroll = desktop
            .inspect(&target.target, 400)
            .expect("inspect scroll fixture")
            .nodes
            .into_iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-SCROLL"))
            .expect("fixture scroll panel is accessible");
        assert!(
            scroll.actions.contains(&ActionKind::Scroll),
            "fixture must expose UIA ScrollPattern"
        );
        desktop
            .perform(
                &target.target,
                Some(&scroll.uid),
                &Action {
                    kind: Some(ActionKind::Scroll),
                    scroll: Some(Scroll { dx: 0.0, dy: 1.0 }),
                    ..Action::default()
                },
            )
            .expect("scroll fixture through UIA ScrollPattern");
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&scroll_state_path)
            .ok()
            .is_none_or(|value| value.trim().is_empty() || value.trim() == "0")
        {
            assert!(
                Instant::now() < deadline,
                "scroll did not change fixture state"
            );
            thread::sleep(Duration::from_millis(25));
        }

        let drag = desktop
            .inspect(&target.target, 400)
            .expect("inspect drag fixture")
            .nodes
            .into_iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-DRAG"))
            .expect("fixture drag panel is accessible");
        desktop
            .perform(
                &target.target,
                Some(&drag.uid),
                &Action {
                    kind: Some(ActionKind::Drag),
                    point: Some(Point { x: 350.0, y: 190.0 }),
                    to: Some(Point { x: 420.0, y: 235.0 }),
                    ..Action::default()
                },
            )
            .expect("drag inside the isolated fixture panel");
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&pointer_state_path).ok().as_deref() != Some("drag-end:True") {
            assert!(
                Instant::now() < deadline,
                "drag did not reach the fixture MouseUp handler"
            );
            thread::sleep(Duration::from_millis(25));
        }

        let edit = desktop
            .inspect(&target.target, 400)
            .expect("inspect fixture text input")
            .nodes
            .into_iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-EDIT"))
            .expect("UIA should identify the fixture Edit control");
        assert_eq!(
            edit.role, "edit",
            "UIA control-type labels must match the role"
        );
        assert!(edit.actions.contains(&ActionKind::TypeText));
        let expected = "Ab中文!@#";
        desktop
            .perform(
                &target.target,
                Some(&edit.uid),
                &Action {
                    kind: Some(ActionKind::TypeText),
                    text: Some(expected.into()),
                    ..Action::default()
                },
            )
            .expect("send Unicode text to the verified foreground fixture");
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if fs::read_to_string(&state_path).ok().as_deref() == Some(expected) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fixture text did not match exactly"
            );
            thread::sleep(Duration::from_millis(50));
        }
        desktop
            .perform(
                &target.target,
                Some(&edit.uid),
                &Action {
                    kind: Some(ActionKind::PressKeys),
                    keys: Some(vec!["A".into(), "!".into()]),
                    ..Action::default()
                },
            )
            .expect("send literal uppercase and punctuation key chords");
        let expected = "Ab中文!@#A!";
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if fs::read_to_string(&state_path).ok().as_deref() == Some(expected) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "press_keys did not preserve case and punctuation"
            );
            thread::sleep(Duration::from_millis(50));
        }

        // Verify ValuePattern writes are distinct from typed input and that
        // the native control exposes the exact postcondition to the fixture.
        let value_pattern_text = "SetValue ✓";
        desktop
            .perform(
                &target.target,
                Some(&edit.uid),
                &Action {
                    kind: Some(ActionKind::SetValue),
                    text: Some(value_pattern_text.into()),
                    ..Action::default()
                },
            )
            .expect("set the fixture value through UIA ValuePattern");
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&state_path).ok().as_deref() != Some(value_pattern_text) {
            assert!(
                Instant::now() < deadline,
                "ValuePattern did not update the fixture's observable text state"
            );
            thread::sleep(Duration::from_millis(25));
        }
        let expected = "Ab中文!@#A!";
        desktop
            .perform(
                &target.target,
                Some(&edit.uid),
                &Action {
                    kind: Some(ActionKind::SetValue),
                    text: Some(expected.into()),
                    ..Action::default()
                },
            )
            .expect("restore the fixture value before selection tests");
        let deadline = Instant::now() + Duration::from_secs(3);
        while fs::read_to_string(&state_path).ok().as_deref() != Some(expected) {
            assert!(
                Instant::now() < deadline,
                "ValuePattern did not restore the fixture's expected state"
            );
            thread::sleep(Duration::from_millis(25));
        }

        let combo = desktop
            .inspect(&target.target, 400)
            .expect("inspect fixture combo box")
            .nodes
            .into_iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-COMBO"))
            .expect("UIA should identify the fixture ComboBox");
        assert!(
            combo.role == "combo-box" || combo.actions.contains(&ActionKind::Select),
            "a framework ComboBox with a generic UIA role must still expose Select"
        );
        assert!(combo.actions.contains(&ActionKind::Select));
        let combo_options = ["One", "Two", "Three"];
        for index in 0..10 {
            let option = combo_options[index % combo_options.len()];
            desktop
                .perform(
                    &target.target,
                    Some(&combo.uid),
                    &Action {
                        kind: Some(ActionKind::Select),
                        option: Some(option.into()),
                        ..Action::default()
                    },
                )
                .unwrap_or_else(|error| {
                    panic!("ComboBox select {index} ({option}) failed: {error:?}")
                });
            assert_eq!(
                fs::read_to_string(&combo_state_path).expect("read selected combo item"),
                option,
                "ComboBox select {index} must reach the requested native value"
            );
            assert_eq!(
                fs::read_to_string(&state_path).expect("read text input state"),
                "Ab中文!@#A!",
                "ComboBox selection must not type into the Edit control"
            );
        }

        let list = desktop
            .inspect(&target.target, 400)
            .expect("inspect fixture ListBox")
            .nodes
            .into_iter()
            .find(|item| item.label.as_deref() == Some("CU-FIXTURE-LIST"))
            .expect("UIA should identify the fixture ListBox");
        assert_eq!(
            list.role, "list",
            "native ListBox Pane should retain its semantic role"
        );
        assert!(list.actions.contains(&ActionKind::Select));
        let list_options = ["Alpha", "Gamma", "Epsilon"];
        for index in 0..10 {
            let option = list_options[(index * 2) % list_options.len()];
            desktop
                .perform(
                    &target.target,
                    Some(&list.uid),
                    &Action {
                        kind: Some(ActionKind::Select),
                        option: Some(option.into()),
                        ..Action::default()
                    },
                )
                .unwrap_or_else(|error| {
                    panic!("ListBox select {index} ({option}) failed: {error:?}")
                });
            assert_eq!(
                fs::read_to_string(&list_state_path).expect("read selected list item"),
                option,
                "ListBox select {index} must reach the requested native value"
            );
            assert_eq!(
                fs::read_to_string(&combo_state_path).expect("read selected combo item"),
                combo_options[9 % combo_options.len()],
                "ListBox selection must not alter the ComboBox"
            );
        }

        // Close the bound target, then reopen a same-title replacement. A
        // stale window ID must stay invalid; matching by title must not
        // silently retarget it to the replacement process.
        let _ = child.kill();
        let _ = child.wait();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if desktop
                .resolve_target(&canonical_target_id)
                .expect("check the closed target id")
                .is_none()
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "closed target id remained resolvable"
            );
            thread::sleep(Duration::from_millis(50));
        }
        child = Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script_path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("reopen isolated fixture with the same title");
        let deadline = Instant::now() + Duration::from_secs(10);
        let replacement = loop {
            let targets = desktop.list_targets().expect("enumerate reopened fixture");
            if let Some(replacement) = targets.iter().find(|candidate| candidate.title == title) {
                break replacement.clone();
            }
            assert!(
                Instant::now() < deadline,
                "replacement fixture did not appear: {title}"
            );
            thread::sleep(Duration::from_millis(50));
        };
        assert_ne!(
            replacement.target.target_id, canonical_target_id,
            "a same-title replacement process must receive a new target id"
        );
        assert!(
            desktop
                .resolve_target(&canonical_target_id)
                .expect("reject the stale id after same-title replacement")
                .is_none(),
            "the old id must not alias a replacement window"
        );
        assert!(
            desktop
                .resolve_target(&replacement.target.target_id)
                .expect("resolve the new host-issued target id")
                .is_some(),
            "the replacement is usable only through its new exact id"
        );
    }));

    let _ = child.kill();
    let _ = child.wait();
    if let Some(mut secondary) = secondary_child.take() {
        let _ = secondary.kill();
        let _ = secondary.wait();
    }
    let _ = fs::remove_file(script_path);
    let _ = fs::remove_file(secondary_script_path);
    let _ = fs::remove_file(state_path);
    let _ = fs::remove_file(focus_command_path);
    let _ = fs::remove_file(focus_state_path);
    let _ = fs::remove_file(pointer_state_path);
    let _ = fs::remove_file(double_click_state_path);
    let _ = fs::remove_file(scroll_state_path);
    let _ = fs::remove_file(combo_state_path);
    let _ = fs::remove_file(list_state_path);
    if let Err(payload) = outcome {
        std::panic::resume_unwind(payload);
    }
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires interactive Windows UIA device acceptance"]
fn windows_backend_repeats_target_binding_under_three_start_conditions() {
    use std::fs;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use std::thread;
    use std::time::SystemTime;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .expect("system clock is after the Unix epoch")
        .as_nanos();
    let suffix = format!("{}-{nonce}", std::process::id());
    let primary_title = format!("PI-CU-TARGET-PRIMARY-{suffix}");
    let secondary_title = format!("PI-CU-TARGET-SECONDARY-{suffix}");
    let fixture_dir = std::env::current_exe()
        .expect("test executable path")
        .parent()
        .expect("test executable directory")
        .to_path_buf();
    let primary_script = fixture_dir.join(format!("{primary_title}.ps1"));
    let secondary_script = fixture_dir.join(format!("{secondary_title}.ps1"));
    let churn_title = format!("PI-CU-TARGET-CHURN-{suffix}");
    let churn_script = fixture_dir.join(format!("{churn_title}.ps1"));
    let churn_ready = fixture_dir.join(format!("{churn_title}.ready"));
    let primary_source = |title: &str| {
        format!(
            r#"Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = '{title}'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(360, 200)
$form.TopMost = $true
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Isolated target fixture'
$button.Location = New-Object System.Drawing.Point(24, 24)
$form.Controls.Add($button)
$form.add_Shown({{ $form.Activate(); $button.Focus() | Out-Null }})
[System.Windows.Forms.Application]::Run($form)
"#
        )
    };
    fs::write(&primary_script, primary_source(&primary_title)).expect("write primary fixture");
    fs::write(&secondary_script, primary_source(&secondary_title))
        .expect("write secondary fixture");
    fs::write(
        &churn_script,
        format!(
            r#"Add-Type -AssemblyName System.Windows.Forms
for ($i = 0; $i -lt 120; $i++) {{
    $form = New-Object System.Windows.Forms.Form
    $form.Text = '{churn_title}-$i'
    $form.Size = New-Object System.Drawing.Size(240, 120)
    $label = New-Object System.Windows.Forms.Label
    $label.Text = 'Enumeration churn fixture'
    $label.Location = New-Object System.Drawing.Point(12, 12)
    $form.Controls.Add($label)
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    if ($i -eq 0) {{ [System.IO.File]::WriteAllText('{ready}', 'ready') }}
    Start-Sleep -Milliseconds 25
    $form.Close()
    [System.Windows.Forms.Application]::DoEvents()
}}
"#,
            churn_title = churn_title,
            ready = churn_ready.display().to_string().replace('\'', "''"),
        ),
    )
    .expect("write window churn fixture");
    let mut primary_child: Child = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&primary_script)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .expect("start isolated primary target fixture");
    let mut secondary_child: Option<Child> = None;
    let mut churn_child: Option<Child> = None;
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let desktop = super::backend::active();
        let target_for_title = |title: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let targets = desktop
                    .list_targets()
                    .expect("enumerate target fixture windows");
                if let Some(target) = targets.into_iter().find(|item| item.title == title) {
                    break target;
                }
                assert!(
                    Instant::now() < deadline,
                    "fixture window did not appear: {title}"
                );
                thread::sleep(Duration::from_millis(50));
            }
        };
        let primary = target_for_title(&primary_title);
        let primary_id = primary.target.target_id.clone();

        // Starting from a fresh test/Host process: mint and revoke 50
        // window-scoped grants using only the exact Host-issued target ID.
        let mut phase_a = WindowsTargetTrialStats::default();
        for trial in 0..50 {
            if let Some(mut grant) = record_pinned_grant_with_retry(
                desktop.as_ref(),
                &primary_id,
                "fresh-host",
                trial,
                &mut phase_a,
            ) {
                assert_eq!(grant.target.target_id, primary_id);
                policy::revoke(&mut grant, false);
            }
        }

        secondary_child = Some(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&secondary_script)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("start second isolated target fixture"),
        );
        let secondary = target_for_title(&secondary_title);
        let secondary_id = secondary.target.target_id;

        let mut switch_grant = policy::create_grant(
            desktop.as_ref(),
            None,
            &Denylist::default(),
            GrantRequest {
                target_id: None,
                session_id: "computer-target-two-window-churn".into(),
                input_policy: InputPolicy::AutonomousInScope,
                capture: CaptureMode::A11yOnly,
                action_budget: 3,
                idle_expiry: Duration::from_secs(600),
            },
            Instant::now(),
        )
        .expect("mint desktop grant against a foreground fixture window");
        assert_eq!(switch_grant.scope, super::GrantScope::Desktop);
        let return_id = switch_grant.target.target_id.clone();
        assert!(
            return_id == primary_id || return_id == secondary_id,
            "the freshly foregrounded fixture must be the desktop grant target; got {return_id}"
        );
        let switch_id = if return_id == primary_id {
            secondary_id.as_str()
        } else {
            primary_id.as_str()
        };
        let mut phase_b = WindowsTargetTrialStats::default();
        churn_child = Some(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&churn_script)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("start transient-window churn fixture"),
        );
        let ready_deadline = Instant::now() + Duration::from_secs(5);
        while !churn_ready.exists() {
            assert!(
                Instant::now() < ready_deadline,
                "transient-window churn fixture did not start"
            );
            thread::sleep(Duration::from_millis(10));
        }
        for trial in 0..50 {
            let requested = if trial % 2 == 0 {
                switch_id
            } else {
                &return_id
            };
            let _ = record_bind_with_retry(
                desktop.as_ref(),
                &mut switch_grant,
                requested,
                "two-window-churn",
                trial,
                &mut phase_b,
            );
        }
        let churn_deadline = Instant::now() + Duration::from_secs(10);
        while churn_child
            .as_mut()
            .is_some_and(|child| child.try_wait().expect("poll churn fixture").is_none())
        {
            assert!(
                Instant::now() < churn_deadline,
                "transient-window churn fixture did not finish"
            );
            thread::sleep(Duration::from_millis(20));
        }
        if let Some(mut churn) = churn_child.take() {
            let _ = churn.wait();
        }

        // Simulate a sequence of agent grants being created and revoked, then
        // re-run the 50 precise target transitions against the same two apps.
        let mut phase_c = WindowsTargetTrialStats::default();
        for trial in 0..10 {
            if let Some(mut grant) = record_pinned_grant_with_retry(
                desktop.as_ref(),
                &primary_id,
                "grant-churn-setup",
                trial,
                &mut phase_c,
            ) {
                policy::revoke(&mut grant, false);
            }
        }
        for trial in 0..50 {
            let requested = if trial % 2 == 0 {
                switch_id
            } else {
                &return_id
            };
            let _ = record_bind_with_retry(
                desktop.as_ref(),
                &mut switch_grant,
                requested,
                "after-ten-grant-cycles",
                trial,
                &mut phase_c,
            );
        }
        policy::revoke(&mut switch_grant, false);

        let all_stats = [&phase_a, &phase_b, &phase_c];
        let first_failures = all_stats
            .iter()
            .map(|stats| stats.first_attempt_failures)
            .sum::<usize>();
        let recovered = all_stats
            .iter()
            .map(|stats| stats.recovered_within_100ms)
            .sum::<usize>();
        let unrecovered = all_stats
            .iter()
            .map(|stats| stats.unrecovered)
            .sum::<usize>();
        let late_recoveries = all_stats
            .iter()
            .map(|stats| stats.late_recoveries)
            .sum::<usize>();
        let target_mismatches = all_stats
            .iter()
            .map(|stats| stats.target_mismatches)
            .sum::<usize>();
        eprintln!(
            "COMPUTER_USE_TARGET_BASELINE {}",
            serde_json::json!({
                "freshHost": format!("{phase_a:?}"),
                "twoWindowChurn": format!("{phase_b:?}"),
                "afterTenGrantCycles": format!("{phase_c:?}"),
                "firstAttemptFailures": first_failures,
                "recoveredWithin100ms": recovered,
                "unrecovered": unrecovered,
                "lateRecoveries": late_recoveries,
                "targetMismatches": target_mismatches,
            })
        );
        assert!(
            first_failures <= 3,
            "150 target-selection trials plus 10 churn grants must have at most 3 first-attempt failures; A={phase_a:?}, B={phase_b:?}, C={phase_c:?}"
        );
        assert_eq!(unrecovered, 0, "all first-attempt failures must recover");
        assert_eq!(late_recoveries, 0, "retries must recover within 100ms");
        assert_eq!(recovered, first_failures);
        assert_eq!(
            target_mismatches, 0,
            "a target ID must never bind to another window"
        );
    }));

    let _ = primary_child.kill();
    let _ = primary_child.wait();
    if let Some(mut secondary) = secondary_child.take() {
        let _ = secondary.kill();
        let _ = secondary.wait();
    }
    if let Some(mut churn) = churn_child.take() {
        let _ = churn.kill();
        let _ = churn.wait();
    }
    let _ = fs::remove_file(primary_script);
    let _ = fs::remove_file(secondary_script);
    let _ = fs::remove_file(churn_script);
    let _ = fs::remove_file(churn_ready);
    if let Err(payload) = outcome {
        std::panic::resume_unwind(payload);
    }
}

struct FakeDesktop {
    targets: Mutex<Vec<RawTarget>>,
    directly_resolved_target: Mutex<Option<RawTarget>>,
    measured: Mutex<Option<Measured>>,
    secure_input: Mutex<bool>,
    perform_result: Mutex<Result<Dispatched, DesktopError>>,
    performed: Mutex<Vec<(Option<String>, ActionKind)>>,
    /// Set when the platform can enumerate a window but not read its tree —
    /// the real macOS case when the window is off-stage.
    inspect_error: Mutex<Option<DesktopError>>,
}

impl FakeDesktop {
    fn new(targets: Vec<RawTarget>) -> Self {
        let bounds = targets
            .first()
            .map(|item| item.bounds)
            .unwrap_or(rect(0.0, 0.0, 100.0, 100.0));
        let app_key = targets
            .first()
            .map(|item| item.target.app_key.clone())
            .unwrap_or_else(|| "com.example.app".into());
        Self {
            targets: Mutex::new(targets),
            directly_resolved_target: Mutex::new(None),
            measured: Mutex::new(Some(Measured {
                bounds,
                app_key,
                title: "Document".into(),
            })),
            secure_input: Mutex::new(false),
            perform_result: Mutex::new(Ok(Dispatched::AccessibilityAction)),
            performed: Mutex::new(Vec::new()),
            inspect_error: Mutex::new(None),
        }
    }

    fn set_inspect_error(&self, error: Option<DesktopError>) {
        *self.inspect_error.lock().unwrap() = error;
    }

    fn set_measured(&self, measured: Option<Measured>) {
        *self.measured.lock().unwrap() = measured;
    }

    fn set_secure_input(&self, value: bool) {
        *self.secure_input.lock().unwrap() = value;
    }

    /// Replace the enumeration, as closing or opening a window would.
    fn set_targets(&self, targets: Vec<RawTarget>) {
        *self.targets.lock().unwrap() = targets;
    }

    fn set_directly_resolved_target(&self, target: Option<RawTarget>) {
        *self.directly_resolved_target.lock().unwrap() = target;
    }

    fn performed_count(&self) -> usize {
        self.performed.lock().unwrap().len()
    }
}

impl Desktop for FakeDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: "test".into(),
            backend: "macos-ax".into(),
            fidelity: Fidelity::Full,
            accessibility: PermissionState::Granted,
            capture: PermissionState::Granted,
            session_type: None,
            input_unsupported_reason: None,
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        Ok(self.targets.lock().unwrap().clone())
    }

    fn resolve_target(&self, target_id: &str) -> Result<Option<RawTarget>, DesktopError> {
        Ok(self
            .directly_resolved_target
            .lock()
            .unwrap()
            .clone()
            .filter(|item| item.target.target_id == target_id))
    }

    fn measure(&self, _target: &TargetRef) -> Result<Measured, DesktopError> {
        self.measured
            .lock()
            .unwrap()
            .clone()
            .ok_or(DesktopError::TargetGone)
    }

    fn inspect(
        &self,
        _target: &TargetRef,
        _max_nodes: usize,
    ) -> Result<RawInspection, DesktopError> {
        if let Some(error) = self.inspect_error.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(RawInspection {
            nodes: vec![
                node("0.1", "AXButton", vec![ActionKind::Click]),
                node("0.2", "AXTextField", vec![ActionKind::SetValue]),
            ],
            truncated: false,
            fidelity: Fidelity::Full,
        })
    }

    fn secure_input_active(&self) -> bool {
        *self.secure_input.lock().unwrap()
    }

    fn perform(
        &self,
        _target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let result = self.perform_result.lock().unwrap().clone();
        if result.is_ok() {
            self.performed
                .lock()
                .unwrap()
                .push((uid.map(str::to_string), action.kind.unwrap()));
        }
        result
    }

    fn self_pids(&self) -> Vec<i32> {
        vec![OWN_PID]
    }
}

fn target(pid: i32, app_key: &str, app_name: &str, id: &str) -> RawTarget {
    RawTarget {
        target: TargetRef {
            target_id: id.into(),
            pid,
            window: 7,
            app_key: app_key.into(),
        },
        app_name: app_name.into(),
        title: "Document".into(),
        bounds: rect(100.0, 100.0, 800.0, 600.0),
        elevated: false,
    }
}

fn grant_for(desktop: &FakeDesktop, id: &str) -> Grant {
    policy::create_grant(
        desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some(id.into()),
            session_id: "session-1".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("grant")
}

/// The automatic grant of ADR 0350: no target, so the host binds the frontmost
/// usable window itself.
fn desktop_grant(desktop: &FakeDesktop, denylist: &Denylist) -> Grant {
    policy::create_grant(
        desktop,
        None,
        denylist,
        GrantRequest {
            target_id: None,
            session_id: "session-1".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("desktop grant")
}

#[test]
fn grant_keeps_large_user_selected_budget_and_idle_expiry() {
    let desktop = FakeDesktop::new(vec![target(10, "com.example.app", "Example", "window-1")]);
    let idle_expiry = Duration::from_millis(9_007_199_254_740_991);
    let grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some("window-1".into()),
            session_id: "session-1".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 10_000_000,
            idle_expiry,
        },
        Instant::now(),
    )
    .expect("large valid grant settings");

    assert_eq!(grant.remaining_budget, 10_000_000);
    assert_eq!(grant.idle_expiry, idle_expiry);
    assert_eq!(
        grant.view(Instant::now()).expires_at,
        "9999-12-31T23:59:59.999Z",
    );
}

fn click_uid(uid: &str) -> Action {
    Action {
        kind: Some(ActionKind::Click),
        uid: Some(uid.into()),
        ..Action::default()
    }
}

#[test]
fn our_own_windows_are_blocked_by_default() {
    let desktop = FakeDesktop::new(vec![
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(99, "com.example.app", "Example", "other-window"),
    ]);
    let listed = policy::list_targets(&desktop, &Denylist::default()).expect("targets");
    let own = listed
        .iter()
        .find(|item| item.target_id == "self-window")
        .expect("listed");
    // Listed, not hidden — a caller has to be able to explain the refusal.
    assert_eq!(own.refused_reason, Some(super::TargetRefusal::SelfTarget));

    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some("self-window".into()),
            session_id: "session-1".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yAndPixels,
            action_budget: 10,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect_err("self target must refuse");
    assert_eq!(error, Refusal::SelfTargetRefused);
}

#[test]
fn explicit_settings_can_disable_each_application_target_refusal() {
    let desktop = FakeDesktop::new(vec![
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(
            31,
            "com.apple.keychainaccess",
            "Keychain Access",
            "credential-window",
        ),
        RawTarget {
            elevated: true,
            ..target(32, "admin-tool", "Admin Tool", "elevated-window")
        },
    ]);
    let policy = Denylist::with_restrictions(
        &[],
        super::policy::Restrictions {
            disable_all: true,
            block_self_target: true,
            block_secure_input: true,
            enforce_denylist: true,
            block_elevated_targets: true,
        },
    );
    let listed = policy::list_targets(&desktop, &policy).expect("targets");
    assert!(listed.iter().all(|item| item.refused_reason.is_none()));
}

#[test]
fn a_renamed_self_process_is_still_refused() {
    // A helper process with a different pid but one of our app keys.
    let desktop = FakeDesktop::new(vec![target(
        1234,
        "pi-desktop-host-core",
        "Helper",
        "helper",
    )]);
    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some("helper".into()),
            session_id: "s".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 1,
            idle_expiry: Duration::from_secs(60),
        },
        Instant::now(),
    )
    .expect_err("self app key must refuse");
    assert_eq!(error, Refusal::SelfTargetRefused);
}

#[test]
fn built_in_credential_surfaces_are_blocked_by_default() {
    let desktop = FakeDesktop::new(vec![target(
        31,
        "com.apple.keychainaccess",
        "Keychain Access",
        "kc",
    )]);
    // An empty user list is the most permissive configuration there is.
    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::new(&[]),
        GrantRequest {
            target_id: Some("kc".into()),
            session_id: "s".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 1,
            idle_expiry: Duration::from_secs(60),
        },
        Instant::now(),
    )
    .expect_err("credential surface must refuse");
    assert_eq!(error, Refusal::TargetDenylisted);
}

#[test]
fn a_user_denylist_entry_matches_key_or_name() {
    let list = Denylist::new(&["Secret Notes".to_string()]);
    assert!(list.refuses("com.example.notes", "Secret Notes"));
    assert!(!list.refuses("com.example.notes", "Public Notes"));
}

#[test]
fn secure_input_refuses_both_inspection_and_action() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    desktop.set_secure_input(true);

    let inspect = policy::inspect(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        Instant::now(),
    )
    .expect_err("inspect");
    assert_eq!(inspect, Refusal::SecureInputRefused);

    let act = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("act");
    assert_eq!(act, Refusal::SecureInputRefused);
    assert_eq!(desktop.performed_count(), 0, "nothing may be dispatched");
}

#[test]
fn secure_input_block_can_be_disabled_by_user_policy() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    desktop.set_secure_input(true);
    let policy = Denylist::with_restrictions(
        &[],
        super::policy::Restrictions {
            block_secure_input: false,
            ..super::policy::Restrictions::default()
        },
    );

    assert!(policy::inspect(&desktop, &mut grant, &policy, None, Instant::now()).is_ok());
    assert!(policy::act(
        &desktop,
        &mut grant,
        &policy,
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .is_ok());
    assert_eq!(desktop.performed_count(), 1);
}

#[test]
fn password_target_refusal_maps_to_the_unconditional_secure_input_code() {
    assert_eq!(
        Refusal::from(DesktopError::SecureInputRefused),
        Refusal::SecureInputRefused
    );
}

#[test]
fn a_moved_window_bumps_the_revision_and_invalidates_a_basis() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    let captured = Basis {
        revision: grant.revision,
        bounds: grant.bounds,
    };

    desktop.set_measured(Some(Measured {
        bounds: rect(400.0, 100.0, 800.0, 600.0),
        app_key: "com.example.app".into(),
        title: "Document".into(),
    }));

    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point { x: 10.0, y: 10.0 }),
        basis: Some(captured),
        ..Action::default()
    };
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &action,
        Instant::now(),
    )
    .expect_err("stale basis");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(grant.revision, 2, "the move is recorded");
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn a_resized_window_with_the_same_revision_still_refuses_a_stale_basis() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    // A basis whose geometry disagrees with the live measurement, carrying the
    // revision the caller currently holds.
    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point { x: 10.0, y: 10.0 }),
        basis: Some(Basis {
            revision: grant.revision,
            bounds: rect(0.0, 0.0, 10.0, 10.0),
        }),
        ..Action::default()
    };
    let error = policy::validate_action(&grant, &action, &grant.bounds).expect_err("basis");
    assert_eq!(error, Refusal::StaleBasis);
}

#[test]
fn an_expected_revision_mismatch_refuses_before_dispatch() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        Some(99),
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("revision");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn coordinates_outside_the_measured_window_are_refused_not_clamped() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point {
            x: 5_000.0,
            y: 10.0,
        }),
        basis: Some(Basis {
            revision: grant.revision,
            bounds: grant.bounds,
        }),
        ..Action::default()
    };
    let error = policy::validate_action(&grant, &action, &grant.bounds).expect_err("bounds");
    assert_eq!(error, Refusal::ScopeViolation);
}

#[test]
fn a_coordinate_action_without_a_basis_is_refused() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point { x: 10.0, y: 10.0 }),
        ..Action::default()
    };
    match policy::validate_action(&grant, &action, &grant.bounds) {
        Err(Refusal::ActionRejected(reason)) => assert!(reason.contains("basis")),
        other => panic!("expected a rejection, got {other:?}"),
    }
}

#[test]
fn the_budget_closes_the_grant_and_refuses_the_next_action() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    grant.remaining_budget = 1;

    let first = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect("first");
    assert_eq!(first.remaining_budget, 0);
    assert_eq!(
        grant.state,
        GrantState::Expired,
        "a spent grant closes itself"
    );

    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("budget");
    assert_eq!(error, Refusal::BudgetExhausted);
    assert_eq!(desktop.performed_count(), 1);
}

#[test]
fn a_refused_dispatch_does_not_spend_the_budget() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    *desktop.perform_result.lock().unwrap() = Err(DesktopError::NotActionable);
    let before = grant.remaining_budget;
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("not actionable");
    assert_eq!(error, Refusal::ElementNotActionable);
    assert_eq!(grant.remaining_budget, before);
}

#[test]
fn an_idle_grant_expires_and_stays_expired() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    grant.idle_expiry = Duration::from_secs(30);
    grant.last_activity = Instant::now() - Duration::from_secs(31);

    let id = grant.grant_id.clone();
    let mut slot = Some(grant);
    let error =
        policy::usable_grant(slot.as_mut(), &id, None, Instant::now()).expect_err("expired");
    assert_eq!(error, Refusal::GrantExpired);
    assert_eq!(slot.unwrap().state, GrantState::Expired);
}

#[test]
fn only_one_grant_is_active_per_instance() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let active = grant_for(&desktop, "w1");
    let error = policy::create_grant(
        &desktop,
        Some(&active),
        &Denylist::default(),
        GrantRequest {
            target_id: Some("w2".into()),
            session_id: "session-2".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 5,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect_err("second grant");
    assert_eq!(error, Refusal::GrantInUse);
}

#[test]
fn another_session_cannot_use_the_active_grant() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let id = grant.grant_id.clone();
    let mut slot = Some(grant);
    let error = policy::usable_grant(slot.as_mut(), &id, Some("session-2"), Instant::now())
        .expect_err("wrong session");
    assert_eq!(error, Refusal::GrantInUse);
    assert!(policy::usable_grant(slot.as_mut(), &id, Some("session-1"), Instant::now()).is_ok());
}

#[test]
fn a_target_that_became_another_application_revokes_the_grant() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    desktop.set_measured(Some(Measured {
        bounds: grant.bounds,
        app_key: "com.attacker.app".into(),
        title: "Document".into(),
    }));
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("reidentified");
    assert_eq!(error, Refusal::ScopeViolation);
    assert_eq!(grant.state, GrantState::Revoked);
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn a_closed_window_is_reported_as_temporarily_unavailable() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    desktop.set_measured(None);
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("gone");
    assert_eq!(error, Refusal::TargetUnavailable);
}

#[test]
fn malformed_actions_are_rejected_before_the_platform_sees_them() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let cases: Vec<Action> = vec![
        Action::default(),
        Action {
            kind: Some(ActionKind::Click),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::SetValue),
            uid: Some("0.1".into()),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::SetValue),
            uid: Some("0.1".into()),
            text: Some("x".repeat(super::MAX_TEXT_CHARS + 1)),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::TypeText),
            uid: Some("0.1".into()),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::PressKeys),
            uid: Some("0.1".into()),
            keys: Some(vec![]),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::PressKeys),
            uid: Some("0.1".into()),
            keys: Some(vec!["  ".into()]),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Select),
            uid: Some("0.1".into()),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Scroll),
            uid: Some("0.1".into()),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Drag),
            uid: Some("0.1".into()),
            point: Some(Point { x: 10.0, y: 10.0 }),
            basis: Some(Basis {
                revision: grant.revision,
                bounds: grant.bounds,
            }),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Scroll),
            uid: Some("0.1".into()),
            scroll: Some(Scroll {
                dx: f64::NAN,
                dy: 0.0,
            }),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Click),
            uid: Some(" ".into()),
            ..Action::default()
        },
    ];
    for action in cases {
        let result = policy::validate_action(&grant, &action, &grant.bounds);
        assert!(result.is_err(), "accepted {action:?}");
    }
}

#[test]
fn labels_from_a_window_are_bounded() {
    let long = "x".repeat(super::MAX_LABEL_CHARS * 3);
    assert_eq!(
        super::truncate_label(&long).chars().count(),
        super::MAX_LABEL_CHARS
    );
    // A multi-byte label must not be cut mid-character.
    let wide = "字".repeat(super::MAX_LABEL_CHARS + 10);
    assert_eq!(
        super::truncate_label(&wide).chars().count(),
        super::MAX_LABEL_CHARS
    );
}

#[test]
fn an_unsupported_platform_refuses_every_operation() {
    let desktop = super::backend::UnsupportedDesktop::new("test", "no backend");
    assert!(
        desktop.secure_input_active(),
        "refusing is the safe default"
    );
    assert_eq!(desktop.capabilities().fidelity, Fidelity::None);
    assert_eq!(desktop.request_permission(), Err(DesktopError::Unsupported));
    assert_eq!(
        policy::list_targets(&desktop, &Denylist::default()).expect_err("targets"),
        Refusal::PlatformUnsupported
    );
}

#[test]
fn a_desktop_grant_binds_the_frontmost_usable_window() {
    // Our own window is in front, which is exactly the case the automatic
    // grant must not take: "the whole desktop" never includes us.
    let desktop = FakeDesktop::new(vec![
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(99, "com.example.app", "Example", "front"),
        target(98, "com.other.app", "Other", "back"),
    ]);
    let grant = desktop_grant(&desktop, &Denylist::default());
    assert_eq!(grant.scope, super::GrantScope::Desktop);
    assert_eq!(grant.target.target_id, "front");
    assert_eq!(grant.view(Instant::now()).scope, super::GrantScope::Desktop);
}

#[test]
fn an_automatic_grant_skips_a_window_whose_tree_cannot_be_opened() {
    // The device case: the window server lists Stage Manager's own surfaces in
    // front of the user's windows, and nothing can read them.
    struct OnlySecondOpens(FakeDesktop);
    impl Desktop for OnlySecondOpens {
        fn capabilities(&self) -> Capabilities {
            self.0.capabilities()
        }
        fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
            self.0.list_targets()
        }
        fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
            self.0.measure(target)
        }
        fn inspect(
            &self,
            target: &TargetRef,
            max_nodes: usize,
        ) -> Result<RawInspection, DesktopError> {
            if target.target_id == "overlay" {
                return Err(DesktopError::TargetGone);
            }
            self.0.inspect(target, max_nodes)
        }
        fn secure_input_active(&self) -> bool {
            self.0.secure_input_active()
        }
        fn perform(
            &self,
            target: &TargetRef,
            uid: Option<&str>,
            action: &Action,
        ) -> Result<Dispatched, DesktopError> {
            self.0.perform(target, uid, action)
        }
        fn self_pids(&self) -> Vec<i32> {
            self.0.self_pids()
        }
    }

    let desktop = OnlySecondOpens(FakeDesktop::new(vec![
        target(404, "windowmanager", "WindowManager", "overlay"),
        target(5, "com.example.app", "Example", "w1"),
    ]));
    let grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: None,
            session_id: "s".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("grant");
    assert_eq!(
        grant.target.target_id, "w1",
        "the unreadable surface is skipped"
    );
}

#[test]
fn a_desktop_grant_skips_a_window_that_exposes_only_its_root_node() {
    struct RootOnlyFirst(FakeDesktop);
    impl Desktop for RootOnlyFirst {
        fn capabilities(&self) -> Capabilities {
            self.0.capabilities()
        }
        fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
            self.0.list_targets()
        }
        fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
            let mut measured = self.0.measure(target)?;
            measured.app_key = target.app_key.clone();
            Ok(measured)
        }
        fn inspect(
            &self,
            target: &TargetRef,
            _max_nodes: usize,
        ) -> Result<RawInspection, DesktopError> {
            let mut tree = self.0.inspect(target, 2)?;
            if target.target_id == "root-only" {
                tree.nodes.truncate(1);
            }
            Ok(tree)
        }
        fn secure_input_active(&self) -> bool {
            self.0.secure_input_active()
        }
        fn perform(
            &self,
            target: &TargetRef,
            uid: Option<&str>,
            action: &Action,
        ) -> Result<Dispatched, DesktopError> {
            self.0.perform(target, uid, action)
        }
        fn self_pids(&self) -> Vec<i32> {
            self.0.self_pids()
        }
    }
    let desktop = RootOnlyFirst(FakeDesktop::new(vec![
        target(19, "explorer.exe", "Program Manager", "root-only"),
        target(20, "com.example.app", "Usable", "usable"),
    ]));
    let grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: None,
            session_id: "root-only-test".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("grant the usable window");
    assert_eq!(grant.target.target_id, "usable");
}

#[test]
fn a_transient_uia_timeout_is_retried_before_grant_creation_fails() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FirstInspectionTimesOut(FakeDesktop, AtomicUsize);
    impl Desktop for FirstInspectionTimesOut {
        fn capabilities(&self) -> Capabilities {
            self.0.capabilities()
        }
        fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
            self.0.list_targets()
        }
        fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
            self.0.measure(target)
        }
        fn inspect(
            &self,
            target: &TargetRef,
            max_nodes: usize,
        ) -> Result<RawInspection, DesktopError> {
            if self.1.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(DesktopError::Timeout);
            }
            self.0.inspect(target, max_nodes)
        }
        fn secure_input_active(&self) -> bool {
            self.0.secure_input_active()
        }
        fn perform(
            &self,
            target: &TargetRef,
            uid: Option<&str>,
            action: &Action,
        ) -> Result<Dispatched, DesktopError> {
            self.0.perform(target, uid, action)
        }
        fn self_pids(&self) -> Vec<i32> {
            self.0.self_pids()
        }
    }

    let desktop = FirstInspectionTimesOut(
        FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]),
        AtomicUsize::new(0),
    );
    let grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: None,
            session_id: "transient-uia-timeout".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("a one-off UIA timeout must not become a scope refusal");
    assert_eq!(grant.target.target_id, "w1");
    assert_eq!(desktop.1.load(Ordering::SeqCst), 2);
}

#[test]
fn a_transient_switch_measurement_retries_the_requested_window_not_another_one() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FirstMeasureGone(FakeDesktop, AtomicUsize);
    impl Desktop for FirstMeasureGone {
        fn capabilities(&self) -> Capabilities {
            self.0.capabilities()
        }
        fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
            self.0.list_targets()
        }
        fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
            if target.target_id == "w2" && self.1.fetch_add(1, Ordering::SeqCst) == 0 {
                return Err(DesktopError::TargetGone);
            }
            let mut measured = self.0.measure(target)?;
            measured.app_key = target.app_key.clone();
            Ok(measured)
        }
        fn inspect(
            &self,
            target: &TargetRef,
            max_nodes: usize,
        ) -> Result<RawInspection, DesktopError> {
            self.0.inspect(target, max_nodes)
        }
        fn secure_input_active(&self) -> bool {
            self.0.secure_input_active()
        }
        fn perform(
            &self,
            target: &TargetRef,
            uid: Option<&str>,
            action: &Action,
        ) -> Result<Dispatched, DesktopError> {
            self.0.perform(target, uid, action)
        }
        fn self_pids(&self) -> Vec<i32> {
            self.0.self_pids()
        }
    }

    let desktop = FirstMeasureGone(
        FakeDesktop::new(vec![
            target(5, "com.example.one", "One", "w1"),
            target(6, "com.example.two", "Two", "w2"),
        ]),
        AtomicUsize::new(0),
    );
    let mut grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: None,
            session_id: "transient-switch".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("initial grant");
    let inspection = policy::inspect_bound(
        &desktop,
        &mut grant,
        &Denylist::default(),
        Some("w2"),
        None,
        Instant::now(),
    )
    .expect("transient measurement should retry the requested target");
    assert_eq!(grant.target.target_id, "w2");
    assert_eq!(inspection.grant_id, grant.grant_id);
    assert_eq!(desktop.1.load(Ordering::SeqCst), 2);
}

#[test]
fn a_requested_window_omitted_from_two_enumerations_is_retried_without_substitution() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TargetAppearsOnThirdEnumeration(FakeDesktop, AtomicUsize);
    impl Desktop for TargetAppearsOnThirdEnumeration {
        fn capabilities(&self) -> Capabilities {
            self.0.capabilities()
        }
        fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
            let attempt = self.1.fetch_add(1, Ordering::SeqCst);
            let targets = self.0.list_targets()?;
            if attempt < 2 {
                Ok(targets
                    .into_iter()
                    .filter(|item| item.target.target_id != "w2")
                    .collect())
            } else {
                Ok(targets)
            }
        }
        fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
            self.0.measure(target)
        }
        fn inspect(
            &self,
            target: &TargetRef,
            max_nodes: usize,
        ) -> Result<RawInspection, DesktopError> {
            self.0.inspect(target, max_nodes)
        }
        fn secure_input_active(&self) -> bool {
            self.0.secure_input_active()
        }
        fn perform(
            &self,
            target: &TargetRef,
            uid: Option<&str>,
            action: &Action,
        ) -> Result<Dispatched, DesktopError> {
            self.0.perform(target, uid, action)
        }
        fn self_pids(&self) -> Vec<i32> {
            self.0.self_pids()
        }
    }

    let desktop = TargetAppearsOnThirdEnumeration(
        FakeDesktop::new(vec![
            target(5, "com.example.one", "One", "w1"),
            target(6, "com.example.two", "Two", "w2"),
        ]),
        AtomicUsize::new(0),
    );
    let grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some("w2".into()),
            session_id: "transient-target-enumeration".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("the specifically requested target should resolve after transient omissions");

    assert_eq!(grant.target.target_id, "w2");
    assert_eq!(desktop.1.load(Ordering::SeqCst), 3);
}

#[test]
fn a_live_exact_target_can_be_resolved_when_an_enumeration_snapshot_omits_it() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.one", "One", "w1")]);
    desktop.set_directly_resolved_target(Some(target(6, "com.example.two", "Two", "w2")));
    let grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some("w2".into()),
            session_id: "direct-target-resolution".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("resolve the exact live target instead of substituting the first enumerated window");

    assert_eq!(grant.target.target_id, "w2");
    assert_eq!(grant.target_label, "Two — Document");
}

#[test]
fn a_desktop_grant_refuses_when_every_window_is_refused() {
    let desktop = FakeDesktop::new(vec![
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(31, "com.apple.keychainaccess", "Keychain Access", "kc"),
    ]);
    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: None,
            session_id: "s".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 1,
            idle_expiry: Duration::from_secs(60),
        },
        Instant::now(),
    )
    .expect_err("nothing usable");
    assert_eq!(error, Refusal::ScopeViolation);
}

#[test]
fn binding_another_window_moves_the_revision() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = desktop_grant(&desktop, &Denylist::default());
    let before = grant.revision;
    policy::bind_target(&desktop, &mut grant, &Denylist::default(), "w2").expect("rebind");
    assert_eq!(grant.target.target_id, "w2");
    assert_eq!(grant.target_label, "Other — Document");
    assert!(
        grant.revision > before,
        "every uid from w1 must stop validating"
    );

    // An action still holding the previous revision is refused, so a uid read
    // from the old window cannot land in the new one.
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        Some(before),
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("stale revision");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn a_window_that_cannot_be_read_does_not_become_the_bound_one() {
    // The macOS case this came from: `CGWindowList` enumerates an off-stage
    // window that the accessibility client cannot open. The bind is allowed,
    // the read fails, and the grant must stay where the caller last saw it.
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = desktop_grant(&desktop, &Denylist::default());
    assert_eq!(grant.target.target_id, "w1");
    let revision_before = grant.revision;
    // The fake backend's measurement is intentionally one global value; move
    // it to the requested target so this test exercises an unreadable UIA tree
    // rather than the separate HWND identity-change refusal path.
    desktop.set_measured(Some(Measured {
        bounds: rect(20.0, 20.0, 500.0, 400.0),
        app_key: "com.other.app".into(),
        title: "Document".into(),
    }));
    desktop.set_inspect_error(Some(DesktopError::TargetGone));

    let error = policy::inspect_bound(
        &desktop,
        &mut grant,
        &Denylist::default(),
        Some("w2"),
        None,
        Instant::now(),
    )
    .expect_err("the unreadable window must refuse");
    assert_eq!(error, Refusal::TargetUnavailable);
    assert_eq!(grant.target.target_id, "w1", "the grant stays where it was");
    assert_eq!(grant.target_label, "Example — Document");
    assert!(
        grant.revision > revision_before,
        "the attempted move still invalidates held ids"
    );

    // And the window it stayed on is still readable.
    desktop.set_inspect_error(None);
    let inspection = policy::inspect_bound(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        None,
        Instant::now(),
    )
    .expect("the original window still inspects");
    assert_eq!(inspection.nodes.len(), 2);
}

#[test]
fn a_rebind_re_applies_every_refusal() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(31, "com.apple.keychainaccess", "Keychain Access", "kc"),
        target(7, "com.secret.notes", "Secret Notes", "notes"),
    ]);
    let denylist = Denylist::new(&["Secret Notes".to_string()]);
    let mut grant = desktop_grant(&desktop, &denylist);
    for (target_id, expected) in [
        ("self-window", Refusal::SelfTargetRefused),
        ("kc", Refusal::TargetDenylisted),
        ("notes", Refusal::TargetDenylisted),
        ("no-such-window", Refusal::TargetUnavailable),
    ] {
        let error = policy::bind_target(&desktop, &mut grant, &denylist, target_id)
            .expect_err("refused rebind");
        assert_eq!(error, expected, "{target_id}");
        assert_eq!(
            grant.target.target_id, "w1",
            "a refused rebind changes nothing"
        );
    }
}

#[test]
fn a_window_grant_refuses_a_rebind() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = grant_for(&desktop, "w1");
    let error = policy::bind_target(&desktop, &mut grant, &Denylist::default(), "w2")
        .expect_err("window scope cannot move");
    assert_eq!(error, Refusal::ScopeViolation);
    assert_eq!(grant.target.target_id, "w1");
}

#[test]
fn a_desktop_grant_whose_window_closes_rebinds_and_refuses_the_action() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = desktop_grant(&desktop, &Denylist::default());
    assert_eq!(grant.target.target_id, "w1");
    // w1 is gone; only w2 is left on screen.
    desktop.set_measured(None);
    desktop.set_targets(vec![target(6, "com.other.app", "Other", "w2")]);

    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("the action was aimed at the window that closed");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(desktop.performed_count(), 0, "nothing may be dispatched");
    // The grant survives, bound to what is actually there now.
    assert_eq!(grant.state, GrantState::Active);
    assert_eq!(grant.target.target_id, "w2");
}

#[test]
fn a_user_stop_blocks_the_agents_next_mint_but_not_the_users() {
    let now = Instant::now();
    assert!(policy::agent_mint_allowed(None, now).is_ok());
    assert_eq!(
        policy::agent_mint_allowed(Some(now), now).expect_err("cooldown"),
        Refusal::StoppedByUser
    );
    let elapsed = now + super::AGENT_REGRANT_COOLDOWN + Duration::from_secs(1);
    assert!(
        policy::agent_mint_allowed(Some(now), elapsed).is_ok(),
        "the cooldown ends on its own"
    );
}

#[test]
fn a_grant_view_reports_expiry_without_persisting_it() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let view = grant.view(Instant::now());
    assert_eq!(view.state, GrantState::Active);
    assert_eq!(view.remaining_budget, 3);
    assert!(
        view.expires_at > view.created_at,
        "the deadline is ahead of creation"
    );
    assert_eq!(view.target_label, "Example — Document");
}
