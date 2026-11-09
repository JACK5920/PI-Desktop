use super::*;

#[test]
fn explicit_wayland_session_does_not_fall_back_to_xwayland() {
    assert_eq!(session_type_from("wayland", true, true), "wayland");
}

#[test]
fn display_fallback_identifies_supported_x11_sessions() {
    assert_eq!(session_type_from("", false, true), "x11");
    assert_eq!(session_type_from("", false, false), "unknown");
}

#[test]
fn target_identity_binds_pid_window_and_executable() {
    assert_eq!(target_id(12, 0x34, "editor"), "12:52:editor");
}

#[test]
fn pointer_points_are_absolute_screen_coordinates_inside_the_bound_target() {
    let bounds = Rect {
        x: 120.0,
        y: 60.0,
        width: 400.0,
        height: 300.0,
    };
    assert_eq!(
        absolute_pointer_point(bounds, Point { x: 20.0, y: 30.0 }),
        Ok((140, 90))
    );
    assert_eq!(
        absolute_pointer_point(bounds, Point { x: 400.0, y: 30.0 }),
        Err(DesktopError::NotActionable)
    );
    assert_eq!(
        absolute_pointer_point(
            bounds,
            Point {
                x: f64::NAN,
                y: 30.0
            }
        ),
        Err(DesktopError::NotActionable)
    );
}

#[test]
fn accessible_window_matching_rejects_same_geometry_with_different_title() {
    let bounds = Rect {
        x: 10.0,
        y: 20.0,
        width: 800.0,
        height: 600.0,
    };
    assert!(!rects_match(&bounds, &bounds, "Save", "Open"));
}

#[test]
fn accessible_window_matching_rejects_same_title_at_an_unrelated_position() {
    let native = Rect {
        x: 10.0,
        y: 20.0,
        width: 800.0,
        height: 600.0,
    };
    let other = Rect {
        x: 500.0,
        y: 700.0,
        width: 800.0,
        height: 600.0,
    };
    assert!(!rects_match(&other, &native, "Editor", "Editor"));
}

#[test]
fn accessible_window_matching_allows_window_frame_insets_for_same_title() {
    let x11 = Rect {
        x: 10.0,
        y: 20.0,
        width: 800.0,
        height: 600.0,
    };
    let accessible = Rect {
        x: 10.0,
        y: 40.0,
        width: 800.0,
        height: 580.0,
    };
    assert!(rects_match(&accessible, &x11, "Editor", "Editor"));
}

#[test]
fn linux_backend_drives_gtk_fixture_through_atspi() {
    if std::env::var_os("PI_COMPUTER_USE_LINUX_E2E").is_none() {
        return;
    }
    assert_eq!(LinuxDesktop::session_type(), "x11");
    let desktop = LinuxDesktop::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let target = loop {
        if let Some(target) = desktop
            .list_targets()
            .expect("enumerate X11 fixture")
            .into_iter()
            .find(|target| target.title == "PI Computer Use Linux Fixture")
        {
            break target;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "GTK fixture did not appear"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    };

    let initial = desktop
        .inspect(&target.target, 400)
        .expect("inspect GTK fixture over AT-SPI");
    assert_eq!(initial.fidelity, Fidelity::Partial);
    let button = initial
        .nodes
        .iter()
        .find(|node| node.label.as_deref() == Some("Fixture action button"))
        .expect("find named GTK button in AT-SPI tree");
    assert!(button.enabled);
    assert!(button.actions.contains(&ActionKind::Click));
    let uid = button.uid.clone();
    let pointer = initial
        .nodes
        .iter()
        .find(|node| node.label.as_deref() == Some("Fixture pointer target"))
        .expect("find GTK pointer fixture in AT-SPI tree");
    assert!(pointer.enabled);
    assert!(pointer.bounds.is_some());
    assert!(pointer.actions.contains(&ActionKind::Hover));
    assert!(pointer.actions.contains(&ActionKind::Drag));
    let pointer_uid = pointer.uid.clone();
    let pointer_bounds = pointer.bounds.expect("pointer fixture has bounds");

    desktop
        .perform(
            &target.target,
            Some(&uid),
            &Action {
                kind: Some(ActionKind::Click),
                uid: Some(uid.clone()),
                ..Action::default()
            },
        )
        .expect("dispatch GTK action through AT-SPI");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let updated = desktop
            .inspect(&target.target, 400)
            .expect("reinspect GTK fixture after click");
        if updated
            .nodes
            .iter()
            .any(|node| node.label.as_deref() == Some("Fixture status: Click confirmed by GTK"))
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "GTK state did not change after the accepted AT-SPI click"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    desktop
        .perform(
            &target.target,
            Some(&pointer_uid),
            &Action {
                kind: Some(ActionKind::Hover),
                uid: Some(pointer_uid.clone()),
                ..Action::default()
            },
        )
        .expect("move the X11 pointer over the GTK fixture");
    wait_for_fixture_status(
        &desktop,
        &target.target,
        "Fixture status: Hover confirmed by GTK",
    );

    let drag_from = Point {
        x: pointer_bounds.x + 24.0,
        y: pointer_bounds.y + pointer_bounds.height / 2.0,
    };
    let drag_to = Point {
        x: pointer_bounds.x + pointer_bounds.width - 24.0,
        y: pointer_bounds.y + pointer_bounds.height / 2.0,
    };
    desktop
        .perform(
            &target.target,
            Some(&pointer_uid),
            &Action {
                kind: Some(ActionKind::Drag),
                uid: Some(pointer_uid.clone()),
                point: Some(drag_from),
                to: Some(drag_to),
                ..Action::default()
            },
        )
        .expect("drag across the GTK fixture using XTEST");
    wait_for_fixture_status(
        &desktop,
        &target.target,
        "Fixture status: Drag confirmed by GTK",
    );
}

fn wait_for_fixture_status(desktop: &LinuxDesktop, target: &TargetRef, expected: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let updated = desktop
            .inspect(target, 400)
            .expect("reinspect GTK fixture after pointer action");
        if updated
            .nodes
            .iter()
            .any(|node| node.label.as_deref() == Some(expected))
        {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "GTK state did not change to {expected} after the pointer action"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}
