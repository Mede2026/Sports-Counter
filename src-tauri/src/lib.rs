use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const ESPN_HOST: &str = "site.api.espn.com";
const ESPN_BASE: &str = "https://site.api.espn.com/apis/site/v2/sports";
const WIDGET: &str = "widget";
const SETTINGS: &str = "settings";

/// Seuls ces caractères peuvent composer le chemin demandé par l'interface.
/// L'hôte, lui, est codé en dur : le frontend ne peut pas rediriger l'appel ailleurs.
fn path_is_safe(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains("..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-?=&".contains(c))
}

/// Relaie une requête vers l'API ESPN depuis Rust.
/// Passer par Rust évite les blocages CORS et garde le domaine appelé sous contrôle.
#[tauri::command]
async fn espn_get(path: String) -> Result<String, String> {
    if !path_is_safe(&path) {
        return Err("chemin de requête invalide".into());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("SportsCounter/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{ESPN_BASE}/{path}");
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("réseau : {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {} depuis {ESPN_HOST}", res.status()));
    }

    res.text().await.map_err(|e| format!("lecture : {e}"))
}

/// Ouvre la fenêtre de réglages, ou la ramène devant si elle existe déjà.
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(SETTINGS) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("Sports Counter — Réglages")
        .inner_size(780.0, 540.0)
        .min_inner_size(660.0, 440.0)
        .decorations(false)
        .transparent(false)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Affiche ou masque le widget.
fn toggle_widget(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WIDGET) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Afficher / masquer", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Réglages…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &sep, &quit])?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::InvalidIcon(std::io::Error::other("icône par défaut absente")))?;

    TrayIconBuilder::with_id("tray")
        .icon(icon)
        .tooltip("Sports Counter")
        .menu(&menu)
        // Le menu ne doit sortir qu'au clic droit : le clic gauche sert au bascule.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_widget(app),
            "settings" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_settings(handle).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_widget(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Ctrl + Alt + S : afficher/masquer le widget depuis n'importe où.
    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS);

    tauri::Builder::default()
        // Mémorise la position du widget entre deux lancements.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed && shortcut == &hotkey {
                        toggle_widget(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![espn_get, open_settings])
        .setup(move |app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;

            if let Err(err) = app.global_shortcut().register(hotkey) {
                // Un autre logiciel occupe peut-être déjà le raccourci : ce n'est pas fatal.
                eprintln!("raccourci global indisponible : {err}");
            }

            if let Some(win) = app.get_webview_window(WIDGET) {
                // Garantit le comportement « toujours au-dessus », même si la
                // configuration est modifiée plus tard.
                let _ = win.set_always_on_top(true);
                let _ = win.set_skip_taskbar(true);

                // Flou acrylique de Windows derrière le widget. Indisponible sur
                // certaines versions : on continue sans, le fond CSS suffit.
                #[cfg(windows)]
                if let Err(err) = window_vibrancy::apply_acrylic(&win, Some((16, 18, 27, 120))) {
                    eprintln!("flou acrylique indisponible : {err}");
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Fermer le widget doit le masquer, pas tuer l'app : elle vit dans la
            // zone de notification.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == WIDGET {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage de Sports Counter");
}
