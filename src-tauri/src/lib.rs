use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// Identité annoncée au serveur. Un nom d'application maison suffisait à
/// déclencher un 403 côté ESPN.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ESPN_BASE: &str = "https://site.api.espn.com/apis/site/v2/sports";
const WIDGET: &str = "widget";
const SETTINGS: &str = "settings";
const TOAST: &str = "toast";

/// Largeur du widget, en pixels logiques.
const WIDGET_WIDTH: f64 = 300.0;

/// En deçà de cette distance d'un bord (pixels logiques), le widget s'y colle.
const SNAP: f64 = 24.0;

/// Délai après le dernier déplacement avant de recadrer le widget. Recadrer
/// pendant le glisser lutterait contre la souris et ferait trembler la fenêtre.
const SETTLE_DELAY: Duration = Duration::from_millis(250);

/// Numéro du dernier déplacement : seul le plus récent déclenche le recadrage.
static SETTLE_GEN: AtomicU64 = AtomicU64::new(0);

/// Option « Cacher pendant les jeux plein écran », transmise par l'interface.
static HIDE_FULLSCREEN: AtomicBool = AtomicBool::new(true);

/// Vrai quand c'est nous qui avons caché le widget à cause du plein écran :
/// on ne le réaffiche que dans ce cas, jamais s'il a été masqué à la main.
static HIDDEN_FOR_FULLSCREEN: AtomicBool = AtomicBool::new(false);

/// Intervalle de surveillance du plein écran.
const FULLSCREEN_POLL: Duration = Duration::from_millis(1500);

/// Délai avant la première recherche de mise à jour, pour ne pas ralentir
/// le démarrage, puis intervalle entre deux recherches.
const UPDATE_FIRST_CHECK: Duration = Duration::from_secs(20);
const UPDATE_INTERVAL: Duration = Duration::from_secs(6 * 3600);

/// Sites où un clic sur un match a le droit d'emmener.
const ESPN_HOSTS: [&str; 4] = ["www.espn.com", "espn.com", "www.espn.ca", "www.espn.co.uk"];

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
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{ESPN_BASE}/{path}");
    let res = client
        .get(&url)
        // Ces en-têtes sont ceux d'un navigateur ordinaire. Sans eux, le pare-feu
        // anti-robots d'ESPN répond 403 : l'API est publique mais n'est pas
        // documentée, et ne s'attend donc qu'à des visiteurs venant du site.
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "fr-CA,fr;q=0.9,en-US;q=0.8,en;q=0.7")
        .header("Referer", "https://www.espn.com/")
        .send()
        .await
        .map_err(|e| format!("réseau : {e}\n{url}"))?;

    let status = res.status();
    if !status.is_success() {
        let hint = if status.as_u16() == 403 {
            "\nESPN a refusé la requête : son API n'est pas officielle et peut bloquer selon le réseau ou le pays."
        } else {
            ""
        };
        return Err(format!("HTTP {status}\n{url}{hint}"));
    }

    res.text()
        .await
        .map_err(|e| format!("lecture : {e}\n{url}"))
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

/// Rectangle de la zone de travail de l'écran du widget, et facteur d'échelle.
/// La zone de travail exclut la barre des tâches : s'y limiter garantit que
/// le widget ne passe jamais dessous ni hors de l'écran.
fn work_area(win: &WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> {
    let monitor = win.current_monitor().ok().flatten()?;
    let a = monitor.work_area();
    Some((
        a.position.x,
        a.position.y,
        a.position.x + a.size.width as i32,
        a.position.y + a.size.height as i32,
        monitor.scale_factor(),
    ))
}

/// Position de départ : collé en bas à gauche, juste au-dessus de la barre
/// des tâches.
fn place_bottom_left(win: &WebviewWindow) {
    let (Some((left, _, _, bottom, _)), Ok(size)) = (work_area(win), win.outer_size()) else {
        return;
    };
    let _ = win.set_position(PhysicalPosition::new(left, bottom - size.height as i32));
}

/// Ramène le widget dans l'écran, et le colle au bord s'il en est tout près.
/// Ne déplace rien quand il est déjà en place, ce qui évite de boucler sur
/// l'évènement de déplacement que provoque `set_position`.
fn settle(win: &WebviewWindow) {
    let Some((left, top, right, bottom, scale)) = work_area(win) else {
        return;
    };
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return;
    };
    let snap = (SNAP * scale).round() as i32;

    // `max` évite une borne inversée si la fenêtre dépasse la taille de l'écran.
    let max_x = (right - size.width as i32).max(left);
    let max_y = (bottom - size.height as i32).max(top);

    let mut x = pos.x.clamp(left, max_x);
    let mut y = pos.y.clamp(top, max_y);
    if x - left <= snap {
        x = left;
    } else if max_x - x <= snap {
        x = max_x;
    }
    if y - top <= snap {
        y = top;
    } else if max_y - y <= snap {
        y = max_y;
    }

    if x != pos.x || y != pos.y {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// Recadre le widget une fois qu'il a cessé de bouger.
fn settle_later(win: WebviewWindow) {
    let gen = SETTLE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE_DELAY).await;
        if SETTLE_GEN.load(Ordering::SeqCst) == gen {
            settle(&win);
        }
    });
}

/// Ajuste la hauteur du widget à son contenu.
///
/// Un widget posé dans la moitié basse de l'écran grandit et rétrécit par le
/// haut : son bord inférieur reste collé à la barre des tâches. Sans ça, il
/// rétrécissait par le bas et laissait un espace vide au-dessus de la barre.
#[tauri::command]
fn fit_widget(app: AppHandle, height: f64) {
    let Some(win) = app.get_webview_window(WIDGET) else {
        return;
    };
    let (Ok(pos), Ok(size), Ok(scale)) =
        (win.outer_position(), win.outer_size(), win.scale_factor())
    else {
        return;
    };

    let new_w = (WIDGET_WIDTH * scale).round() as u32;
    let new_h = (height.max(40.0) * scale).round() as u32;
    if new_w == size.width && new_h == size.height {
        return;
    }

    let grow_up = work_area(&win)
        .map(|(_, top, _, bottom, _)| pos.y + size.height as i32 / 2 > (top + bottom) / 2)
        .unwrap_or(false);

    let _ = win.set_size(PhysicalSize::new(new_w, new_h));
    if grow_up {
        let old_bottom = pos.y + size.height as i32;
        let _ = win.set_position(PhysicalPosition::new(pos.x, old_bottom - new_h as i32));
    }
}

/* ---------- 2. Démarrage avec Windows ---------- */

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| e.to_string())
}

/* ---------- 3. Plein écran ---------- */

#[tauri::command]
fn set_hide_fullscreen(enabled: bool) {
    HIDE_FULLSCREEN.store(enabled, Ordering::SeqCst);
}

/// Vrai quand Windows signale une application en plein écran : jeu, vidéo,
/// présentation. On interroge directement shell32, sans bibliothèque en plus.
#[cfg(windows)]
fn fullscreen_app_running() -> bool {
    #[link(name = "shell32")]
    extern "system" {
        fn SHQueryUserNotificationState(pquns: *mut i32) -> i32;
    }
    // Valeurs de QUERY_USER_NOTIFICATION_STATE (windows-sys, Win32::UI::Shell).
    const QUNS_BUSY: i32 = 2;
    const QUNS_RUNNING_D3D_FULL_SCREEN: i32 = 3;
    const QUNS_PRESENTATION_MODE: i32 = 4;

    let mut state = 0i32;
    // SAFETY : l'unique argument est un pointeur vers un i32 valide qui vit
    // pendant tout l'appel, comme l'exige la fonction.
    let hr = unsafe { SHQueryUserNotificationState(&mut state) };
    hr >= 0
        && matches!(
            state,
            QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE
        )
}

#[cfg(not(windows))]
fn fullscreen_app_running() -> bool {
    false
}

/// Cache le widget pendant qu'une application est en plein écran, et le
/// réaffiche ensuite — seulement si c'est cette surveillance qui l'avait caché.
fn watch_fullscreen(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(FULLSCREEN_POLL);
        let Some(win) = app.get_webview_window(WIDGET) else {
            continue;
        };
        let busy = HIDE_FULLSCREEN.load(Ordering::SeqCst) && fullscreen_app_running();
        let hidden_by_us = HIDDEN_FOR_FULLSCREEN.load(Ordering::SeqCst);

        if busy && !hidden_by_us {
            if win.is_visible().unwrap_or(false) {
                let _ = win.hide();
                HIDDEN_FOR_FULLSCREEN.store(true, Ordering::SeqCst);
            }
        } else if !busy && hidden_by_us {
            let _ = win.show();
            HIDDEN_FOR_FULLSCREEN.store(false, Ordering::SeqCst);
        }
    });
}

/* ---------- Notifications de l'app ---------- */

/// Place la fenêtre de notification juste au-dessus du widget (ou en dessous
/// s'il n'y a pas la place), alignée sur son bord gauche. Widget caché : en
/// bas à gauche de l'écran, là où il se trouve d'habitude.
fn place_toast(app: &AppHandle) {
    let (Some(toast), Some(widget)) = (
        app.get_webview_window(TOAST),
        app.get_webview_window(WIDGET),
    ) else {
        return;
    };
    let (Some((left, top, right, bottom, scale)), Ok(size)) =
        (work_area(&widget), toast.outer_size())
    else {
        return;
    };
    let (w, h) = (size.width as i32, size.height as i32);
    let gap = (8.0 * scale).round() as i32;

    let (mut x, mut y) = (left, bottom - h);
    if widget.is_visible().unwrap_or(false) {
        if let (Ok(pos), Ok(wsize)) = (widget.outer_position(), widget.outer_size()) {
            x = pos.x;
            let above = pos.y - h - gap;
            y = if above >= top {
                above
            } else {
                pos.y + wsize.height as i32 + gap
            };
        }
    }
    let x = x.clamp(left, (right - w).max(left));
    let y = y.clamp(top, (bottom - h).max(top));
    let _ = toast.set_position(PhysicalPosition::new(x, y));
}

/// Fait surgir une notification. La fenêtre `toast` affiche elle-même, puis
/// cache, sa file de notifications ; ici on la place et on lui transmet le
/// contenu. Rien pendant un jeu en plein écran, si l'option est active.
#[tauri::command]
fn notify(app: AppHandle, toast: serde_json::Value) {
    if HIDE_FULLSCREEN.load(Ordering::SeqCst) && fullscreen_app_running() {
        return;
    }
    place_toast(&app);
    let _ = app.emit_to(TOAST, "toast", toast);
}

/* ---------- 9. Mises à jour automatiques ---------- */

/// Cherche une nouvelle version publiée sur GitHub et l'installe. Le module
/// vérifie la signature avec la clé publique de tauri.conf.json avant
/// d'installer quoi que ce soit : une version non signée par nous est refusée.
async fn install_update_if_any(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
        // Sous Windows, l'installateur ferme lui-même l'app pour la remplacer ;
        // on ne passe ici que si ce n'est pas le cas.
        app.restart();
    }
    Ok(())
}

fn watch_updates(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(UPDATE_FIRST_CHECK).await;
        loop {
            if let Err(err) = install_update_if_any(&app).await {
                // Pas de réseau, GitHub injoignable… on réessaiera plus tard.
                eprintln!("mise à jour impossible pour l'instant : {err}");
            }
            tokio::time::sleep(UPDATE_INTERVAL).await;
        }
    });
}

/* ---------- 8. Ouvrir la page ESPN d'un match ---------- */

/// Ouvre la page d'un match dans le navigateur par défaut. Seules les
/// adresses https d'ESPN passent : l'interface ne peut pas faire ouvrir
/// n'importe quel site ou programme.
#[tauri::command]
fn open_espn(app: AppHandle, url: String) -> Result<(), String> {
    let host = url
        .strip_prefix("https://")
        .and_then(|rest| {
            rest.split(|c: char| c == '/' || c == '?' || c == '#')
                .next()
        })
        .unwrap_or("");
    if !ESPN_HOSTS.contains(&host) {
        return Err(format!("adresse refusée : {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
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

    let icon = app.default_window_icon().cloned().ok_or_else(|| {
        tauri::Error::InvalidIcon(std::io::Error::other("icône par défaut absente"))
    })?;

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
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Mémorise la position du widget entre deux lancements.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .with_denylist(&[TOAST])
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
        .invoke_handler(tauri::generate_handler![
            espn_get,
            open_settings,
            reveal_widget,
            fit_widget,
            get_autostart,
            set_autostart,
            set_hide_fullscreen,
            open_espn,
            notify
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Ancrage initial : on le pose une seule fois par utilisateur, via un
            // fichier témoin. Se fier à l'absence du fichier de position du
            // greffon ne suffirait pas — quelqu'un qui a déjà lancé une version
            // antérieure en a un, et n'aurait jamais l'ancrage. Le suffixe v2
            // refait l'ancrage une fois : la v1 laissait un espace sous le widget.
            let layout_marker = app
                .path()
                .app_config_dir()
                .map(|dir| dir.join(".layout-anchored-v2"));
            let needs_anchor = layout_marker.as_ref().map(|f| !f.exists()).unwrap_or(true);

            build_tray(&handle)?;
            watch_fullscreen(handle.clone());
            watch_updates(handle.clone());

            // Démarrage avec Windows activé une seule fois, au premier lancement
            // de cette version ; ensuite, c'est la case des réglages qui décide.
            if let Ok(dir) = app.path().app_config_dir() {
                let marker = dir.join(".autostart-default");
                if !marker.exists() {
                    let _ = app.autolaunch().enable();
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = std::fs::write(&marker, b"1");
                }
            }

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
                    settle(&win);
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
                // on recadre le widget une fois qu'il s'est immobilisé.
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    if let Some(win) = window.app_handle().get_webview_window(WIDGET) {
                        settle_later(win);
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("échec du démarrage de Sports Counter");
}
