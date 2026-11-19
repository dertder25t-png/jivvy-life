//! Built-in ad/tracker blocking for pane webviews (never the main UI webview).
//!
//! The committed EasyList/EasyPrivacy-derived rule JSON is compiled once by WebKit's
//! `UserContentFilterStore` (cached on disk, keyed by a hash of the JSON) and attached to each
//! pane's own `UserContentManager`. webkit2gtk-rs 2.0 does not wrap the filter-store API, so this
//! module calls the `webkit2gtk-sys` FFI directly. Everything here runs on the GTK main thread.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::ffi::{CStr, CString};
use std::io::Write;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use gtk::prelude::*;
use webkit2gtk::gio::ffi as gio_ffi;
use webkit2gtk::glib::{self, ffi as glib_ffi, gobject_ffi, translate::ToGlibPtr, WeakRef};
use webkit2gtk::{ffi, LoadEvent, WebView, WebViewExt};

const RULES_JSON: &str = include_str!("../blocklist/blocklist.json");
const KEY: &str = "jivvy-block-on";
const MAX_SITES: usize = 500;

// Mirrors of GTK-thread state, readable from any thread by `blocking_status`.
static READY: AtomicBool = AtomicBool::new(false);
static RULES: AtomicUsize = AtomicUsize::new(0);
static ENABLED_MIRROR: AtomicBool = AtomicBool::new(true);

struct Filter(*mut ffi::WebKitUserContentFilter);
impl Drop for Filter {
    fn drop(&mut self) {
        // SAFETY: we own one reference (transfer full from *_finish).
        unsafe { ffi::webkit_user_content_filter_unref(self.0) }
    }
}

thread_local! {
    static FILTER: RefCell<Option<Filter>> = const { RefCell::new(None) };
    static ENABLED: Cell<bool> = const { Cell::new(true) };
    static DISABLED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    static PANES: RefCell<Vec<WeakRef<WebView>>> = const { RefCell::new(Vec::new()) };
}

fn log(msg: &str) {
    let _ = writeln!(std::io::stderr(), "[blocking] {msg}");
}

/// Same rule as the list converter: `^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$`.
pub fn valid_domain(d: &str) -> bool {
    if d.is_empty() || d.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = d.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let (last, rest) = labels.split_last().unwrap_or((&"", &[]));
    let tld_ok = (2..=63).contains(&last.len()) && last.bytes().all(|b| b.is_ascii_lowercase());
    tld_ok
        && rest.iter().all(|l| {
            (1..=63).contains(&l.len())
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// Validated, lowercased, deduped, capped list of hosts.
pub fn clean_sites(sites: Vec<String>) -> HashSet<String> {
    sites
        .into_iter()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| valid_domain(s))
        .take(MAX_SITES)
        .collect()
}

fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn identifier() -> String {
    let hex = format!("{:016x}", fnv1a(RULES_JSON.as_bytes()));
    format!("jivvy-blocklist-{}", &hex[..12])
}

fn host_disabled(uri: &str) -> bool {
    let Some(host) = url::Url::parse(uri).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)) else {
        return false;
    };
    DISABLED.with(|d| {
        let d = d.borrow();
        if d.is_empty() {
            return false;
        }
        let mut h = host.as_str();
        loop {
            if d.contains(h) {
                return true;
            }
            match h.split_once('.') {
                Some((_, parent)) => h = parent,
                None => return false,
            }
        }
    })
}

/// Bring one pane in line with the global toggle, per-site list and compile state.
fn sync(wv: &WebView) {
    let Some(fp) = FILTER.with(|f| f.borrow().as_ref().map(|f| f.0)) else { return };
    let uri = wv.uri().map(|u| u.to_string()).unwrap_or_default();
    let want = ENABLED.with(Cell::get) && !host_disabled(&uri);
    // SAFETY: the key is only ever written below, always with a bool.
    let cur = unsafe { wv.data::<bool>(KEY).map(|p| *p.as_ref()).unwrap_or(false) };
    if want == cur {
        return;
    }
    let Some(ucm) = wv.user_content_manager() else { return };
    // SAFETY: `fp` is a live filter we hold a reference to; the manager takes its own reference.
    unsafe {
        if want {
            ffi::webkit_user_content_manager_add_filter(ucm.to_glib_none().0, fp);
        } else {
            ffi::webkit_user_content_manager_remove_filter(ucm.to_glib_none().0, fp);
        }
        wv.set_data(KEY, want);
    }
}

fn sync_all() {
    let live: Vec<WebView> = PANES.with(|p| {
        let mut p = p.borrow_mut();
        p.retain(|w| w.upgrade().is_some());
        p.iter().filter_map(|w| w.upgrade()).collect()
    });
    for wv in &live {
        sync(wv);
    }
}

/// Track a pane webview and keep its filter state current on every navigation.
pub fn register_pane(wv: &WebView) {
    PANES.with(|p| {
        let mut p = p.borrow_mut();
        p.retain(|w| w.upgrade().is_some());
        p.push(wv.downgrade());
    });
    wv.connect_load_changed(|w, ev| {
        if matches!(ev, LoadEvent::Started | LoadEvent::Redirected) {
            sync(w);
        }
    });
    sync(wv);
}

pub fn set_state(enabled: bool, sites: HashSet<String>) {
    ENABLED.with(|e| e.set(enabled));
    ENABLED_MIRROR.store(enabled, Ordering::SeqCst);
    DISABLED.with(|d| *d.borrow_mut() = sites);
    sync_all();
}

pub fn status() -> (bool, usize, bool) {
    (
        READY.load(Ordering::SeqCst),
        RULES.load(Ordering::SeqCst),
        ENABLED_MIRROR.load(Ordering::SeqCst),
    )
}

type AsyncCb = Box<dyn FnOnce(*mut gio_ffi::GAsyncResult)>;

unsafe extern "C" fn trampoline(
    _src: *mut gobject_ffi::GObject,
    res: *mut gio_ffi::GAsyncResult,
    data: glib_ffi::gpointer,
) {
    // SAFETY: `data` came from `cb_ptr`, and GIO invokes the callback exactly once.
    let cb = unsafe { Box::from_raw(data as *mut AsyncCb) };
    (*cb)(res);
}

fn cb_ptr(f: impl FnOnce(*mut gio_ffi::GAsyncResult) + 'static) -> glib_ffi::gpointer {
    Box::into_raw(Box::new(Box::new(f) as AsyncCb)) as glib_ffi::gpointer
}

/// Log and free a GError.
unsafe fn take_error(err: *mut glib_ffi::GError) -> String {
    if err.is_null() {
        return "unknown error".into();
    }
    let msg = unsafe { CStr::from_ptr((*err).message) }.to_string_lossy().into_owned();
    unsafe { glib_ffi::g_error_free(err) };
    msg
}

fn finish(f: *mut ffi::WebKitUserContentFilter) {
    FILTER.with(|c| *c.borrow_mut() = Some(Filter(f)));
    RULES.store(RULES_JSON.matches("\"action\":").count(), Ordering::SeqCst);
    READY.store(true, Ordering::SeqCst);
    sync_all();
}

/// Compile (or load the cached compile of) the embedded rules, asynchronously. Never fatal.
pub fn start_compile(dir: std::path::PathBuf) {
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log(&format!("disabled: cannot create {}: {e}", dir.display()));
        return;
    }
    let (Some(path), Some(id)) = (
        dir.to_str().and_then(|s| CString::new(s).ok()),
        CString::new(identifier()).ok(),
    ) else {
        log("disabled: bad store path");
        return;
    };
    // SAFETY: plain GIO async calls on the GTK thread. The store is deliberately leaked: it
    // lives for the whole process and in-flight callbacks reference it.
    unsafe {
        let store = ffi::webkit_user_content_filter_store_new(path.as_ptr());
        if store.is_null() {
            log("disabled: cannot create filter store");
            return;
        }
        let id_save = id.clone();
        let on_load = move |res: *mut gio_ffi::GAsyncResult| {
            let mut err = ptr::null_mut();
            let f = ffi::webkit_user_content_filter_store_load_finish(store, res, &mut err);
            if !f.is_null() {
                if !err.is_null() {
                    take_error(err);
                }
                finish(f);
                return;
            }
            if !err.is_null() {
                take_error(err); // not cached yet: compile below
            }
            let bytes = glib::Bytes::from_static(RULES_JSON.as_bytes());
            let keep = bytes.clone();
            let on_save = move |res: *mut gio_ffi::GAsyncResult| {
                let _keep = keep;
                let mut err = ptr::null_mut();
                let f = ffi::webkit_user_content_filter_store_save_finish(store, res, &mut err);
                if f.is_null() {
                    let msg = take_error(err);
                    log(&format!("disabled: rule compile failed: {msg}"));
                } else {
                    finish(f);
                }
            };
            ffi::webkit_user_content_filter_store_save(
                store,
                id_save.as_ptr(),
                bytes.to_glib_none().0,
                ptr::null_mut(),
                Some(trampoline),
                cb_ptr(on_save),
            );
        };
        ffi::webkit_user_content_filter_store_load(
            store,
            id.as_ptr(),
            ptr::null_mut(),
            Some(trampoline),
            cb_ptr(on_load),
        );
    }
}
