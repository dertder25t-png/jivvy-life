mod logins;
use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};

/// Linux: tauri-runtime-wry packs every child webview into the window's GtkBox, so
/// they stack vertically and set_position/set_size are ignored. We wrap the main
/// webview in a GtkOverlay and move pane webviews into it, positioned by margins.
#[cfg(target_os = "linux")]
mod linux {
    use gtk::prelude::*;
    use std::cell::RefCell;

    thread_local! {
        static OVERLAY: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
    }

    pub fn wrap_main(wv: &gtk::Widget) {
        let Some(vbox) = wv.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else {
            return;
        };
        let overlay = gtk::Overlay::new();
        vbox.remove(wv); // `wv` holds a strong ref, so the widget survives the move
        overlay.add(wv);
        vbox.pack_start(&overlay, true, true, 0);
        overlay.show_all();
        OVERLAY.with(|o| *o.borrow_mut() = Some(overlay));
    }

    pub fn place(wv: &gtk::Widget, x: i32, y: i32, w: i32, h: i32) {
        OVERLAY.with(|o| {
            let Some(overlay) = o.borrow().clone() else { return };
            let overlay_widget: &gtk::Widget = overlay.upcast_ref();
            if wv.parent().as_ref() != Some(overlay_widget) {
                if let Some(c) = wv.parent().and_then(|p| p.downcast::<gtk::Container>().ok()) {
                    c.remove(wv);
                }
                wv.set_halign(gtk::Align::Start);
                wv.set_valign(gtk::Align::Start);
                overlay.add_overlay(wv);
            }
            wv.set_margin_start(x.max(0));
            wv.set_margin_top(y.max(0));
            wv.set_size_request(w.max(1), h.max(1));
        });
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


// ---- Dashboard: laya (local NPU classifier) + daily brief ----

const LAYA_ADDR: &str = "127.0.0.1:8770";

/// Minimal blocking HTTP/1.1 call to laya. None when it is down, slow, or answers non-200.
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

/// POST /decide {text} -> {ok, p_ai, ms}. None if laya is unavailable.
#[tauri::command(async)]
fn laya_classify(text: String) -> Option<serde_json::Value> {
    let body = serde_json::json!({ "text": text }).to_string();
    laya_http("POST", "/decide", Some(&body)).filter(|v| v.get("ok") == Some(&serde_json::Value::Bool(true)))
}

/// GET /health -> {ok, ready, device, infer_device, ...}. None if laya is unavailable.
#[tauri::command(async)]
fn laya_health() -> Option<serde_json::Value> {
    laya_http("GET", "/health", None)
}

fn brief_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".local/share/hub-dashboard/brief/latest.json"))
}

/// Latest nightly Downloads brief written by downloads_sorter.py, or None.
#[tauri::command(async)]
fn read_brief() -> Option<serde_json::Value> {
    let txt = std::fs::read_to_string(brief_path()?).ok()?;
    serde_json::from_str(&txt).ok()
}

/// Open a folder/file with the desktop default handler (only inside the user's home).
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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![place_pane, laya_classify, laya_health, read_brief, open_path, logins::import_firefox_cookies, logins::import_passwords_csv, logins::logins_for, logins::fill_login, logins::forget_all_logins])
        .setup(|app| {
            // Bare window + auto-resizing UI webview so pane webviews can be added as children.
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
            _main.with_webview(|pw| {
                use gtk::prelude::*;
                linux::wrap_main(&pw.inner().upcast());
            })?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Life App");
}
