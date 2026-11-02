use std::{sync::Mutex, thread, time::Duration};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates(Mutex<Option<Update>>);

pub fn available(app: &AppHandle) -> Option<String> {
    app.state::<Updates>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|update| update.version.clone())
}

// The app can stay in the tray for days, so it looks again now and then. A
// check that fails, such as with no network, waits for the next one.
pub fn watch(app: &AppHandle) {
    let app = app.clone();

    thread::spawn(move || loop {
        if let Ok(Some(update)) = tauri::async_runtime::block_on(check(&app)) {
            let version = update.version.clone();
            *app.state::<Updates>().0.lock().unwrap() = Some(update);
            crate::refresh_tray(&app);
            let _ = app.emit("update", version);
        }

        thread::sleep(Duration::from_secs(6 * 60 * 60));
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater()?.check().await
}

// Restarting stops the servers the app started, so the new pipoca serves.
#[tauri::command]
pub async fn update(app: AppHandle) -> Result<(), String> {
    let Some(update) = app.state::<Updates>().0.lock().unwrap().clone() else {
        return Ok(());
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Couldn't update: {e}"))?;

    app.restart();
}
