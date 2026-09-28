//! BlockMD desktop shell.
//!
//! The shell deliberately does **not** use `tauri-plugin-fs`. That plugin reads and
//! writes through a text API, and this project's whole premise is byte fidelity:
//! a BOM or a CRLF lost in the I/O layer defeats the splice layer no matter how
//! correct the splice layer is. These two commands move raw bytes and nothing else.
//! Decoding happens once, in the frontend, with `ignoreBOM` set.

use std::path::PathBuf;
use tauri::ipc::Response;

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
        .invoke_handler(tauri::generate_handler![read_file, write_file, startup_file])
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
