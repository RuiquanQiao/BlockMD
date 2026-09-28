//! BlockMD desktop shell.
//!
//! The shell deliberately does **not** use `tauri-plugin-fs`. That plugin reads and
//! writes through a text API, and this project's whole premise is byte fidelity:
//! a BOM or a CRLF lost in the I/O layer defeats the splice layer no matter how
//! correct the splice layer is. These commands move raw bytes and nothing else;
//! `write_asset` only ever creates new files (pasted or dropped images).
//! Decoding happens once, in the frontend, with `ignoreBOM` set.

use std::io::Write;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};

/// Read a file as raw bytes. No decoding, no newline translation, no BOM handling.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// Write raw bytes to a path, replacing whatever is there.
#[tauri::command]
fn write_file(path: String, contents: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// Write a *new* file — an image pasted or dropped into a document, saved next to it.
///
/// The bytes arrive as the raw request body (a JSON number array would be megabytes
/// of text for one screenshot); the path comes in the `path` header, URI-encoded.
/// Missing folders are created, and an existing file is never overwritten: the
/// frontend picks a free name, and `create_new` makes that a guarantee rather than a
/// hope.
#[tauri::command]
fn write_asset(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_asset expects raw bytes".into());
    };
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .map(|v| percent_decode(v))
        .ok_or("write_asset needs a path header")?;
    let path = PathBuf::from(path);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    file.write_all(bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// Decode %XX escapes (the frontend encodes the path with encodeURIComponent).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The file the app was launched with, if any.
///
/// This is what makes "double-click a .md" work once the app is installed and the
/// file association is registered. In `tauri dev` there is no association, so this
/// returns `None` unless a path is passed on the command line.
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, write_asset, startup_file])
        .setup(|app| {
            // Self-update from GitHub Releases (see app/updater.js). The process plugin
            // is only here to relaunch once an update is installed.
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
