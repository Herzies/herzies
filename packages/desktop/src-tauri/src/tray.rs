use crate::state::SharedState;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{
    tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
};

/// Tracks current connectivity state to avoid redundant updates.
static IS_CONNECTED: AtomicBool = AtomicBool::new(true);

/// Whether a delayed hide is pending (used to cancel on re-focus).
static HIDE_PENDING: AtomicBool = AtomicBool::new(false);

/// Whether the window is currently visible to the user. Background loops
/// read this to throttle polling when the user can't see the result.
static WINDOW_VISIBLE: AtomicBool = AtomicBool::new(false);

pub fn is_window_visible() -> bool {
    WINDOW_VISIBLE.load(Ordering::Relaxed)
}

/// Whether the window has keyboard focus — narrower than visible: a pinned
/// window stays visible after the user moves on to another app. Lets loops
/// whose results only matter to someone actively looking (sync cadence) relax
/// for a pinned window sitting in the background.
static WINDOW_FOCUSED: AtomicBool = AtomicBool::new(false);

pub fn is_window_focused() -> bool {
    WINDOW_FOCUSED.load(Ordering::Relaxed)
}

/// When pinned, the window stays open on blur (it is NOT always-on-top —
/// other windows can cover it; it just doesn't auto-hide).
static WINDOW_PINNED: AtomicBool = AtomicBool::new(true);

pub fn set_pinned(pinned: bool) {
    WINDOW_PINNED.store(pinned, Ordering::Relaxed);
}

pub fn is_pinned() -> bool {
    WINDOW_PINNED.load(Ordering::Relaxed)
}

/// "Ghost mode" — while enabled, no listening is tracked (no XP, minutes, or
/// now-playing reported to the server). Session-only; resets to off on launch.
static GHOST_MODE: AtomicBool = AtomicBool::new(false);

pub fn set_ghost_mode(enabled: bool) {
    GHOST_MODE.store(enabled, Ordering::Relaxed);
}

pub fn is_ghost_mode() -> bool {
    GHOST_MODE.load(Ordering::Relaxed)
}

/// Stored tray icon position for anchoring the window below it.
static TRAY_X: AtomicU64 = AtomicU64::new(0);
static TRAY_Y: AtomicU64 = AtomicU64::new(0);
static TRAY_WIDTH: AtomicU64 = AtomicU64::new(0);

/// Whether the user has repositioned the window (persists saved position).
static HAS_USER_POSITION: AtomicBool = AtomicBool::new(false);
static USER_X: AtomicU64 = AtomicU64::new(0);
static USER_Y: AtomicU64 = AtomicU64::new(0);

/// Timestamp (ms) of last tray-triggered show, used to suppress immediate blur.
static LAST_TRAY_SHOW: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub const TRAY_ID: &str = "herzies-tray";

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("Herzies");

    // macOS renders the tray title as text directly in the menu bar, so the
    // connected/disconnected signal (`<3` / `</3`) lives there and no icon
    // image is needed. Windows' notification area has no such text-title
    // convention — it needs a real icon image, and the connectivity signal
    // moves to the tooltip instead (see `set_connected`).
    #[cfg(target_os = "macos")]
    {
        builder = builder.title("<3");
    }
    #[cfg(windows)]
    {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
        builder = builder.icon(icon);
    }

    let _tray = builder
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                // Store tray icon position in physical pixels for window anchoring
                let scale = tray
                    .app_handle()
                    .get_webview_window("main")
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                let (px, py) = match rect.position {
                    tauri::Position::Physical(p) => (p.x, p.y),
                    tauri::Position::Logical(l) => ((l.x * scale) as i32, (l.y * scale) as i32),
                };
                let (sw, sh) = match rect.size {
                    tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
                    tauri::Size::Logical(l) => {
                        ((l.width * scale) as i32, (l.height * scale) as i32)
                    }
                };
                TRAY_X.store(px as u64, Ordering::Relaxed);
                TRAY_Y.store((py + sh) as u64, Ordering::Relaxed);
                TRAY_WIDTH.store(sw as u64, Ordering::Relaxed);
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Snapshot the current AppState and broadcast it to the frontend. Used
/// from window-visibility transitions where we want the UI to refresh
/// without waiting for the next sync tick.
fn emit_state_update(app: &AppHandle) {
    if let Some(state) = app.try_state::<SharedState>() {
        let app_state = {
            let s = state.lock().unwrap();
            s.to_app_state(env!("CARGO_PKG_VERSION"))
        };
        let _ = app.emit("state-update", &app_state);
    }
}

/// Reflect connectivity state in the tray — macOS shows it as the menu-bar
/// title (`<3` / `</3`), Windows (no tray text convention) shows it in the
/// tooltip instead.
pub fn set_connected(app: &AppHandle, connected: bool) {
    let was_connected = IS_CONNECTED.swap(connected, Ordering::Relaxed);
    if was_connected == connected {
        return;
    }

    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        let title = if connected { "<3" } else { "</3" };
        let _ = tray.set_title(Some(title));
    }
    #[cfg(windows)]
    {
        let tooltip = if connected {
            "Herzies"
        } else {
            "Herzies (offline)"
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

pub fn ensure_visible(app: &AppHandle) {
    // Always cancel pending hide (e.g. notification click may race with blur timer)
    HIDE_PENDING.store(false, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(true) {
            let _ = window.set_focus();
        } else {
            show_window(app, &window);
        }
    }
}

pub fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            hide_window(app, &window);
        } else {
            show_window(app, &window);
        }
    }
}

fn show_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    HIDE_PENDING.store(false, Ordering::Relaxed);
    LAST_TRAY_SHOW.store(now_ms(), Ordering::Relaxed);
    WINDOW_VISIBLE.store(true, Ordering::Relaxed);
    // Re-emit state so the UI picks up the freshly-derived is_connected
    // (and any other state that changed while hidden) without having to
    // wait up to 60s for the next sync_tick.
    emit_state_update(app);
    // Switch to Regular so the app can take focus (macOS only — no dock/menu-
    // bar activation-policy concept elsewhere).
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    // Use saved user position if available, otherwise anchor below tray icon.
    // Either may point at a display that has since been disconnected, so only
    // use a position whose window would still land on a connected monitor.
    let user_pos = HAS_USER_POSITION.load(Ordering::Relaxed).then(|| {
        PhysicalPosition::new(
            USER_X.load(Ordering::Relaxed) as i32,
            USER_Y.load(Ordering::Relaxed) as i32,
        )
    });
    let tray_pos = {
        let tray_x = TRAY_X.load(Ordering::Relaxed) as i32;
        let tray_y = TRAY_Y.load(Ordering::Relaxed) as i32;
        let tray_w = TRAY_WIDTH.load(Ordering::Relaxed) as i32;
        (tray_x > 0 || tray_y > 0)
            .then(|| window.outer_size().ok())
            .flatten()
            .map(|win_size| {
                let x = tray_x + (tray_w / 2) - (win_size.width as i32 / 2);
                PhysicalPosition::new(x, tray_y)
            })
    };
    let pos = user_pos.filter(|p| is_on_screen(window, *p)).or_else(|| {
        // The saved spot is gone (e.g. external monitor unplugged) — forget it.
        HAS_USER_POSITION.store(false, Ordering::Relaxed);
        tray_pos.filter(|p| is_on_screen(window, *p))
    });
    match pos {
        Some(p) => {
            let _ = window.set_position(p);
        }
        None => {
            let _ = window.center();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();
}

/// Whether a window placed at `pos` would have its center on a connected
/// monitor. Fails open if the monitor list can't be read.
fn is_on_screen(window: &tauri::WebviewWindow, pos: PhysicalPosition<i32>) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return true;
    };
    let (w, h) = window
        .outer_size()
        .map(|s| (s.width as i32, s.height as i32))
        .unwrap_or((0, 0));
    let (cx, cy) = (pos.x + w / 2, pos.y + h / 2);
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        cx >= mp.x && cx < mp.x + ms.width as i32 && cy >= mp.y && cy < mp.y + ms.height as i32
    })
}

fn hide_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    // Save window position before hiding so we can restore it
    if let Ok(pos) = window.outer_position() {
        USER_X.store(pos.x as u64, Ordering::Relaxed);
        USER_Y.store(pos.y as u64, Ordering::Relaxed);
        HAS_USER_POSITION.store(true, Ordering::Relaxed);
    }
    WINDOW_VISIBLE.store(false, Ordering::Relaxed);
    WINDOW_FOCUSED.store(false, Ordering::Relaxed);
    let _ = window.hide();
    // Switch back to Accessory (no dock icon) — macOS only.
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Called when the window gains focus — cancels any pending hide and checks for deep links.
pub fn on_focus(app: &AppHandle) {
    HIDE_PENDING.store(false, Ordering::Relaxed);
    // Focus implies the window is on-screen; covers dev mode where show_window isn't used.
    WINDOW_VISIBLE.store(true, Ordering::Relaxed);
    WINDOW_FOCUSED.store(true, Ordering::Relaxed);
    // Same rationale as in show_window: refresh derived state (connectivity,
    // multipliers, etc.) immediately on re-focus.
    emit_state_update(app);
    // Check for pending deep link
    if let Ok(mut dl) = app.state::<crate::PendingDeepLink>().0.lock() {
        if let Some(item_id) = dl.take() {
            let _ = app.emit("deep-link", item_id);
        }
    }
}

/// Called when the window loses focus.
/// Schedules a delayed hide so that tray-click re-focus can cancel it.
pub fn on_blur(app: &AppHandle) {
    WINDOW_FOCUSED.store(false, Ordering::Relaxed);
    // Pinned windows stay open when they lose focus.
    if is_pinned() {
        return;
    }

    // Suppress blur if the window was just shown via tray click (within 500ms).
    // This prevents the mouse-release on the tray icon from immediately hiding the window.
    let elapsed = now_ms().saturating_sub(LAST_TRAY_SHOW.load(Ordering::Relaxed));
    if elapsed < 500 {
        return;
    }

    HIDE_PENDING.store(true, Ordering::Relaxed);
    let app = app.clone();

    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        if HIDE_PENDING.swap(false, Ordering::Relaxed) {
            if let Some(window) = app.get_webview_window("main") {
                hide_window(&app, &window);
            }
        }
    });
}

/// The Town's big window, in logical pixels (capped to the screen), and the
/// app's usual small one.
const TOWN_SIZE: (f64, f64) = (1024.0, 700.0);
const SMALL_SIZE: (f64, f64) = (380.0, 520.0);
/// How far the big window keeps in from the screen's usable edges.
const SCREEN_MARGIN: f64 = 24.0;

/// Whether the window is at the Town's big size, and where the small one
/// stood before it grew (to put it back there).
static TOWN_EXPANDED: AtomicBool = AtomicBool::new(false);
static SMALL_X: AtomicI64 = AtomicI64::new(0);
static SMALL_Y: AtomicI64 = AtomicI64::new(0);

/// Grow the window to the Town's big size, or shrink it back. Growing keeps
/// its top edge, centres it where it was and keeps it all on the screen it's
/// on; shrinking puts the small window back exactly where it was.
pub fn set_town_expanded(app: &AppHandle, expanded: bool) {
    if TOWN_EXPANDED.swap(expanded, Ordering::Relaxed) == expanded {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if !expanded {
        let _ = window.set_size(LogicalSize::new(SMALL_SIZE.0, SMALL_SIZE.1));
        let _ = window.set_position(PhysicalPosition::new(
            SMALL_X.load(Ordering::Relaxed) as i32,
            SMALL_Y.load(Ordering::Relaxed) as i32,
        ));
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    SMALL_X.store(pos.x as i64, Ordering::Relaxed);
    SMALL_Y.store(pos.y as i64, Ordering::Relaxed);
    let scale = window.scale_factor().unwrap_or(1.0);
    let area = window
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| *m.work_area());
    // The big size, in physical pixels, no bigger than the screen allows.
    let margin = (SCREEN_MARGIN * scale) as i32;
    let mut w = (TOWN_SIZE.0 * scale) as i32;
    let mut h = (TOWN_SIZE.1 * scale) as i32;
    if let Some(a) = &area {
        w = w
            .min(a.size.width as i32 - 2 * margin)
            .max(size.width as i32);
        h = h
            .min(a.size.height as i32 - 2 * margin)
            .max(size.height as i32);
    }
    // Same top, same centre, then nudged back onto the screen.
    let mut x = pos.x + size.width as i32 / 2 - w / 2;
    let mut y = pos.y;
    if let Some(a) = &area {
        let (ax, ay) = (a.position.x, a.position.y);
        let (aw, ah) = (a.size.width as i32, a.size.height as i32);
        x = x.clamp(ax + margin, (ax + aw - margin - w).max(ax + margin));
        y = y.clamp(ay + margin, (ay + ah - margin - h).max(ay + margin));
    }
    let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}
