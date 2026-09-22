use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const ESPN_HOST: &str = "site.api.espn.com";
const ESPN_BASE: &str = "https://site.api.espn.com/apis/site/v2/sports";
const WIDGET: &str = "widget";
const SETTINGS: &str = "settings";

/// Marge entre le widget et les bords de l'écran, en pixels logiques.
const MARGIN: f64 = 12.0;

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
        .map_err(|e| format!("réseau ({path}) : {e}"))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {} sur {ESPN_HOST}/{path}", res.status()));
    }

    res.text().await.map_err(|e| format!("lecture ({path}) : {e}"))
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


/// Coin haut-gauche autorisé pour le widget, dans la zone de travail de son
/// écran. La zone de travail exclut la barre des tâches : le widget ne peut
/// donc jamais passer dessous ni sortir de l'écran.
fn allowed_bounds(win: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let monitor = win.current_monitor().ok().flatten()?;
    let area = monitor.work_area();
    let size = win.outer_size().ok()?;
    let margin = (MARGIN * monitor.scale_factor()).round() as i32;

    let min_x = area.position.x + margin;
    let min_y = area.position.y + margin;
    // `max` évite une borne inversée si la fenêtre dépasse la taille de l'écran.
    let max_x = (area.position.x + area.size.width as i32 - size.width as i32 - margin).max(min_x);
    let max_y = (area.position.y + area.size.height as i32 - size.height as i32 - margin).max(min_y);

    Some((min_x, min_y, max_x, max_y))
}

/// Position de départ : en bas à gauche, juste au-dessus de la barre des tâches.
fn place_bottom_left(win: &WebviewWindow) {
    if let Some((min_x, _, _, max_y)) = allowed_bounds(win) {
        let _ = win.set_position(PhysicalPosition::new(min_x, max_y));
    }
}

/// Ramène le widget dans l'écran s'il en dépasse. Ne fait rien quand il est
/// déjà au bon endroit, ce qui évite de boucler sur l'évènement de déplacement.
fn keep_on_screen(win: &WebviewWindow) {
    let Some((min_x, min_y, max_x, max_y)) = allowed_bounds(win) else {
        return;
    };
    let Ok(pos) = win.outer_position() else {
        return;
    };

    let x = pos.x.clamp(min_x, max_x);
    let y = pos.y.clamp(min_y, max_y);
    if x != pos.x || y != pos.y {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// Affiche le widget et le met devant.
fn show_widget(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(WIDGET) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    }
}

/// Version appelable depuis l'interface.
#[tauri::command]
fn reveal_widget(app: AppHandle) {
    show_widget(&app);
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
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => toggle_widget(tray.app_handle()),
                // Le double-clic affiche toujours, sans jamais masquer : c'est le
                // geste de secours quand on ne retrouve plus le widget.
                TrayIconEvent::DoubleClick { .. } => show_widget(tray.app_handle()),
                _ => {}
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
        // Relancer l'app alors qu'elle tourne déjà ne crée pas un second
        // exemplaire : ça réaffiche le widget. C'est le moyen le plus simple de
        // le retrouver quand l'icône de la zone de notification est masquée par
        // Windows.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_widget(app);
        }))
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
        .invoke_handler(tauri::generate_handler![espn_get, open_settings, reveal_widget])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Ancrage initial : on le pose une seule fois par utilisateur, via un
            // fichier témoin. Se fier à l'absence du fichier de position du
            // greffon ne suffirait pas — quelqu'un qui a déjà lancé une version
            // antérieure en a un, et n'aurait jamais l'ancrage.
            let layout_marker = app
                .path()
                .app_config_dir()
                .map(|dir| dir.join(".layout-anchored"));
            let needs_anchor = layout_marker
                .as_ref()
                .map(|f| !f.exists())
                .unwrap_or(true);

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

                // La première fois, le widget se place en bas à gauche. Ensuite
                // sa position est celle que l'utilisateur lui a donnée, et on
                // vérifie seulement qu'elle tient toujours dans l'écran — par
                // exemple après avoir débranché un deuxième moniteur.
                if needs_anchor {
                    place_bottom_left(&win);
                    if let Ok(marker) = &layout_marker {
                        if let Some(dir) = marker.parent() {
                            let _ = std::fs::create_dir_all(dir);
                        }
                        let _ = std::fs::write(marker, b"1");
                    }
                } else {
                    keep_on_screen(&win);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != WIDGET {
                return;
            }
            match event {
                // Fermer le widget doit le masquer, pas tuer l'app : elle vit
                // dans la zone de notification.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // Après un déplacement à la souris ou un changement de hauteur,
                // on vérifie que le widget tient toujours dans l'écran.
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    if let Some(win) = window.app_handle().get_webview_window(WIDGET) {
                        keep_on_screen(&win);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage de Sports Counter");
}
