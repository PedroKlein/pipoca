// A team server signs the window in through the person's own browser, since
// some identity providers refuse an embedded webview (ADR 0055). The browser
// hands back a pipoca:// link with a one-time token that only works with a
// verifier the app never lets out.

use std::process::Command;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

use crate::{navigate, Desktop, Place};

pub struct Pending {
    pub id: String,
    url: Url,
    verifier: String,
}

#[derive(Clone, Serialize)]
struct SigningIn {
    id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Failed {
    id: String,
    error: String,
}

pub fn listen(app: &AppHandle) {
    // A deb registers the scheme when it installs; a build run from its
    // folder registers it here, and without a desktop to register with it
    // just can't sign in to a server.
    #[cfg(target_os = "linux")]
    let _ = app.deep_link().register_all();

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            signed_in(&handle, &url);
        }
    });
}

// A server's sign-in page in the window asks with pipoca://sign-in, naming
// its origin. Only a server the person added gets an answer.
pub fn asked(app: &AppHandle, link: &Url) {
    let Some(server) = link
        .query_pairs()
        .find(|(key, _)| key == "server")
        .and_then(|(_, value)| Url::parse(&value).ok())
    else {
        return;
    };

    let connection = app
        .state::<Desktop>()
        .connections
        .lock()
        .unwrap()
        .iter()
        .find_map(|connection| match &connection.place {
            Place::Server { url } if url.origin() == server.origin() => {
                Some((connection.id.clone(), url.clone()))
            }
            _ => None,
        });

    let Some((id, url)) = connection else {
        return;
    };

    if let Err(error) = start(app, &id, url) {
        let _ = app.emit("failed", Failed { id, error });
    }
}

fn start(app: &AppHandle, id: &str, url: Url) -> Result<(), String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;

    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let mut page = url.clone();
    page.set_fragment(Some(&format!("app/{challenge}")));

    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };

    Command::new(opener)
        .arg(page.as_str())
        .spawn()
        .map_err(|e| format!("couldn't open the browser: {e}"))?;

    app.state::<Desktop>().signing_in.lock().unwrap().insert(
        challenge,
        Pending {
            id: id.to_owned(),
            url,
            verifier,
        },
    );

    let _ = app.emit("signing-in", SigningIn { id: id.to_owned() });
    crate::show_launcher(app);

    Ok(())
}

fn signed_in(app: &AppHandle, link: &Url) {
    if link.scheme() != "pipoca" || link.host_str() != Some("signed-in") {
        return;
    }

    let param = |name: &str| {
        link.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };

    let (Some(challenge), Some(token)) = (param("challenge"), param("link")) else {
        return;
    };

    let Some(pending) = app
        .state::<Desktop>()
        .signing_in
        .lock()
        .unwrap()
        .remove(&challenge)
    else {
        return;
    };

    let Ok(mut redeem) = pending.url.join(&format!("/api/auth/link/{token}")) else {
        let _ = app.emit(
            "failed",
            Failed {
                id: pending.id,
                error: "The server sent a link the app can't follow.".to_owned(),
            },
        );

        return;
    };

    redeem
        .query_pairs_mut()
        .append_pair("verifier", &pending.verifier);

    navigate(app, redeem);
}
