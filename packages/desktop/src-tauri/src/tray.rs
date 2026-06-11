use crate::state::SharedState;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{
    tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent},
    ActivationPolicy, AppHandle, Emitter, Manager, PhysicalPosition,
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

/// When pinned, the window stays open on blur (it is NOT always-on-top —
/// other windows can cover it; it just doesn't auto-hide).
static WINDOW_PINNED: AtomicBool = AtomicBool::new(false);

pub fn set_pinned(pinned: bool) {
    WINDOW_PINNED.store(pinned, Ordering::Relaxed);
}

pub fn is_pinned() -> bool {
    WINDOW_PINNED.load(Ordering::Relaxed)
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
    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .title("<3")
        .tooltip("Herzies")
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

/// Update the tray title based on connectivity state.
/// `connected` = true shows `<3`, false shows `</3`.
pub fn set_connected(app: &AppHandle, connected: bool) {
    let was_connected = IS_CONNECTED.swap(connected, Ordering::Relaxed);
    if was_connected == connected {
        return;
    }

    let title = if connected { "<3" } else { "</3" };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(Some(title));
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
    // Switch to Regular so the app can take focus
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    // Use saved user position if available, otherwise anchor below tray icon
    if HAS_USER_POSITION.load(Ordering::Relaxed) {
        let x = USER_X.load(Ordering::Relaxed) as i32;
        let y = USER_Y.load(Ordering::Relaxed) as i32;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    } else {
        let tray_x = TRAY_X.load(Ordering::Relaxed) as i32;
        let tray_y = TRAY_Y.load(Ordering::Relaxed) as i32;
        let tray_w = TRAY_WIDTH.load(Ordering::Relaxed) as i32;
        if tray_x > 0 || tray_y > 0 {
            if let Ok(win_size) = window.outer_size() {
                let win_w = win_size.width as i32;
                let x = tray_x + (tray_w / 2) - (win_w / 2);
                let _ = window.set_position(PhysicalPosition::new(x, tray_y));
            }
        } else {
            let _ = window.center();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();
}

fn hide_window(app: &AppHandle, window: &tauri::WebviewWindow) {
    // Save window position before hiding so we can restore it
    if let Ok(pos) = window.outer_position() {
        USER_X.store(pos.x as u64, Ordering::Relaxed);
        USER_Y.store(pos.y as u64, Ordering::Relaxed);
        HAS_USER_POSITION.store(true, Ordering::Relaxed);
    }
    WINDOW_VISIBLE.store(false, Ordering::Relaxed);
    let _ = window.hide();
    // Switch back to Accessory (no dock icon)
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

/// Called when the window gains focus — cancels any pending hide and checks for deep links.
pub fn on_focus(app: &AppHandle) {
    HIDE_PENDING.store(false, Ordering::Relaxed);
    // Focus implies the window is on-screen; covers dev mode where show_window isn't used.
    WINDOW_VISIBLE.store(true, Ordering::Relaxed);
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
