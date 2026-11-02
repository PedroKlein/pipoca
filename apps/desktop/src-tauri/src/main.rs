#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom},
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

mod sign_in;

const AT_LOGIN: &str = "--at-login";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: String,
    name: String,
    #[serde(flatten)]
    place: Place,
    #[serde(default)]
    at_login: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum Place {
    ThisMac { folders: Vec<String> },
    Ssh { host: String, local_port: u16 },
    Server { url: Url },
}

// A connection whose server was already running has no child of the app's.
struct Running {
    pid: Option<u32>,
    origin: Option<Url>,
}

struct Desktop {
    file: PathBuf,
    logs: PathBuf,
    connections: Mutex<Vec<Connection>>,
    running: Mutex<HashMap<String, Running>>,
    launcher: Mutex<Option<Url>>,
    path: Option<String>,
    signing_in: Mutex<HashMap<String, sign_in::Pending>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Listing {
    connections: Vec<Connection>,
    running: Vec<String>,
    signing_in: Vec<String>,
    home: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stopped {
    id: String,
    error: String,
    log: PathBuf,
}

#[tauri::command]
fn list(desktop: State<Desktop>) -> Listing {
    Listing {
        connections: desktop.connections.lock().unwrap().clone(),
        running: desktop.running.lock().unwrap().keys().cloned().collect(),
        signing_in: desktop
            .signing_in
            .lock()
            .unwrap()
            .values()
            .map(|pending| pending.id.clone())
            .collect(),
        home: home(),
    }
}

#[tauri::command]
fn save(app: AppHandle, connections: Vec<Connection>) -> Result<(), String> {
    let desktop = app.state::<Desktop>();
    let json = serde_json::to_vec_pretty(&connections).map_err(|e| e.to_string())?;

    if let Some(dir) = desktop.file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    fs::write(&desktop.file, json).map_err(|e| e.to_string())?;

    let autostart = app.autolaunch();
    let wanted = connections.iter().any(|c| c.at_login);

    if wanted != autostart.is_enabled().unwrap_or(false) {
        let changed = if wanted {
            autostart.enable()
        } else {
            autostart.disable()
        };
        changed.map_err(|e| e.to_string())?;
    }

    *desktop.connections.lock().unwrap() = connections;
    refresh_tray(&app);

    Ok(())
}

#[tauri::command]
fn open(app: AppHandle, id: String) -> Result<(), String> {
    start(&app, &id, true)
}

#[tauri::command]
fn stop(app: AppHandle, id: String) {
    let desktop = app.state::<Desktop>();
    let running = desktop.running.lock().unwrap().remove(&id);

    if let Some(Running { pid: Some(pid), .. }) = running {
        terminate(pid);
    }

    refresh_tray(&app);
}

fn start(app: &AppHandle, id: &str, show: bool) -> Result<(), String> {
    let desktop = app.state::<Desktop>();

    if let Some(running) = desktop.running.lock().unwrap().get(id) {
        if let (true, Some(origin)) = (show, &running.origin) {
            navigate(app, origin.clone());
        }

        return Ok(());
    }

    let connection = desktop
        .connections
        .lock()
        .unwrap()
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or("no such connection")?;

    let Some(args) = arguments(&connection.place) else {
        // Its sign-in page asks the app to sign in through the browser.
        if let (true, Place::Server { url }) = (show, connection.place) {
            navigate(app, url);
        }

        return Ok(());
    };

    let (child, log) = spawn(&desktop, &connection.id, args).map_err(|e| e.to_string())?;

    desktop.running.lock().unwrap().insert(
        connection.id.clone(),
        Running {
            pid: Some(child.id()),
            origin: None,
        },
    );

    refresh_tray(app);

    let app = app.clone();
    let id = connection.id;

    thread::spawn(move || watch(&app, &id, child, log, show));

    Ok(())
}

// The server writes to a log file, not to a pipe of the app's, so it keeps
// serving when the app quits unexpectedly, and its own process group keeps it
// out of a Ctrl-C meant for the app.
fn spawn(
    desktop: &Desktop,
    id: &str,
    args: Vec<String>,
) -> std::io::Result<(std::process::Child, File)> {
    fs::create_dir_all(&desktop.logs)?;

    let path = log_path(desktop, id);
    let log = OpenOptions::new().create(true).append(true).open(&path)?;

    // Every writer appends, so a server still running from before keeps
    // writing at the end after the file is cut.
    if log.metadata()?.len() > 10 << 20 {
        log.set_len(0)?;
    }

    let mut reader = File::open(&path)?;
    reader.seek(SeekFrom::End(0))?;
    let pipoca = std::env::current_exe()?.with_file_name("pipoca");
    let mut command = Command::new(pipoca);

    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0);

    if let Some(path) = &desktop.path {
        command.env("PATH", path);
    }

    Ok((command.spawn()?, reader))
}

fn log_path(desktop: &Desktop, id: &str) -> PathBuf {
    desktop.logs.join(format!("{id}.log"))
}

// Bun prints the error that stopped it after the code around it.
fn error(output: &[String]) -> String {
    output
        .iter()
        .rev()
        .find(|line| line.starts_with("error:"))
        .or(output.last())
        .cloned()
        .unwrap_or_else(|| "Stopped before it could sign in.".to_owned())
}

fn watch(app: &AppHandle, id: &str, mut child: std::process::Child, mut log: File, show: bool) {
    let mut output = Vec::new();
    let mut pending = String::new();
    let mut signed_in = false;

    loop {
        let exited = child.try_wait().ok().flatten();
        let mut read = String::new();
        let _ = log.read_to_string(&mut read);
        pending.push_str(&read);

        while let Some(end) = pending.find('\n') {
            let line: String = pending.drain(..=end).collect();
            let line = line.trim_end();

            match line.strip_prefix("sign in at ").map(Url::parse) {
                Some(Ok(link)) if !signed_in => {
                    signed_in = true;
                    signed_in_at(app, id, &link, show);
                }
                _ if !signed_in && !line.is_empty() => {
                    output.push(line.to_owned());
                    if output.len() > 50 {
                        output.remove(0);
                    }
                }
                _ => {}
            }
        }

        if let Some(status) = exited {
            let desktop = app.state::<Desktop>();

            // `pipoca up` hands over to a server that was already running,
            // and that one keeps serving.
            if signed_in && status.success() {
                if let Some(running) = desktop.running.lock().unwrap().get_mut(id) {
                    running.pid = None;
                }

                return;
            }

            let failed = desktop.running.lock().unwrap().remove(id).is_some();
            refresh_tray(app);

            // Stopped from the app, it's no failure.
            if failed {
                let _ = app.emit(
                    "stopped",
                    Stopped {
                        id: id.to_owned(),
                        error: error(&output),
                        log: log_path(&desktop, id),
                    },
                );
            }

            return;
        }

        thread::sleep(Duration::from_millis(200));
    }
}

fn signed_in_at(app: &AppHandle, id: &str, link: &Url, show: bool) {
    let mut origin = link.clone();
    origin.set_path("/");
    origin.set_query(None);
    origin.set_fragment(None);

    if let Some(running) = app.state::<Desktop>().running.lock().unwrap().get_mut(id) {
        running.origin = Some(origin);
    }

    // A link signs in once. Opened later, the window's cookie is enough.
    if show {
        navigate(app, link.clone());
    }
}

// A server connection runs nothing on this machine.
fn arguments(place: &Place) -> Option<Vec<String>> {
    Some(match place {
        Place::ThisMac { folders } => {
            let mut args = vec!["up".to_owned(), "--print-link".to_owned()];
            let folders = if folders.is_empty() {
                vec![home()]
            } else {
                folders.clone()
            };

            for folder in folders {
                args.extend(["--folder".to_owned(), folder]);
            }

            args
        }
        Place::Ssh { host, local_port } => vec![
            "connect".to_owned(),
            host.clone(),
            "--print-link".to_owned(),
            "--local-port".to_owned(),
            local_port.to_string(),
        ],
        Place::Server { .. } => return None,
    })
}

// Pipoca stops its Sessions and runner on SIGTERM.
fn terminate(pid: u32) {
    let _ = Command::new("kill").arg(pid.to_string()).status();
}

pub(crate) fn navigate(app: &AppHandle, url: Url) {
    if let Some(window) = main_window(app) {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn show_launcher(app: &AppHandle) {
    let launcher = app.state::<Desktop>().launcher.lock().unwrap().clone();

    if let Some(url) = launcher {
        navigate(app, url);
    }
}

// Pages a server serves find window.pipocaDesktop and can ask the app for
// what a browser can't do, which today is signing in through the person's
// browser (ADR 0055). They ask by going to a pipoca:// address, which the
// window never loads.
fn build_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let handle = app.clone();

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Pipoca")
        .inner_size(1200.0, 800.0)
        .min_inner_size(480.0, 400.0)
        .visible(false)
        .initialization_script("window.pipocaDesktop = { signIn: true };")
        .on_navigation(move |url| {
            if url.scheme() != "pipoca" {
                return true;
            }

            let handle = handle.clone();
            let url = url.clone();
            thread::spawn(move || sign_in::asked(&handle, &url));

            false
        })
        .build()
}

pub(crate) fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let desktop = app.state::<Desktop>();
    let connections = desktop.connections.lock().unwrap().clone();
    let running = desktop.running.lock().unwrap();
    let menu = Menu::new(app)?;

    for connection in connections {
        let label = if running.contains_key(&connection.id) {
            format!("● {}", connection.name)
        } else {
            connection.name
        };

        let item = MenuItem::with_id(
            app,
            format!("open:{}", connection.id),
            label,
            true,
            None::<&str>,
        )?;
        menu.append(&item)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "connections",
        "Connections…",
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "quit",
        "Quit Pipoca",
        true,
        None::<&str>,
    )?)?;

    Ok(menu)
}

fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id("main"), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".to_owned())
}

// An app opened from the Finder gets a bare PATH, and Sessions need the
// tools the person's shell finds, such as git.
fn login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let marker = "__PIPOCA_PATH__";
    let output = Command::new(shell)
        .args(["-ilc", &format!("printf '{marker}%s{marker}' \"$PATH\"")])
        .stdin(Stdio::null())
        .output()
        .ok()?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = stdout.split(marker).nth(1)?;

    (!path.is_empty()).then(|| path.to_owned())
}

fn load(file: &Path) -> Vec<Connection> {
    fs::read(file)
        .ok()
        .and_then(|json| serde_json::from_slice(&json).ok())
        .unwrap_or_else(|| {
            vec![Connection {
                id: "this-mac".to_owned(),
                name: if cfg!(target_os = "macos") {
                    "This Mac"
                } else {
                    "This computer"
                }
                .to_owned(),
                place: Place::ThisMac { folders: vec![] },
                at_login: false,
            }]
        })
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = main_window(app) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AT_LOGIN]),
        ))
        .setup(|app| {
            let file = app.path().app_config_dir()?.join("connections.json");
            let connections = load(&file);

            app.manage(Desktop {
                file,
                logs: app.path().app_log_dir()?,
                connections: Mutex::new(connections.clone()),
                running: Mutex::new(HashMap::new()),
                launcher: Mutex::new(None),
                path: login_path(),
                signing_in: Mutex::new(HashMap::new()),
            });

            sign_in::listen(app.handle());

            let window = build_window(app.handle())?;
            *app.state::<Desktop>().launcher.lock().unwrap() = window.url().ok();

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().ok_or("no icon")?.clone())
                .tooltip("Pipoca")
                .menu(&tray_menu(app.handle())?)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "connections" => show_launcher(app),
                    id => {
                        if let Some(id) = id.strip_prefix("open:") {
                            let _ = start(app, id, true);
                        }
                    }
                })
                .build(app)?;

            if std::env::args().any(|arg| arg == AT_LOGIN) {
                for connection in connections.iter().filter(|c| c.at_login) {
                    let _ = start(app.handle(), &connection.id, false);
                }
            } else {
                window.show()?;
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Sessions keep running with the window closed, as with a
            // server started from a terminal.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![list, save, open, stop])
        .build(tauri::generate_context!())
        .expect("Pipoca could not start");

    app.run(|app, event| match event {
        RunEvent::Exit => {
            let running = std::mem::take(&mut *app.state::<Desktop>().running.lock().unwrap());

            for pid in running.into_values().filter_map(|r| r.pid) {
                terminate(pid);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => {
            if let Some(window) = main_window(app) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        _ => {}
    });
}
