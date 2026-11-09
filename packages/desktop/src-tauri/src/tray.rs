use crate::state::SharedState;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
#[cfg(not(target_os = "macos"))]
use tauri::tray::{MouseButtonState, TrayIconEvent};
#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;
use tauri::{
    tray::TrayIconBuilder, AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
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

/// On macOS Herzies is a regular app (Dock, Cmd-Tab), and the menu-bar icon
/// is its listening side: a native menu saying what's playing, with ghost
/// mode, Open and Quit. Closing the window leaves that running.
#[cfg(target_os = "macos")]
mod mac_menu {
    use std::sync::{Mutex, OnceLock};
    use tauri::{
        image::Image,
        menu::{CheckMenuItem, IconMenuItem, Menu, MenuItem, PredefinedMenuItem},
        AppHandle, Emitter, Wry,
    };

    pub struct Items {
        pub user: IconMenuItem<Wry>,
        pub listening: MenuItem<Wry>,
        pub ghost: CheckMenuItem<Wry>,
    }
    pub static ITEMS: OnceLock<Items> = OnceLock::new();
    /// The listening line as last set, to skip redundant updates.
    static LAST_LINE: Mutex<String> = Mutex::new(String::new());
    /// Who's logged in and whether they're online, as last shown.
    static LAST_USER: Mutex<Option<(String, bool)>> = Mutex::new(None);

    /// A filled circle, 2x for Retina: green online, grey offline.
    fn dot(online: bool) -> Image<'static> {
        const SIZE: u32 = 24;
        let (r, g, b) = if online {
            (52, 199, 89)
        } else {
            (142, 142, 147)
        };
        let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
        let c = (SIZE as f32 - 1.0) / 2.0;
        // Smaller than the slot: the menu draws the icon at its own size.
        let radius = 5.5;
        for y in 0..SIZE {
            for x in 0..SIZE {
                let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
                let a = (radius + 0.5 - d).clamp(0.0, 1.0);
                let i = ((y * SIZE + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(&[r, g, b, (a * 255.0) as u8]);
            }
        }
        Image::new_owned(rgba, SIZE, SIZE)
    }

    pub const NOT_LISTENING: &str = "Not listening";

    pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
        let user = IconMenuItem::with_id(
            app,
            "user",
            "Not logged in",
            false,
            Some(dot(false)),
            None::<&str>,
        )?;
        let listening = MenuItem::with_id(app, "listening", NOT_LISTENING, false, None::<&str>)?;
        let ghost = CheckMenuItem::with_id(
            app,
            "ghost",
            "Ghost mode (pause tracking)",
            true,
            super::is_ghost_mode(),
            None::<&str>,
        )?;
        let open = MenuItem::with_id(app, "open", "Open Herzies", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit Herzies", true, Some("Cmd+Q"))?;
        let menu = Menu::with_items(
            app,
            &[
                &user,
                &PredefinedMenuItem::separator(app)?,
                &listening,
                &PredefinedMenuItem::separator(app)?,
                &ghost,
                &PredefinedMenuItem::separator(app)?,
                &open,
                &quit,
            ],
        )?;
        *LAST_LINE.lock().unwrap() = NOT_LISTENING.to_string();
        let _ = ITEMS.set(Items {
            user,
            listening,
            ghost,
        });
        Ok(menu)
    }

    pub fn on_event(app: &AppHandle, id: &str) {
        match id {
            "open" => super::ensure_visible(app),
            "quit" => app.exit(0),
            "ghost" => {
                let enabled = !super::is_ghost_mode();
                super::set_ghost_mode(enabled);
                sync_ghost();
                // The Settings toggle follows (tauri-bridge listens).
                let _ = app.emit("ghost-mode", enabled);
            }
            _ => {}
        }
    }

    pub fn sync_ghost() {
        if let Some(items) = ITEMS.get() {
            let _ = items.ghost.set_checked(super::is_ghost_mode());
        }
    }

    pub fn set_user(name: Option<&str>, online: bool) {
        let next = (
            name.unwrap_or("Not logged in").to_string(),
            online && name.is_some(),
        );
        let mut last = LAST_USER.lock().unwrap();
        if last.as_ref() == Some(&next) {
            return;
        }
        if let Some(items) = ITEMS.get() {
            let _ = items.user.set_text(&next.0);
            let _ = items.user.set_icon(Some(dot(next.1)));
        }
        *last = Some(next);
    }

    pub fn set_line(line: String) {
        let mut last = LAST_LINE.lock().unwrap();
        if *last == line {
            return;
        }
        if let Some(items) = ITEMS.get() {
            let _ = items.listening.set_text(&line);
        }
        *last = line;
    }
}

/// What the tray menu says is playing (macOS): the track, or nothing.
pub fn set_listening(track: Option<(&str, &str)>) {
    #[cfg(target_os = "macos")]
    mac_menu::set_line(match track {
        Some((title, artist)) => format!("Listening to {title} — {artist}"),
        None => mac_menu::NOT_LISTENING.to_string(),
    });
    #[cfg(not(target_os = "macos"))]
    let _ = track;
}

/// Who the tray menu says is logged in (macOS), with a green dot while
/// they're online (connected to the server), grey otherwise.
pub fn set_user(name: Option<&str>) {
    #[cfg(target_os = "macos")]
    mac_menu::set_user(name, IS_CONNECTED.load(Ordering::Relaxed));
    #[cfg(not(target_os = "macos"))]
    let _ = name;
}

/// Keep the tray menu's ghost-mode tick in step with Settings (macOS).
pub fn sync_ghost_menu() {
    #[cfg(target_os = "macos")]
    mac_menu::sync_ghost();
}

/// Hide the window but keep the app (and its listening) running. On macOS
/// the Dock icon goes too, until the window comes back.
pub fn close_to_tray(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        hide_window(app, &window);
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id(TRAY_ID).tooltip("Herzies");

    // macOS renders the tray title as text directly in the menu bar, so the
    // connected/disconnected signal (`<3` / `</3`) lives there and no icon
    // image is needed. Windows' notification area has no such text-title
    // convention — it needs a real icon image, and the connectivity signal
    // moves to the tooltip instead (see `set_connected`).
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title("<3")
            .menu(&mac_menu::build(app)?)
            .show_menu_on_left_click(true)
            .on_menu_event(|app, event| mac_menu::on_event(app, event.id().as_ref()));
    }
    #[cfg(windows)]
    {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
        builder = builder.icon(icon);
    }

    // On macOS a click opens the menu instead (see mac_menu).
    #[cfg(target_os = "macos")]
    let _tray = builder.build(app)?;
    #[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
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
    let _ = app.emit("window-visible", true);
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

/// Give the borderless main window native macOS corners. macOS only rounds
/// (and shadows) titled windows, so turn the title bar on but make it
/// invisible: transparent overlay, no title text, no native buttons. The
/// window buttons are drawn by the top bar instead (TitleBar.tsx), where the
/// green one can toggle the small and big window.
#[cfg(target_os = "macos")]
pub fn use_native_corners(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility};

    // Set the style straight on the NSWindow: Tauri's set_decorations /
    // set_title_bar_style leave the native title bar and buttons showing.
    let window = window.clone();
    // AppKit calls must run on the main thread.
    let _ = window.clone().run_on_main_thread(move || {
        let Ok(ptr) = window.ns_window() else { return };
        // SAFETY: Tauri hands back the live NSWindow for this webview window,
        // and we're on the main thread.
        let ns_window = unsafe { &*(ptr as *const NSWindow) };
        ns_window.setStyleMask(
            ns_window.styleMask()
                | NSWindowStyleMask::Titled
                | NSWindowStyleMask::FullSizeContentView,
        );
        ns_window.setTitlebarAppearsTransparent(true);
        ns_window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
        for kind in [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ] {
            if let Some(button) = ns_window.standardWindowButton(kind) {
                button.setHidden(true);
            }
        }
    });
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
    // The page pauses the Town and its animations on this (useWindowVisible),
    // not only on the browser's own idea of hidden.
    let _ = app.emit("window-visible", false);
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
    // Pinned windows stay open when they lose focus, and on macOS the window
    // is a regular app window that always does.
    if cfg!(target_os = "macos") || is_pinned() {
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
/// Both include the 28px top bar (TitleBar.tsx).
const TOWN_SIZE: (f64, f64) = (1024.0, 728.0);
const SMALL_SIZE: (f64, f64) = (380.0, 548.0);
/// How far the big window keeps in from the screen's usable edges.
const SCREEN_MARGIN: f64 = 24.0;

/// Whether the window is at the Town's big size, and where the small one
/// stood before it grew (to put it back there).
/// The app opens big (tauri.conf.json): the world in the big window is
/// where it starts.
static TOWN_EXPANDED: AtomicBool = AtomicBool::new(true);
static SMALL_X: AtomicI64 = AtomicI64::new(0);
static SMALL_Y: AtomicI64 = AtomicI64::new(0);
/// Whether SMALL_X/Y hold where the small window stood. Not before it's
/// first grown: opening big, there's no small spot yet.
static HAS_SMALL_POS: AtomicBool = AtomicBool::new(false);

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
        // Where it stood before it grew; or, opened big, under the big one's
        // top, centred on it.
        let pos = if HAS_SMALL_POS.load(Ordering::Relaxed) {
            Some(PhysicalPosition::new(
                SMALL_X.load(Ordering::Relaxed) as i32,
                SMALL_Y.load(Ordering::Relaxed) as i32,
            ))
        } else {
            match (window.outer_position(), window.outer_size()) {
                (Ok(p), Ok(s)) => {
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let w = (SMALL_SIZE.0 * scale) as i32;
                    Some(PhysicalPosition::new(p.x + s.width as i32 / 2 - w / 2, p.y))
                }
                _ => None,
            }
        };
        let _ = window.set_size(LogicalSize::new(SMALL_SIZE.0, SMALL_SIZE.1));
        if let Some(pos) = pos {
            let _ = window.set_position(pos);
        }
        return;
    }
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    SMALL_X.store(pos.x as i64, Ordering::Relaxed);
    SMALL_Y.store(pos.y as i64, Ordering::Relaxed);
    HAS_SMALL_POS.store(true, Ordering::Relaxed);
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
