//! Linux desktop discovery for Computer Use.
//!
//! X11 owns native window identity and geometry; AT-SPI is the source of
//! accessible controls. Wayland deliberately does not use XWayland windows as
//! a substitute for compositor-owned desktop input.

use std::collections::VecDeque;
use std::future::Future;
use std::thread;

use atspi::proxy::accessible::AccessibleProxy;
use atspi::proxy::action::ActionProxy;
use atspi::proxy::common::ObjectRefOwned;
use atspi::proxy::common::{CoordType, Interface, Role, ScrollType, State};
use atspi::proxy::component::ComponentProxy;
use atspi::proxy::editable_text::EditableTextProxy;
use atspi::proxy::value::ValueProxy;
use atspi::zbus::{Connection as BusConnection, Proxy};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{
    AtomEnum, ConnectionExt, MapState, Window, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT,
    MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::{self, ConnectionExt as XTestConnectionExt};
use x11rb::rust_connection::RustConnection;

use super::{Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef};
use crate::computer::{
    Action, ActionKind, Capabilities, Fidelity, Node, PermissionState, Point, Rect,
};

const MAX_X11_WINDOWS: usize = 512;

pub struct LinuxDesktop;

impl LinuxDesktop {
    pub fn new() -> Self {
        Self
    }

    fn session_type() -> &'static str {
        session_type_from(
            &std::env::var("XDG_SESSION_TYPE").unwrap_or_default(),
            std::env::var_os("WAYLAND_DISPLAY").is_some(),
            std::env::var_os("DISPLAY").is_some(),
        )
    }

    fn x11(&self) -> Result<(RustConnection, usize), DesktopError> {
        if Self::session_type() != "x11" {
            return Err(DesktopError::Unsupported);
        }
        x11rb::connect(None).map_err(|error| {
            DesktopError::Failed(format!("could not connect to the X11 display: {error}"))
        })
    }

    fn enumerate(&self) -> Result<Vec<RawTarget>, DesktopError> {
        let (connection, screen_index) = self.x11()?;
        enumerate_x11(&connection, screen_index)
    }
}

impl Desktop for LinuxDesktop {
    fn capabilities(&self) -> Capabilities {
        let session_type = Self::session_type();
        let x11_available = session_type == "x11";
        Capabilities {
            platform: "linux".into(),
            backend: if x11_available {
                "linux-x11-atspi".into()
            } else {
                "linux-unsupported".into()
            },
            // AT-SPI's widget/action coverage is application-dependent.
            fidelity: if x11_available {
                Fidelity::Partial
            } else {
                Fidelity::None
            },
            accessibility: if x11_available {
                PermissionState::NotRequested
            } else {
                PermissionState::Unsupported
            },
            // Pixel capture is provided by Chromium in the main process.
            capture: PermissionState::NotRequested,
            session_type: Some(session_type.into()),
            input_unsupported_reason: if x11_available {
                None
            } else if session_type == "wayland" {
                Some("computer input is not supported on Wayland; no portable compositor input API is available".into())
            } else {
                Some("no supported Linux desktop session was detected (X11 is required)".into())
            },
        }
    }

    fn request_permission(&self) -> Result<PermissionState, DesktopError> {
        if Self::session_type() != "x11" {
            return Err(DesktopError::Unsupported);
        }
        run_atspi(probe_atspi)?;
        Ok(PermissionState::Granted)
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        self.enumerate()
    }

    fn resolve_target(&self, target_id: &str) -> Result<Option<RawTarget>, DesktopError> {
        Ok(self
            .enumerate()?
            .into_iter()
            .find(|target| target.target.target_id == target_id))
    }

    fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
        let current = self
            .enumerate()?
            .into_iter()
            .find(|item| item.target.target_id == target.target_id)
            .ok_or(DesktopError::TargetGone)?;
        Ok(Measured {
            bounds: current.bounds,
            app_key: current.target.app_key,
            title: current.title,
        })
    }

    fn inspect(&self, target: &TargetRef, max_nodes: usize) -> Result<RawInspection, DesktopError> {
        self.inspect_with_sensitive_input(target, max_nodes, false)
    }

    fn inspect_with_sensitive_input(
        &self,
        target: &TargetRef,
        max_nodes: usize,
        allow_sensitive_input: bool,
    ) -> Result<RawInspection, DesktopError> {
        let target = target.clone();
        run_atspi(move |connection| {
            inspect_atspi(connection, target, max_nodes, allow_sensitive_input)
        })
    }

    fn secure_input_active(&self) -> bool {
        let Ok(targets) = self.enumerate() else {
            return true;
        };
        let Ok((connection, _)) = self.x11() else {
            return true;
        };
        let Ok(focus_cookie) = connection.get_input_focus() else {
            return true;
        };
        let Ok(focus) = focus_cookie.reply() else {
            return true;
        };
        let Some(target) = targets.into_iter().find(|target| {
            let Ok(window) = u32::try_from(target.target.window) else {
                return false;
            };
            is_descendant_window(&connection, focus.focus, window)
        }) else {
            return true;
        };
        run_atspi(move |connection| focused_password_field(connection, target)).unwrap_or(true)
    }

    fn perform(
        &self,
        target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let target = target.clone();
        let uid = uid.map(str::to_owned);
        let action = action.clone();
        run_atspi(move |connection| perform_atspi(connection, target, uid, action))
    }
}

type AtspiResult<T> = Result<T, DesktopError>;

fn run_atspi<T, F, Fut>(operation: F) -> AtspiResult<T>
where
    T: Send + 'static,
    F: FnOnce(BusConnection) -> Fut + Send + 'static,
    Fut: Future<Output = AtspiResult<T>> + 'static,
{
    thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                DesktopError::Failed(format!("could not start AT-SPI runtime: {error}"))
            })?;
        runtime.block_on(async move {
            let session = BusConnection::session().await.map_err(|error| {
                DesktopError::Failed(format!("AT-SPI session bus unavailable: {error}"))
            })?;
            let accessibility_bus =
                Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus")
                    .await
                    .map_err(atspi_error)?;
            let address: String = accessibility_bus
                .call("GetAddress", &())
                .await
                .map_err(atspi_error)?;
            let connection = atspi::zbus::connection::Builder::address(address.as_str())
                .map_err(atspi_error)?
                .build()
                .await
                .map_err(|error| {
                    DesktopError::Failed(format!("AT-SPI accessibility bus unavailable: {error}"))
                })?;
            operation(connection).await
        })
    })
    .join()
    .map_err(|_| DesktopError::Failed("AT-SPI worker panicked".into()))?
}

async fn inspect_atspi(
    connection: BusConnection,
    target: TargetRef,
    max_nodes: usize,
    allow_sensitive_input: bool,
) -> AtspiResult<RawInspection> {
    let x11 = LinuxDesktop::new().measure(&target)?;
    let pointer_input_supported = LinuxDesktop::new()
        .x11()
        .ok()
        .is_some_and(|(connection, _)| xtest_available(&connection));
    let root = window_root(&connection, &target, &x11.bounds, &x11.title).await?;
    let root_bus = root
        .name_as_str()
        .ok_or(DesktopError::TargetGone)?
        .to_owned();
    let mut pending = VecDeque::from([(root, None::<usize>)]);
    let mut nodes = Vec::with_capacity(max_nodes.min(64));
    let node_limit = max_nodes.clamp(1, 400);
    let mut truncated = false;

    while let Some((reference, parent)) = pending.pop_front() {
        if nodes.len() >= node_limit {
            truncated = true;
            break;
        }
        let bus = reference
            .name_as_str()
            .ok_or(DesktopError::ElementNotFound)?
            .to_owned();
        if bus != root_bus {
            continue;
        }
        let path = reference.path_as_str().to_owned();
        let accessible = accessible_proxy(&connection, &bus, &path).await?;
        let role = accessible.get_role().await.unwrap_or(Role::Invalid);
        let states = accessible.get_state().await.unwrap_or_default();
        let interfaces = accessible.get_interfaces().await.unwrap_or_default();
        let label = accessible
            .name()
            .await
            .ok()
            .map(|label| label.trim().to_string())
            .filter(|label| !label.is_empty());
        let bounds = component_bounds(&connection, &bus, &path).await;
        let is_password = role == Role::PasswordText;
        let mut actions = advertised_actions(&connection, &bus, &path, interfaces).await;
        if pointer_input_supported && bounds.is_some() {
            actions.extend([ActionKind::Hover, ActionKind::Drag]);
        }
        let index = nodes.len();
        nodes.push(Node {
            uid: format!("{bus}|{path}"),
            role: role.name().to_string(),
            label: if is_password && !allow_sensitive_input {
                None
            } else {
                label
            },
            has_value: is_password
                || interfaces.contains(Interface::EditableText)
                || interfaces.contains(Interface::Value),
            enabled: states.contains(State::Enabled) && states.contains(State::Sensitive),
            focused: states.contains(State::Focused),
            bounds: bounds.map(|rect| relative_rect(rect, x11.bounds)),
            parent,
            actions,
        });

        for child in accessible.get_children().await.unwrap_or_default() {
            if child
                .name_as_str()
                .is_some_and(|child_bus| child_bus == root_bus)
            {
                pending.push_back((child, Some(index)));
            }
        }
    }

    Ok(RawInspection {
        nodes,
        truncated: truncated || !pending.is_empty(),
        fidelity: Fidelity::Partial,
    })
}

async fn probe_atspi(connection: BusConnection) -> AtspiResult<()> {
    accessible_proxy(
        &connection,
        "org.a11y.atspi.Registry",
        "/org/a11y/atspi/accessible/root",
    )
    .await?
    .get_children()
    .await
    .map_err(atspi_error)?;
    Ok(())
}

async fn perform_atspi(
    connection: BusConnection,
    target: TargetRef,
    uid: Option<String>,
    action: Action,
) -> AtspiResult<Dispatched> {
    let kind = action.kind.ok_or(DesktopError::NotActionable)?;
    if kind == ActionKind::PressKeys {
        return Err(DesktopError::Unsupported);
    }
    let uid = uid.ok_or(DesktopError::ElementNotFound)?;
    let (bus, path) = uid.split_once('|').ok_or(DesktopError::ElementNotFound)?;
    let measured = LinuxDesktop::new().measure(&target)?;
    let root = window_root(&connection, &target, &measured.bounds, &measured.title).await?;
    let root_bus = root.name_as_str().ok_or(DesktopError::TargetGone)?;
    if bus != root_bus {
        return Err(DesktopError::ElementNotFound);
    }
    // Rebuild the live observation before dispatch. A stale or foreign UID is
    // never trusted merely because its string has the right shape.
    let observation = inspect_atspi(connection.clone(), target.clone(), 400, true).await?;
    let node = observation
        .nodes
        .iter()
        .find(|node| node.uid == uid)
        .ok_or(DesktopError::ElementNotFound)?;
    if !node.enabled || !node.actions.contains(&kind) {
        return Err(DesktopError::NotActionable);
    }

    if matches!(kind, ActionKind::Hover | ActionKind::Drag) {
        let (x11, screen_index) = LinuxDesktop::new().x11()?;
        if !xtest_available(&x11) {
            return Err(DesktopError::Unsupported);
        }
        let root = x11
            .setup()
            .roots
            .get(screen_index)
            .ok_or(DesktopError::Unsupported)?
            .root;
        match kind {
            ActionKind::Hover => {
                let point = action
                    .point
                    .or_else(|| {
                        node.bounds.map(|bounds| Point {
                            x: bounds.x + bounds.width / 2.0,
                            y: bounds.y + bounds.height / 2.0,
                        })
                    })
                    .ok_or(DesktopError::NotActionable)?;
                let (x, y) = absolute_pointer_point(measured.bounds, point)?;
                fake_pointer_input(&x11, root, MOTION_NOTIFY_EVENT, 0, x, y)?;
            }
            ActionKind::Drag => {
                let from = action.point.ok_or(DesktopError::NotActionable)?;
                let to = action.to.ok_or(DesktopError::NotActionable)?;
                let (from_x, from_y) = absolute_pointer_point(measured.bounds, from)?;
                let (to_x, to_y) = absolute_pointer_point(measured.bounds, to)?;
                fake_pointer_input(&x11, root, MOTION_NOTIFY_EVENT, 0, from_x, from_y)?;
                fake_pointer_input(&x11, root, BUTTON_PRESS_EVENT, 1, from_x, from_y)?;
                fake_pointer_input(&x11, root, MOTION_NOTIFY_EVENT, 0, to_x, to_y)?;
                fake_pointer_input(&x11, root, BUTTON_RELEASE_EVENT, 1, to_x, to_y)?;
            }
            _ => unreachable!("pointer branch checks hover and drag"),
        }
        return Ok(Dispatched::WindowEvent);
    }

    if kind == ActionKind::Scroll {
        let scroll = action.scroll.ok_or(DesktopError::NotActionable)?;
        let component = ComponentProxy::builder(&connection)
            .destination(bus)
            .map_err(atspi_error)?
            .path(path)
            .map_err(atspi_error)?
            .build()
            .await
            .map_err(atspi_error)?;
        let direction = if scroll.dx.abs() > scroll.dy.abs() {
            if scroll.dx >= 0.0 {
                ScrollType::RightEdge
            } else {
                ScrollType::LeftEdge
            }
        } else if scroll.dy >= 0.0 {
            ScrollType::BottomEdge
        } else {
            ScrollType::TopEdge
        };
        if !component.scroll_to(direction).await.map_err(atspi_error)? {
            return Err(DesktopError::NotActionable);
        }
        return Ok(Dispatched::AccessibilityAction);
    }

    if matches!(kind, ActionKind::SetValue | ActionKind::TypeText) {
        let text = action.text.as_deref().ok_or(DesktopError::NotActionable)?;
        let accessible = accessible_proxy(&connection, bus, path).await?;
        let interfaces = accessible.get_interfaces().await.map_err(atspi_error)?;
        if interfaces.contains(Interface::EditableText) {
            let editable = EditableTextProxy::builder(&connection)
                .destination(bus)
                .map_err(atspi_error)?
                .path(path)
                .map_err(atspi_error)?
                .build()
                .await
                .map_err(atspi_error)?;
            if !editable
                .set_text_contents(text)
                .await
                .map_err(atspi_error)?
            {
                return Err(DesktopError::Failed(
                    "AT-SPI rejected the text update".into(),
                ));
            }
        } else if kind == ActionKind::SetValue && interfaces.contains(Interface::Value) {
            let value = text
                .parse::<f64>()
                .map_err(|_| DesktopError::NotActionable)?;
            let value_proxy = ValueProxy::builder(&connection)
                .destination(bus)
                .map_err(atspi_error)?
                .path(path)
                .map_err(atspi_error)?
                .build()
                .await
                .map_err(atspi_error)?;
            value_proxy
                .set_current_value(value)
                .await
                .map_err(atspi_error)?;
        } else {
            return Err(DesktopError::NotActionable);
        }
        return Ok(Dispatched::AccessibilityAction);
    }

    let proxy = ActionProxy::builder(&connection)
        .destination(bus)
        .map_err(atspi_error)?
        .path(path)
        .map_err(atspi_error)?
        .build()
        .await
        .map_err(atspi_error)?;
    let actions = proxy.get_actions().await.map_err(atspi_error)?;
    let index = actions
        .iter()
        .position(|candidate| action_name_matches(&candidate.name, kind))
        .ok_or(DesktopError::NotActionable)?;
    let accepted = proxy.do_action(index as i32).await.map_err(atspi_error)?;
    if !accepted {
        return Err(DesktopError::Failed("AT-SPI action returned false".into()));
    }
    if kind == ActionKind::DoubleClick {
        let accepted = proxy.do_action(index as i32).await.map_err(atspi_error)?;
        if !accepted {
            return Err(DesktopError::Failed(
                "second AT-SPI click returned false".into(),
            ));
        }
    }
    Ok(Dispatched::AccessibilityAction)
}

async fn window_root(
    connection: &BusConnection,
    target: &TargetRef,
    bounds: &Rect,
    title: &str,
) -> AtspiResult<ObjectRefOwned> {
    let registry = accessible_proxy(
        connection,
        "org.a11y.atspi.Registry",
        "/org/a11y/atspi/accessible/root",
    )
    .await?;
    let dbus = Proxy::new(
        connection,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    )
    .await
    .map_err(atspi_error)?;
    let mut candidates = Vec::new();
    for application_ref in registry.get_children().await.map_err(atspi_error)? {
        let Some(bus) = application_ref.name_as_str() else {
            continue;
        };
        let pid: u32 = match dbus
            .call("GetConnectionUnixProcessID", &(bus.to_owned(),))
            .await
        {
            Ok(pid) => pid,
            Err(_) => continue,
        };
        if pid != target.pid as u32 {
            continue;
        }
        let application = accessible_proxy(connection, bus, application_ref.path_as_str()).await?;
        for window_ref in application.get_children().await.unwrap_or_default() {
            let Some(window_bus) = window_ref.name_as_str() else {
                continue;
            };
            if window_bus != bus {
                continue;
            }
            let path = window_ref.path_as_str();
            let window = accessible_proxy(connection, window_bus, path).await?;
            let role = window.get_role().await.unwrap_or(Role::Invalid);
            if !matches!(role, Role::Frame | Role::Window | Role::Dialog) {
                continue;
            }
            let name = window.name().await.unwrap_or_default();
            let Some(window_bounds) = component_bounds(connection, window_bus, path).await else {
                continue;
            };
            if rects_match(&window_bounds, bounds, &name, title) {
                candidates.push((rect_distance(&window_bounds, bounds), window_ref));
            }
        }
    }
    candidates.sort_by(|left, right| left.0.total_cmp(&right.0));
    if candidates
        .get(1)
        .is_some_and(|second| (candidates[0].0 - second.0).abs() < 1.0)
    {
        // Two accessibility top-levels are indistinguishable by the exposed
        // title and geometry. Do not guess which native XID the user chose.
        return Err(DesktopError::TargetGone);
    }
    candidates
        .into_iter()
        .next()
        .map(|(_, reference)| reference)
        .ok_or(DesktopError::TargetGone)
}

async fn accessible_proxy<'a>(
    connection: &'a BusConnection,
    bus: &'a str,
    path: &'a str,
) -> AtspiResult<AccessibleProxy<'a>> {
    AccessibleProxy::builder(connection)
        .destination(bus)
        .map_err(atspi_error)?
        .path(path)
        .map_err(atspi_error)?
        .build()
        .await
        .map_err(atspi_error)
}

async fn component_bounds(connection: &BusConnection, bus: &str, path: &str) -> Option<Rect> {
    let component = ComponentProxy::builder(connection)
        .destination(bus)
        .ok()?
        .path(path)
        .ok()?
        .build()
        .await
        .ok()?;
    let (x, y, width, height) = component.get_extents(CoordType::Screen).await.ok()?;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(Rect {
        x: f64::from(x),
        y: f64::from(y),
        width: f64::from(width),
        height: f64::from(height),
    })
}

async fn advertised_actions(
    connection: &BusConnection,
    bus: &str,
    path: &str,
    interfaces: atspi::proxy::common::InterfaceSet,
) -> Vec<ActionKind> {
    let mut actions = Vec::new();
    if interfaces.contains(Interface::EditableText) {
        actions.extend([ActionKind::SetValue, ActionKind::TypeText]);
    } else if interfaces.contains(Interface::Value) {
        actions.push(ActionKind::SetValue);
    }
    if interfaces.contains(Interface::Component) {
        actions.push(ActionKind::Scroll);
    }
    if interfaces.contains(Interface::Action) {
        if let Ok(proxy) = ActionProxy::builder(connection)
            .destination(bus)
            .and_then(|builder| builder.path(path))
        {
            if let Ok(proxy) = proxy.build().await {
                if let Ok(names) = proxy.get_actions().await {
                    for action in names {
                        for kind in [
                            ActionKind::Click,
                            ActionKind::DoubleClick,
                            ActionKind::RightClick,
                            ActionKind::Select,
                        ] {
                            if action_name_matches(&action.name, kind) && !actions.contains(&kind) {
                                actions.push(kind);
                            }
                        }
                    }
                }
            }
        }
    }
    actions
}

fn action_name_matches(name: &str, kind: ActionKind) -> bool {
    let name = name.to_ascii_lowercase().replace([' ', '_', '-'], "");
    match kind {
        ActionKind::Click | ActionKind::DoubleClick => {
            matches!(name.as_str(), "click" | "press" | "activate" | "invoke")
        }
        ActionKind::RightClick => matches!(name.as_str(), "showmenu" | "contextmenu"),
        ActionKind::Select => matches!(name.as_str(), "select" | "pick"),
        _ => false,
    }
}

async fn focused_password_field(connection: BusConnection, target: RawTarget) -> AtspiResult<bool> {
    let inspection = inspect_atspi(connection, target.target, 400, false).await?;
    Ok(inspection.nodes.iter().any(|node| {
        node.focused
            && matches!(
                node.role.as_str(),
                "password text" | "password" | "password field"
            )
    }))
}

fn relative_rect(rect: Rect, target: Rect) -> Rect {
    Rect {
        x: rect.x - target.x,
        y: rect.y - target.y,
        width: rect.width,
        height: rect.height,
    }
}

fn rects_match(accessible: &Rect, x11: &Rect, accessible_title: &str, x11_title: &str) -> bool {
    let accessible_title = accessible_title.trim();
    let x11_title = x11_title.trim();
    let title_known = !accessible_title.is_empty() && !x11_title.is_empty();
    let title_matches = title_known && accessible_title.eq_ignore_ascii_case(x11_title);
    if title_known && !title_matches {
        return false;
    }
    let width_ratio = accessible.width.min(x11.width) / accessible.width.max(x11.width).max(1.0);
    let height_ratio =
        accessible.height.min(x11.height) / accessible.height.max(x11.height).max(1.0);
    let position_close =
        (accessible.x - x11.x).abs() <= 150.0 && (accessible.y - x11.y).abs() <= 150.0;
    (title_matches && position_close && width_ratio >= 0.7 && height_ratio >= 0.55)
        || (!title_known && accessible.matches(x11))
}

fn rect_distance(left: &Rect, right: &Rect) -> f64 {
    (left.x - right.x).abs()
        + (left.y - right.y).abs()
        + (left.width - right.width).abs()
        + (left.height - right.height).abs()
}

fn is_descendant_window(connection: &RustConnection, mut child: Window, ancestor: Window) -> bool {
    for _ in 0..64 {
        if child == ancestor {
            return true;
        }
        let Ok(cookie) = connection.query_tree(child) else {
            return false;
        };
        let Ok(tree) = cookie.reply() else {
            return false;
        };
        if tree.parent == child || tree.parent == tree.root {
            return tree.parent == ancestor;
        }
        child = tree.parent;
    }
    false
}

fn atspi_error(error: impl std::fmt::Display) -> DesktopError {
    DesktopError::Failed(format!("AT-SPI request failed: {error}"))
}

fn enumerate_x11(
    connection: &RustConnection,
    screen_index: usize,
) -> Result<Vec<RawTarget>, DesktopError> {
    let screen = connection
        .setup()
        .roots
        .get(screen_index)
        .ok_or_else(|| DesktopError::Failed("X11 screen index is unavailable".into()))?;
    let root = screen.root;
    let client_list = atom(connection, b"_NET_CLIENT_LIST")?;
    let pid_atom = atom(connection, b"_NET_WM_PID")?;
    let utf8_atom = atom(connection, b"UTF8_STRING")?;
    let wm_name_atom = atom(connection, b"_NET_WM_NAME")?;
    let property = connection
        .get_property(
            false,
            root,
            client_list,
            AtomEnum::WINDOW,
            0,
            MAX_X11_WINDOWS as u32,
        )
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?;
    let windows = if let Some(windows) = property.value32() {
        windows.take(MAX_X11_WINDOWS).collect::<Vec<_>>()
    } else {
        // A minimal Xvfb/X11 session may not run a window manager and thus has
        // no EWMH client list. The root's direct children are top-level windows
        // in that case; map-state and PID checks below still filter them.
        connection
            .query_tree(root)
            .map_err(x11_error)?
            .reply()
            .map_err(x11_error)?
            .children
            .into_iter()
            .take(MAX_X11_WINDOWS)
            .collect()
    };

    let mut targets = Vec::new();
    for window in windows {
        if let Some(target) =
            target_for_window(connection, root, window, pid_atom, wm_name_atom, utf8_atom)?
        {
            targets.push(target);
        }
    }
    Ok(targets)
}

fn target_for_window(
    connection: &RustConnection,
    root: Window,
    window: Window,
    pid_atom: u32,
    wm_name_atom: u32,
    utf8_atom: u32,
) -> Result<Option<RawTarget>, DesktopError> {
    let attributes = match connection
        .get_window_attributes(window)
        .map_err(x11_error)?
        .reply()
    {
        Ok(attributes) if attributes.map_state == MapState::VIEWABLE => attributes,
        _ => return Ok(None),
    };
    let _ = attributes;
    let pid = match connection
        .get_property(false, window, pid_atom, AtomEnum::CARDINAL, 0, 1)
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?
        .value32()
        .and_then(|mut value| value.next())
    {
        Some(pid) if pid > 0 => pid,
        _ => return Ok(None),
    };
    let geometry = match connection.get_geometry(window).map_err(x11_error)?.reply() {
        Ok(geometry) if geometry.width > 0 && geometry.height > 0 => geometry,
        _ => return Ok(None),
    };
    let origin = connection
        .translate_coordinates(window, root, 0, 0)
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?;
    let title = window_title(connection, window, wm_name_atom, utf8_atom)?;
    let app_key = process_app_key(pid).unwrap_or_else(|| format!("pid-{pid}"));
    let target_id = target_id(pid, window, &app_key);
    Ok(Some(RawTarget {
        target: TargetRef {
            target_id,
            pid: pid as i32,
            window: u64::from(window),
            app_key: app_key.clone(),
        },
        app_name: app_key,
        title,
        bounds: Rect {
            x: f64::from(origin.dst_x),
            y: f64::from(origin.dst_y),
            width: f64::from(geometry.width),
            height: f64::from(geometry.height),
        },
        elevated: false,
    }))
}

fn window_title(
    connection: &RustConnection,
    window: Window,
    wm_name_atom: u32,
    utf8_atom: u32,
) -> Result<String, DesktopError> {
    let modern = connection
        .get_property(false, window, wm_name_atom, utf8_atom, 0, 2048)
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?
        .value;
    if !modern.is_empty() {
        return Ok(String::from_utf8_lossy(&modern).trim().to_string());
    }
    let legacy_atom = atom(connection, b"WM_NAME")?;
    let legacy = connection
        .get_property(false, window, legacy_atom, AtomEnum::ANY, 0, 2048)
        .map_err(x11_error)?
        .reply()
        .map_err(x11_error)?
        .value;
    Ok(String::from_utf8_lossy(&legacy).trim().to_string())
}

fn atom(connection: &RustConnection, name: &[u8]) -> Result<u32, DesktopError> {
    connection
        .intern_atom(false, name)
        .map_err(x11_error)?
        .reply()
        .map(|reply| reply.atom)
        .map_err(x11_error)
}

fn process_app_key(pid: u32) -> Option<String> {
    let path = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    Some(path.file_name()?.to_string_lossy().to_ascii_lowercase())
}

fn target_id(pid: u32, window: Window, app_key: &str) -> String {
    format!("{pid}:{window}:{app_key}")
}

fn session_type_from(
    explicit: &str,
    has_wayland_display: bool,
    has_x11_display: bool,
) -> &'static str {
    match explicit.trim().to_ascii_lowercase().as_str() {
        "wayland" => "wayland",
        "x11" => "x11",
        _ if has_wayland_display => "wayland",
        _ if has_x11_display => "x11",
        _ => "unknown",
    }
}

fn x11_error(error: impl std::fmt::Display) -> DesktopError {
    DesktopError::Failed(format!("X11 request failed: {error}"))
}

fn xtest_available(connection: &RustConnection) -> bool {
    connection
        .extension_information(xtest::X11_EXTENSION_NAME)
        .is_ok_and(|information| information.is_some())
}

fn absolute_pointer_point(bounds: Rect, point: Point) -> Result<(i16, i16), DesktopError> {
    if !point.x.is_finite()
        || !point.y.is_finite()
        || point.x < 0.0
        || point.y < 0.0
        || point.x >= bounds.width
        || point.y >= bounds.height
    {
        return Err(DesktopError::NotActionable);
    }
    let x = bounds.x + point.x;
    let y = bounds.y + point.y;
    if !x.is_finite() || !y.is_finite() {
        return Err(DesktopError::NotActionable);
    }
    let x = i16::try_from(x.round() as i64).map_err(|_| DesktopError::NotActionable)?;
    let y = i16::try_from(y.round() as i64).map_err(|_| DesktopError::NotActionable)?;
    Ok((x, y))
}

fn fake_pointer_input(
    connection: &RustConnection,
    root: Window,
    event_type: u8,
    detail: u8,
    x: i16,
    y: i16,
) -> Result<(), DesktopError> {
    connection
        .xtest_fake_input(event_type, detail, 0, root, x, y, 0)
        .map_err(x11_error)?
        .check()
        .map_err(x11_error)?;
    connection.flush().map_err(x11_error)
}

#[cfg(test)]
mod tests;
