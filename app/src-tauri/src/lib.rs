mod logins;
#[cfg(target_os = "linux")]
mod blocking;
use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};

#[cfg(target_os = "linux")]
mod linux {
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};

    thread_local! {
        static OVERLAY: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
        // True when we (not the user/WM) put the toplevel into fullscreen for a pane video.
        static FS_BY_US: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    fn toplevel_of(wv: &gtk::Widget) -> Option<gtk::Window> {
        wv.toplevel().and_then(|t| t.downcast::<gtk::Window>().ok())
    }

    pub fn exit_fullscreen_toplevel(wv: &gtk::Widget) {
        if FS_BY_US.with(|f| f.replace(false)) {
            if let Some(win) = toplevel_of(wv) {
                win.unfullscreen();
            }
        }
    }
    // All webviews share one WebsiteDataManager; point its cookie store at disk exactly once.
    static COOKIES_SET: AtomicBool = AtomicBool::new(false);

    pub fn wrap_main(wv: &gtk::Widget) {
        let Some(vbox) = wv.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
            return;
        };
        let overlay = gtk::Overlay::new();
        vbox.remove(wv);
        overlay.add(wv);
        vbox.pack_start(&overlay, true, true, 0);
        overlay.show_all();
        OVERLAY.with(|o| *o.borrow_mut() = Some(overlay));
    }

    pub fn place(wv: &gtk::Widget, x: i32, y: i32, w: i32, h: i32) {
        OVERLAY.with(|o| {
            let Some(overlay) = o.borrow().clone() else { return };
            let overlay_widget: &gtk::Widget = overlay.upcast_ref();
            // A pane that was closed/destroyed has no parent: never re-add a dead widget.
            if wv.parent().is_none() {
                return;
            }
            if wv.parent().as_ref() != Some(overlay_widget) {
                if let Some(c) = wv.parent().and_then(|p| p.downcast::<gtk::Container>().ok()) {
                    c.remove(wv);
                }
                wv.set_halign(gtk::Align::Start);
                wv.set_valign(gtk::Align::Start);
                overlay.add_overlay(wv);
            }
            if wv.margin_start() != x.max(0) {
                wv.set_margin_start(x.max(0));
            }
            if wv.margin_top() != y.max(0) {
                wv.set_margin_top(y.max(0));
            }
            let (cur_w, cur_h) = wv.size_request();
            if cur_w != w.max(1) || cur_h != h.max(1) {
                wv.set_size_request(w.max(1), h.max(1));
            }
        });
    }

    /// Sends target="_blank" links and window.open popups (Eagle's Nest, Canvas, SSO) to the
    /// frontend as a new app tab instead of dropping them, enables persistent disk cookies, and
    /// (for pane webviews) reports page title/URL changes so the tab label stays in sync.
    pub fn configure_webkit(
        wv: &webkit2gtk::WebView,
        cookie_file: Option<std::path::PathBuf>,
        app: tauri::AppHandle,
        pane_label: Option<String>,
    ) {
        use tauri::Emitter;
        use webkit2gtk::{
            CookieManagerExt, CookiePersistentStorage, NavigationPolicyDecision,
            NavigationPolicyDecisionExt, PolicyDecisionExt, PolicyDecisionType, SettingsExt,
            URIRequestExt, WebViewExt, WebsiteDataManagerExt,
        };

        fn open_in_new_tab(app: &tauri::AppHandle, uri: &str) {
            if uri.is_empty() || uri == "about:blank" {
                return;
            }
            let _ = app.emit("lifeapp:new-tab", serde_json::json!({ "url": uri }));
        }
        // Mark the WebView object itself (labels are reused when a pane is recreated).
        unsafe {
            if wv.data::<bool>("jivvy-configured").is_some() {
                return; // already configured: don't stack duplicate signal handlers
            }
            wv.set_data("jivvy-configured", true);
        }
        if let Some(settings) = WebViewExt::settings(wv) {
            settings.set_javascript_can_open_windows_automatically(true);
            settings.set_enable_back_forward_navigation_gestures(true);
        }
        if let Some(path) = cookie_file {
            if !COOKIES_SET.swap(true, Ordering::SeqCst) {
                if let Some(cm) = wv.website_data_manager().and_then(|d| d.cookie_manager()) {
                    if let Some(p) = path.to_str() {
                        cm.set_persistent_storage(p, CookiePersistentStorage::Sqlite);
                    }
                }
            }
        }
        // Ad/tracker blocking applies to pane webviews only, never the main UI.
        if pane_label.is_some() {
            crate::blocking::register_pane(wv);
        }
        // target="_blank" links arrive as a NewWindowAction policy decision.
        let app_policy = app.clone();
        wv.connect_decide_policy(move |_webview, decision, decision_type| {
            if decision_type == PolicyDecisionType::NewWindowAction {
                if let Ok(nav_decision) = decision.clone().downcast::<NavigationPolicyDecision>() {
                    if let Some(uri) = nav_decision
                        .navigation_action()
                        .and_then(|a| a.request())
                        .and_then(|r| r.uri())
                    {
                        open_in_new_tab(&app_policy, &uri);
                        decision.ignore();
                        return true;
                    }
                }
            }
            false
        });

        // window.open() from page scripts arrives through the `create` signal instead.
        let app_create = app.clone();
        wv.connect_create(move |_webview, action| {
            let action = action.clone();
            if let Some(uri) = action.request().and_then(|r| r.uri()) {
                open_in_new_tab(&app_create, &uri);
            }
            None
        });

        // Keep the owning tab's title/URL in sync with what the page actually shows.
        if let Some(label) = pane_label {
            // Video fullscreen. Returning false from enter/leave-fullscreen lets WebKit run its
            // default handler (fullscreen the toplevel GtkWindow); we also do it explicitly so
            // the window is fullscreen even if WebKit leaves a child webview's toplevel alone.
            let (app_fs, label_fs) = (app.clone(), label.clone());
            wv.connect_enter_fullscreen(move |w| {
                let top = toplevel_of(w.upcast_ref());
                if let Some(win) = top {
                    let already = win
                        .window()
                        .map(|g| g.state().contains(gtk::gdk::WindowState::FULLSCREEN))
                        .unwrap_or(false);
                    if !already {
                        FS_BY_US.with(|f| f.set(true));
                        win.fullscreen();
                    }
                }
                let _ = app_fs.emit("lifeapp:fullscreen", serde_json::json!({ "label": label_fs, "on": true }));
                false
            });
            let (app_fs, label_fs) = (app.clone(), label.clone());
            wv.connect_leave_fullscreen(move |w| {
                exit_fullscreen_toplevel(w.upcast_ref());
                let _ = app_fs.emit("lifeapp:fullscreen", serde_json::json!({ "label": label_fs, "on": false }));
                false
            });
            let (app_au, label_au) = (app.clone(), label.clone());
            wv.connect_is_playing_audio_notify(move |w| {
                let _ = app_au.emit(
                    "lifeapp:audio",
                    serde_json::json!({ "label": label_au, "playing": w.is_playing_audio() }),
                );
            });
            // title/uri notify fire many times per load; only emit real changes.
            let last = std::rc::Rc::new(RefCell::new((String::new(), String::new())));
            let report = move |webview: &webkit2gtk::WebView| {
                let url = webview.uri().map(|u| u.to_string()).unwrap_or_default();
                if url.is_empty() || url == "about:blank" {
                    return;
                }
                let title = webview.title().map(|t| t.to_string()).unwrap_or_default();
                {
                    let mut l = last.borrow_mut();
                    if l.0 == url && l.1 == title {
                        return;
                    }
                    *l = (url.clone(), title.clone());
                }
                let _ = app.emit(
                    "lifeapp:page",
                    serde_json::json!({ "label": label, "url": url, "title": title }),
                );
            };
            let report_title = report.clone();
            wv.connect_title_notify(move |w| report_title(w));
            wv.connect_uri_notify(move |w| report(w));
        }
    }
}

#[tauri::command]
fn place_pane(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        use tauri::Manager;
        let wv = app.get_webview(&label).ok_or("unknown webview")?;
        wv.with_webview(move |pw| {
            let w: gtk::Widget = pw.inner().upcast();
            linux::place(&w, x.round() as i32, y.round() as i32, width.round() as i32, height.round() as i32);
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, label, x, y, width, height);
    Ok(())
}

/// Leave video fullscreen: ask the page to exit, and release the window if we fullscreened it.
#[tauri::command]
fn exit_fullscreen(app: tauri::AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        use tauri::Manager;
        let wv = app.get_webview(&label).ok_or("unknown webview")?;
        let _ = wv.eval("(document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document);");
        wv.with_webview(move |pw| {
            let w: gtk::Widget = pw.inner().upcast();
            linux::exit_fullscreen_toplevel(&w);
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, label);
    Ok(())
}

/// True while the pane is producing audio. Runs on the GTK thread; the command itself is async
/// so waiting for the answer never blocks that thread.
#[tauri::command(async)]
fn pane_playing_audio(app: tauri::AppHandle, label: String) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let wv = app.get_webview(&label).ok_or("unknown webview")?;
        let (tx, rx) = std::sync::mpsc::channel();
        wv.with_webview(move |pw| {
            use webkit2gtk::WebViewExt;
            let _ = tx.send(pw.inner().is_playing_audio());
        })
        .map_err(|e| e.to_string())?;
        rx.recv_timeout(std::time::Duration::from_secs(2)).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, label);
        Ok(false)
    }
}

#[tauri::command]
fn set_pane_muted(app: tauri::AppHandle, label: String, muted: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let wv = app.get_webview(&label).ok_or("unknown webview")?;
        wv.with_webview(move |pw| {
            use webkit2gtk::WebViewExt;
            pw.inner().set_is_muted(muted);
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, label, muted);
    Ok(())
}

#[derive(serde::Serialize)]
struct BlockingStatus {
    ready: bool,
    rules: usize,
    enabled: bool,
}

#[tauri::command]
fn blocking_status() -> BlockingStatus {
    #[cfg(target_os = "linux")]
    {
        let (ready, rules, enabled) = blocking::status();
        BlockingStatus { ready, rules, enabled }
    }
    #[cfg(not(target_os = "linux"))]
    BlockingStatus { ready: false, rules: 0, enabled: false }
}

#[tauri::command]
fn set_blocking(app: tauri::AppHandle, enabled: bool, disabled_sites: Vec<String>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let sites = blocking::clean_sites(disabled_sites);
        app.run_on_main_thread(move || blocking::set_state(enabled, sites))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, enabled, disabled_sites);
    Ok(())
}

/// "appimage" when launched from an AppImage (the only build the updater can replace), else "native".
#[tauri::command]
fn install_kind() -> &'static str {
    if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else {
        "native"
    }
}

#[tauri::command]
fn configure_pane(app: tauri::AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use tauri::Manager;
        let wv = app.get_webview(&label).ok_or("unknown webview")?;
        let cookie_path = app.path().app_data_dir().ok().map(|d| {
            let _ = std::fs::create_dir_all(&d);
            d.join("webkit_cookies.sqlite")
        });
        let handle = app.clone();
        let pane_label = label.clone();
        wv.with_webview(move |pw| {
            linux::configure_webkit(&pw.inner(), cookie_path, handle, Some(pane_label));
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, label);
    Ok(())
}

/// Navigate an existing pane in place (keeps its history; no close + recreate flash).
#[tauri::command]
fn load_pane(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    use tauri::Manager;
    if !(url.starts_with("http://") || url.starts_with("https://") || url == "about:blank") {
        return Err("unsupported url".into());
    }
    let wv = app.get_webview(&label).ok_or("unknown webview")?;
    let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn nav_pane(app: tauri::AppHandle, label: String, action: String) -> Result<(), String> {
    use tauri::Manager;
    let wv = app.get_webview(&label).ok_or("unknown webview")?;
    let js = match action.as_str() {
        "back" => "window.history.back();",
        "forward" => "window.history.forward();",
        "reload" => "window.location.reload();",
        // Not called on hide (background audio keeps playing); kept for explicit use.
        "pause" => "document.querySelectorAll('video,audio').forEach(m=>{try{m.pause()}catch(e){}});",
        _ => return Ok(()),
    };
    wv.eval(js).map_err(|e| e.to_string())
}

const LAYA_ADDR: &str = "127.0.0.1:8770";

fn laya_http(method: &str, path: &str, body: Option<&str>) -> Option<serde_json::Value> {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let t = Duration::from_millis(1500);
    let addr: SocketAddr = LAYA_ADDR.parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, t).ok()?;
    s.set_read_timeout(Some(t)).ok()?;
    s.set_write_timeout(Some(t)).ok()?;
    let b = body.unwrap_or("");
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: {LAYA_ADDR}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{b}",
        b.len()
    );
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let (head, rest) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return None;
    }
    serde_json::from_str(rest).ok()
}

#[tauri::command(async)]
fn laya_classify(text: String) -> Option<serde_json::Value> {
    let body = serde_json::json!({ "text": text }).to_string();
    laya_http("POST", "/decide", Some(&body)).filter(|v| v.get("ok") == Some(&serde_json::Value::Bool(true)))
}

#[tauri::command(async)]
fn laya_health() -> Option<serde_json::Value> {
    laya_http("GET", "/health", None)
}

fn brief_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".local/share/hub-dashboard/brief/latest.json"))
}

#[tauri::command(async)]
fn read_brief() -> Option<serde_json::Value> {
    let txt = std::fs::read_to_string(brief_path()?).ok()?;
    serde_json::from_str(&txt).ok()
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let p = std::path::Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    if !p.starts_with(&home) {
        return Err("outside home".into());
    }
    std::process::Command::new("xdg-open").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Rendering: keep WebKitGTK's default GPU (DMA-BUF) path. Measured on this machine
    // (Intel Arc, KDE Wayland, 135% scale): ~60 fps scrolling by default vs ~20 fps with
    // WEBKIT_DISABLE_DMABUF_RENDERER=1, which made browsing feel like 10 fps. If GPU crashes
    // return, launch with JIVVY_SAFE_GPU=1 to use the slower shared-memory renderer.
    #[cfg(target_os = "linux")]
    if std::env::var_os("JIVVY_SAFE_GPU").is_some() {
        // SAFETY: called at startup before any other threads exist.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            place_pane,
            install_kind,
            configure_pane,
            set_blocking,
            blocking_status,
            nav_pane,
            exit_fullscreen,
            pane_playing_audio,
            set_pane_muted,
            load_pane,
            laya_classify,
            laya_health,
            read_brief,
            open_path,
            logins::import_firefox_cookies,
            logins::import_passwords_csv,
            logins::logins_for,
            logins::fill_login,
            logins::forget_all_logins
        ])
        .setup(|app| {
            use tauri::Manager;
            let (w, h) = (1440.0, 900.0);
            let window = WindowBuilder::new(app, "main")
                .title("Jivvy Life")
                .inner_size(w, h)
                .resizable(true)
                .build()?;
            let _main = window.add_child(
                WebviewBuilder::new("main", WebviewUrl::default()).auto_resize(),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(w, h),
            )?;
            #[cfg(target_os = "linux")]
            {
                if let Ok(dir) = app.path().app_data_dir() {
                    let dir = dir.join("content-filters");
                    // Compile/load asynchronously on the GTK thread; failure only logs.
                    let _ = app.handle().run_on_main_thread(move || blocking::start_compile(dir));
                }
                let cookie_path = app.path().app_data_dir().ok().map(|d| {
                    let _ = std::fs::create_dir_all(&d);
                    d.join("webkit_cookies.sqlite")
                });
                let handle = app.handle().clone();
                _main.with_webview(move |pw| {
                    use gtk::prelude::*;
                    linux::wrap_main(&pw.inner().upcast());
                    // Main UI: new-window links become tabs instead of replacing the app shell.
                    linux::configure_webkit(&pw.inner(), cookie_path, handle, None);
                })?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Jivvy Life");
}
