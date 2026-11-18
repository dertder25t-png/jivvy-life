//! Firefox session import (cookies -> WebKit cookie manager) and saved-password import
//! (OS keyring via Secret Service). Cookie values and passwords are never logged and
//! passwords are never returned to the frontend.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const SERVICE: &str = "jivvy-life";
static INDEX_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
pub struct CookieImport {
    imported: usize,
    skipped: usize,
    profile: String,
}

#[derive(Serialize)]
pub struct PasswordImport {
    imported: usize,
    skipped: usize,
}

/* ---------------------------- Firefox profile ---------------------------- */

fn firefox_roots() -> Vec<PathBuf> {
    let Ok(home) = std::env::var("HOME") else { return vec![] };
    let h = PathBuf::from(home);
    vec![h.join(".mozilla/firefox"), h.join("snap/firefox/common/.mozilla/firefox"), h.join(".var/app/org.mozilla.firefox/.mozilla/firefox")]
}

fn find_profile() -> Option<PathBuf> {
    for root in firefox_roots() {
        let Ok(ini) = std::fs::read_to_string(root.join("profiles.ini")) else { continue };
        // (section, key->value)
        let mut sections: Vec<(String, BTreeMap<String, String>)> = vec![];
        for line in ini.lines() {
            let line = line.trim();
            if line.starts_with('[') && line.ends_with(']') {
                sections.push((line[1..line.len() - 1].to_string(), BTreeMap::new()));
            } else if let (Some((k, v)), Some(last)) = (line.split_once('='), sections.last_mut()) {
                last.1.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
        let resolve = |path: &str, rel: bool| if rel { root.join(path) } else { PathBuf::from(path) };
        let mut candidates: Vec<PathBuf> = vec![];
        for (name, kv) in &sections {
            if name.starts_with("Install") {
                if let Some(p) = kv.get("Default") {
                    candidates.push(resolve(p, true));
                }
            }
        }
        for (name, kv) in &sections {
            if name.starts_with("Profile") && kv.get("Default").map(|v| v == "1").unwrap_or(false) {
                if let Some(p) = kv.get("Path") {
                    candidates.push(resolve(p, kv.get("IsRelative").map(|v| v != "0").unwrap_or(true)));
                }
            }
        }
        for (name, kv) in &sections {
            if name.starts_with("Profile") {
                if let Some(p) = kv.get("Path") {
                    candidates.push(resolve(p, kv.get("IsRelative").map(|v| v != "0").unwrap_or(true)));
                }
            }
        }
        if let Some(p) = candidates.into_iter().find(|p| p.join("cookies.sqlite").exists()) {
            return Some(p);
        }
    }
    None
}

struct RawCookie {
    name: String,
    value: String,
    host: String,
    path: String,
    max_age: i32,
    secure: bool,
    http_only: bool,
    same_site: i64,
}

fn read_cookies() -> Result<(Vec<RawCookie>, usize, String), String> {
    let profile = find_profile().ok_or("No Firefox profile with cookies.sqlite found")?;
    let pname = profile.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = std::env::temp_dir().join(format!("jivvy-ffcookies-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(Vec<RawCookie>, usize), String> {
        for f in ["cookies.sqlite", "cookies.sqlite-wal", "cookies.sqlite-shm"] {
            let src = profile.join(f);
            if src.exists() {
                std::fs::copy(&src, tmp.join(f)).map_err(|e| format!("copy {f}: {e}"))?;
            }
        }
        let conn = rusqlite::Connection::open(tmp.join("cookies.sqlite")).map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies")
            .map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7).unwrap_or(0),
                ))
            })
            .map_err(|e| e.to_string())?;
        let (mut out, mut skipped) = (vec![], 0usize);
        for row in rows {
            let Ok((name, value, host, path, mut expiry, sec, ho, ss)) = row else {
                skipped += 1;
                continue;
            };
            if expiry > 100_000_000_000 {
                expiry /= 1000; // newer Firefox stores milliseconds
            }
            let max_age = if expiry <= 0 { 30 * 86400 } else { expiry - now };
            if max_age <= 0 || name.is_empty() || host.is_empty() {
                skipped += 1;
                continue;
            }
            out.push(RawCookie {
                name,
                value,
                host,
                path: if path.is_empty() { "/".into() } else { path },
                max_age: max_age.min(400 * 86400) as i32,
                secure: sec != 0,
                http_only: ho != 0,
                same_site: ss,
            });
        }
        Ok((out, skipped))
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    let (c, s) = result?;
    Ok((c, s, pname))
}

#[tauri::command]
pub async fn import_firefox_cookies(app: AppHandle) -> Result<CookieImport, String> {
    #[allow(unused_mut)]
    let (cookies, mut skipped, profile) = tauri::async_runtime::spawn_blocking(read_cookies).await.map_err(|e| e.to_string())??;
    let imported = cookies.len();
    #[cfg(target_os = "linux")]
    {
        let main = app.get_webview("main").ok_or("main webview not found")?;
        main.with_webview(move |pw| {
            use webkit2gtk::{CookieManagerExt, WebViewExt, WebsiteDataManagerExt};
            let Some(cm) = pw.inner().website_data_manager().and_then(|d| d.cookie_manager()) else { return };
            for c in cookies {
                let mut ck = soup::Cookie::new(&c.name, &c.value, &c.host, &c.path, c.max_age);
                ck.set_secure(c.secure);
                ck.set_http_only(c.http_only);
                ck.set_same_site_policy(match c.same_site {
                    1 => soup::SameSitePolicy::Lax,
                    2 => soup::SameSitePolicy::Strict,
                    _ => soup::SameSitePolicy::None,
                });
                cm.add_cookie(&mut ck, None::<&webkit2gtk::gio::Cancellable>, |_| {});
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (&app, &cookies);
        skipped += imported;
    }
    Ok(CookieImport { imported, skipped, profile })
}

/* ------------------------------ passwords ------------------------------ */

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.join("logins_index.json"))
}

fn read_index(p: &Path) -> BTreeMap<String, Vec<String>> {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn origin_of(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    Some(u.origin().ascii_serialization())
}

fn key_user(origin: &str, username: &str) -> String {
    format!("{origin}|{username}")
}

#[tauri::command]
pub async fn import_passwords_csv(app: AppHandle, csv: String) -> Result<PasswordImport, String> {
    let ipath = index_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut rdr = csv::ReaderBuilder::new().flexible(true).from_reader(csv.trim_start_matches('\u{feff}').as_bytes());
        let headers = rdr.headers().map_err(|e| e.to_string())?.clone();
        let col = |n: &str| headers.iter().position(|h| h.eq_ignore_ascii_case(n));
        let (Some(cu), Some(cn), Some(cp)) = (col("url"), col("username"), col("password")) else {
            return Err("CSV must have url, username, password columns".to_string());
        };
        let crealm = col("httpRealm");
        let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut index = read_index(&ipath);
        let (mut imported, mut skipped) = (0usize, 0usize);
        for rec in rdr.records() {
            let Ok(rec) = rec else {
                skipped += 1;
                continue;
            };
            let (url, user, pass) = (rec.get(cu).unwrap_or(""), rec.get(cn).unwrap_or(""), rec.get(cp).unwrap_or(""));
            let is_http_auth = crealm.and_then(|i| rec.get(i)).map(|r| !r.is_empty()).unwrap_or(false);
            let Some(origin) = origin_of(url) else {
                skipped += 1;
                continue;
            };
            if user.is_empty() || pass.is_empty() || is_http_auth {
                skipped += 1;
                continue;
            }
            let ok = keyring::Entry::new(SERVICE, &key_user(&origin, user)).and_then(|e| e.set_password(pass)).is_ok();
            if !ok {
                skipped += 1;
                continue;
            }
            let list = index.entry(origin).or_default();
            if !list.iter().any(|u| u == user) {
                list.push(user.to_string());
            }
            imported += 1;
        }
        std::fs::write(&ipath, serde_json::to_string(&index).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if imported == 0 && skipped > 0 {
            return Err("No passwords could be stored (is a Secret Service keyring such as GNOME Keyring/KWallet running and unlocked?)".into());
        }
        Ok(PasswordImport { imported, skipped })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn logins_for(app: AppHandle, origin: String) -> Vec<String> {
    let Some(origin) = origin_of(&origin) else { return vec![] };
    let Ok(p) = index_path(&app) else { return vec![] };
    read_index(&p).remove(&origin).unwrap_or_default()
}

#[tauri::command]
pub async fn fill_login(app: AppHandle, label: String, username: String) -> Result<(), String> {
    let wv = app.get_webview(&label).ok_or("pane not found")?;
    let origin = origin_of(wv.url().map_err(|e| e.to_string())?.as_str()).ok_or("page is not http(s)")?;
    let ipath = index_path(&app)?;
    if !read_index(&ipath).get(&origin).map(|l| l.iter().any(|u| *u == username)).unwrap_or(false) {
        return Err("no saved login for this site".into());
    }
    let key = key_user(&origin, &username);
    let pass = tauri::async_runtime::spawn_blocking(move || keyring::Entry::new(SERVICE, &key).and_then(|e| e.get_password()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("keyring: {e}"))?;
    let js = format!(
        "(function(u,p){{\
const vis=e=>e.offsetParent!==null||e.getClientRects().length>0;\
const set=(e,v)=>{{const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,v);\
e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}));}};\
const all=[...document.querySelectorAll('input')].filter(vis);\
const pw=all.find(e=>e.type==='password');\
let un=null;\
if(pw){{const i=all.indexOf(pw);for(let k=i-1;k>=0;k--){{if(['text','email','tel',''].includes(all[k].type)){{un=all[k];break;}}}}}}\
else{{un=all.find(e=>['email','text'].includes(e.type)&&/user|email|login|mail/i.test((e.name||'')+(e.id||'')+(e.autocomplete||'')))||null;}}\
if(un)set(un,u);if(pw)set(pw,p);}})({},{});",
        serde_json::to_string(&username).map_err(|e| e.to_string())?,
        serde_json::to_string(&pass).map_err(|e| e.to_string())?
    );
    // Re-check after the keyring wait: the page may have navigated to another origin meanwhile.
    let now = wv.url().ok().and_then(|u| origin_of(u.as_str()));
    if now.as_deref() != Some(origin.as_str()) {
        return Err("page changed before filling; try again".into());
    }
    wv.eval(&js).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn forget_all_logins(app: AppHandle) -> Result<usize, String> {
    let ipath = index_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let index = read_index(&ipath);
        let mut n = 0;
        for (origin, users) in &index {
            for u in users {
                if let Ok(e) = keyring::Entry::new(SERVICE, &key_user(origin, u)) {
                    if e.delete_credential().is_ok() {
                        n += 1;
                    }
                }
            }
        }
        let _ = std::fs::remove_file(&ipath);
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}
