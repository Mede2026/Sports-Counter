use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Identité annoncée au serveur. Un nom d'application maison suffisait à
/// déclencher un 403 côté ESPN.
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ESPN_BASE: &str = "https://site.api.espn.com/apis/site/v2/sports";
/// API « v2 » d'ESPN (classements). L'interface la demande avec le préfixe « v2/ ».
const ESPN_BASE_V2: &str = "https://site.api.espn.com/apis/v2/sports";
/// API « core » d'ESPN (meneurs de la ligue, fiches des joueurs), préfixe « core/ ».
const ESPN_CORE: &str = "https://sports.core.api.espn.com";
/// Options du moteur WebView2, identiques pour TOUTES les fenêtres : elles
/// partagent un même dossier de données, et WebView2 refuse d'ouvrir une
/// fenêtre dont les options diffèrent des autres. Doit rester égale à
/// `additionalBrowserArgs` dans tauri.conf.json.
///
/// Les trois dernières empêchent Chromium de ralentir les minuteries d'une
/// fenêtre cachée : le widget relève les scores même quand il n'est pas
/// affiché (mode « notifications seulement », plein écran…).
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
const WIDGET: &str = "widget";
const SETTINGS: &str = "settings";
const TOAST: &str = "toast";
const MATCH: &str = "match";
const NOTES: &str = "notes";

/// Largeur du widget, en pixels logiques.
const WIDGET_WIDTH: f64 = 300.0;

/// En deçà de cette distance d'un bord (pixels logiques), le widget s'y colle.
const SNAP: f64 = 40.0;

/// Glissement du widget vers le bord qui l'attire : nombre d'images et durée
/// de chacune. Assez court pour rester vif, assez long pour se voir.
const GLIDE_FRAMES: u32 = 10;
const GLIDE_FRAME: Duration = Duration::from_millis(14);

/// Délai après le dernier déplacement avant de recadrer le widget. Recadrer
/// pendant le glisser lutterait contre la souris et ferait trembler la fenêtre.
const SETTLE_DELAY: Duration = Duration::from_millis(250);

/// Numéro du dernier déplacement : seul le plus récent déclenche le recadrage.
static SETTLE_GEN: AtomicU64 = AtomicU64::new(0);

/// Bords de l'écran auxquels l'utilisateur a collé le widget. Ils sont
/// gardés sur le disque : au démarrage et à chaque changement de hauteur, le
/// widget y est recollé exactement, au lieu d'être replacé par son coin haut
/// gauche (qui le faisait remonter un peu à chaque mise à jour).
static ANCHOR: Mutex<Edges> = Mutex::new(Edges {
    left: false,
    right: false,
    top: false,
    bottom: false,
});

/// Faux tant que le widget s'installe au démarrage : ses premiers
/// déplacements (restauration, première hauteur) ne changent pas l'ancrage.
static ANCHOR_READY: AtomicBool = AtomicBool::new(false);

/// Temps laissé au widget pour prendre sa place avant d'écouter les
/// déplacements de l'utilisateur.
const ANCHOR_GRACE: Duration = Duration::from_secs(4);

/// Raccourcis clavier globaux, choisis dans les réglages : [afficher/masquer
/// le widget, fenêtre Match]. Par défaut Ctrl + Alt + S et Ctrl + Alt + M.
static SHORTCUTS: Mutex<[Option<Shortcut>; 2]> = Mutex::new([None, None]);
const DEFAULT_SHORTCUTS: [&str; 2] = ["Ctrl+Alt+KeyS", "Ctrl+Alt+KeyM"];

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

    let url = if let Some(rest) = path.strip_prefix("v2/") {
        format!("{ESPN_BASE_V2}/{rest}")
    } else if let Some(rest) = path.strip_prefix("core/") {
        format!("{ESPN_CORE}/{rest}")
    } else {
        format!("{ESPN_BASE}/{path}")
    };
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

/* ---------- Traduction (Google Traduction, sans clé ni compte) ---------- */

const TRANSLATE_URL: &str = "https://translate.googleapis.com/translate_a/single";
/// Service de traduction de pages de Google (celui du bouton « Traduire » de
/// Chrome) : plusieurs textes par requête, sans compte. La clé est publique,
/// la même pour tout le monde.
const TRANSLATE_HTML_URL: &str = "https://translate-pa.googleapis.com/v1/translateHtml";
const TRANSLATE_HTML_KEY: &str = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
/// Textes par requête au service de pages.
const TRANSLATE_HTML_BATCH: usize = 64;
/// Taille maximale d'un paquet de textes : l'adresse de la requête a une limite.
const TRANSLATE_CHUNK: usize = 1500;

/// Une requête à Google Traduction : anglais → français. La réponse découpe
/// le texte en segments ; on les recolle dans l'ordre.
async fn gtx(client: &reqwest::Client, text: &str) -> Result<String, String> {
    let body = client
        .get(TRANSLATE_URL)
        .query(&[
            ("client", "gtx"),
            ("sl", "en"),
            ("tl", "fr"),
            ("dt", "t"),
            ("q", text),
        ])
        .send()
        .await
        .map_err(|e| format!("réseau : {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut out = String::new();
    for seg in value
        .get(0)
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(s) = seg.get(0).and_then(|v| v.as_str()) {
            out.push_str(s);
        }
    }
    Ok(out)
}

/// Traduit un paquet de textes en une seule requête (un par ligne) ; si
/// Google ne rend pas autant de lignes, on les traduit un par un.
async fn translate_chunk(
    client: &reqwest::Client,
    texts: &[String],
) -> Result<Vec<String>, String> {
    let joined = texts
        .iter()
        .map(|t| t.replace('\n', " "))
        .collect::<Vec<_>>()
        .join("\n");
    let full = gtx(client, &joined).await?;
    let lines: Vec<String> = full.split('\n').map(|s| s.trim().to_string()).collect();
    if lines.len() == texts.len() {
        return Ok(lines);
    }
    let mut out = Vec::with_capacity(texts.len());
    for t in texts {
        out.push(gtx(client, t).await?.trim().to_string());
    }
    Ok(out)
}

/// Le service de pages lit du HTML : on protège < > & à l'aller, on les
/// rétablit au retour (avec les apostrophes et guillemets codés).
fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn html_unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // Une entité est courte (« &#39; ») : au-delà, c'est un simple « & ».
        let Some(end) = rest.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Traduit un paquet de textes avec le service de pages : une réponse par
/// texte, dans le même ordre.
async fn translate_html(client: &reqwest::Client, texts: &[String]) -> Result<Vec<String>, String> {
    let escaped: Vec<String> = texts.iter().map(|t| html_escape(t)).collect();
    let payload = serde_json::json!([[escaped, "en", "fr"], "te_lib"]);
    let body = client
        .post(TRANSLATE_HTML_URL)
        .header("Content-Type", "application/json+protobuf")
        .header("X-Goog-API-Key", TRANSLATE_HTML_KEY)
        .body(payload.to_string())
        .send()
        .await
        .map_err(|e| format!("réseau : {e}"))?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let list = value
        .get(0)
        .and_then(|v| v.as_array())
        .ok_or("réponse de traduction illisible")?;
    if list.len() != texts.len() {
        return Err("réponse de traduction incomplète".into());
    }
    Ok(list
        .iter()
        .map(|v| {
            html_unescape(v.as_str().unwrap_or_default())
                .trim()
                .to_string()
        })
        .collect())
}

/// Ancien service (translate_a) : textes regroupés par paquets de taille
/// limitée, l'adresse de la requête ayant une longueur maximale.
async fn translate_gtx(
    client: &reqwest::Client,
    texts: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut out = Vec::with_capacity(texts.len());
    let mut chunk: Vec<String> = Vec::new();
    let mut size = 0;
    for t in texts {
        if !chunk.is_empty() && size + t.len() > TRANSLATE_CHUNK {
            out.extend(translate_chunk(client, &chunk).await?);
            chunk.clear();
            size = 0;
        }
        size += t.len() + 1;
        chunk.push(t);
    }
    if !chunk.is_empty() {
        out.extend(translate_chunk(client, &chunk).await?);
    }
    Ok(out)
}

/// Traduit des textes anglais d'ESPN en français (jeux, statuts, résultats…).
/// Service de pages d'abord ; s'il refuse, l'ancien service de Google.
#[tauri::command]
async fn translate_text(texts: Vec<String>) -> Result<Vec<String>, String> {
    if texts.len() > 300 {
        return Err("trop de textes d'un coup".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(texts.len());
    let mut failed = false;
    for batch in texts.chunks(TRANSLATE_HTML_BATCH) {
        match translate_html(&client, batch).await {
            Ok(list) => out.extend(list),
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    if failed {
        return translate_gtx(&client, texts).await;
    }
    Ok(out)
}

/// Fenêtre secondaire (réglages, match, notes) : sans cadre système,
/// redimensionnable, centrée. Si elle existe déjà, on la ramène devant.
/// `init` : script lancé avant la page, pour lui passer des paramètres.
/// Renvoie vrai si la fenêtre existait déjà.
fn open_window(
    app: &AppHandle,
    label: &str,
    page: &str,
    title: &str,
    size: (f64, f64),
    min: (f64, f64),
    init: Option<String>,
) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        return Ok(true);
    }
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min.0, min.1)
        .decorations(false)
        .transparent(false)
        .additional_browser_args(BROWSER_ARGS)
        .resizable(true)
        .center();
    if let Some(script) = init {
        builder = builder.initialization_script(script);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(false)
}

/// Identifiant de ligue ou de match venu de l'interface : lettres, chiffres,
/// tirets seulement (il finit dans un script injecté dans la page).
fn id_is_safe(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Ouvre la fenêtre « Match » sur un match, ou y bascule si elle est déjà
/// ouverte. Le match voulu est passé à la page par un petit script.
#[tauri::command]
async fn open_match(app: AppHandle, league: String, event: String) -> Result<(), String> {
    if !id_is_safe(&league) || !id_is_safe(&event) {
        return Err("match invalide".into());
    }
    let target = serde_json::json!({ "league": league, "event": event });
    let existed = open_window(
        &app,
        MATCH,
        "match.html",
        "Sports Counter — Match",
        (400.0, 640.0),
        (340.0, 420.0),
        Some(format!("window.__MATCH__ = {target};")),
    )?;
    // Déjà ouverte : elle bascule sur le match demandé.
    if existed {
        let _ = app.emit_to(MATCH, "match-open", target);
    }
    Ok(())
}

/// Lit un raccourci écrit comme « Ctrl+Alt+KeyS ». Une touche seule est
/// refusée : elle se déclencherait à chaque fois qu'on tape du texte.
fn parse_shortcut(text: &str) -> Result<Shortcut, String> {
    let sc = Shortcut::from_str(text).map_err(|_| format!("raccourci invalide : {text}"))?;
    if !sc
        .mods
        .intersects(Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER)
    {
        return Err("Il faut au moins Ctrl ou Alt dans le raccourci.".into());
    }
    Ok(sc)
}

/// Remplace les raccourcis globaux. Si Windows refuse l'un d'eux (déjà pris
/// par un autre logiciel), les anciens sont remis et l'erreur est rendue.
#[tauri::command]
fn set_shortcuts(app: AppHandle, toggle: String, match_key: String) -> Result<(), String> {
    let new = [parse_shortcut(&toggle)?, parse_shortcut(&match_key)?];
    if new[0] == new[1] {
        return Err("Les deux raccourcis doivent être différents.".into());
    }
    let gs = app.global_shortcut();
    let mut current = SHORTCUTS.lock().unwrap();
    if *current == [Some(new[0]), Some(new[1])] {
        return Ok(());
    }
    for old in current.iter().flatten() {
        let _ = gs.unregister(*old);
    }
    for (i, sc) in new.iter().enumerate() {
        if let Err(err) = gs.register(*sc) {
            for done in &new[..i] {
                let _ = gs.unregister(*done);
            }
            for old in current.iter().flatten() {
                let _ = gs.register(*old);
            }
            return Err(format!(
                "Ce raccourci est déjà utilisé par un autre logiciel. ({err})"
            ));
        }
    }
    *current = [Some(new[0]), Some(new[1])];
    Ok(())
}

/// Ouvre l'écran « Notes de mise à jour ». `since` : dernière version vue
/// (vide si inconnue) ; l'écran montre tout ce qui est arrivé depuis.
#[tauri::command]
async fn open_notes(app: AppHandle, since: String) -> Result<(), String> {
    if since.len() > 20 || !since.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return Err("version invalide".into());
    }
    let opts =
        serde_json::json!({ "since": since, "current": app.package_info().version.to_string() });
    open_window(
        &app,
        NOTES,
        "notes.html",
        "Sports Counter — Notes de mise à jour",
        (440.0, 500.0),
        (360.0, 360.0),
        Some(format!("window.__NOTES__ = {opts};")),
    )?;
    Ok(())
}

/// Ouvre la fenêtre de réglages, ou la ramène devant si elle existe déjà.
#[tauri::command]
async fn open_settings(app: AppHandle) -> Result<(), String> {
    open_window(
        &app,
        SETTINGS,
        "settings.html",
        "Sports Counter — Réglages",
        (780.0, 540.0),
        (660.0, 440.0),
        None,
    )?;
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

/// Bords de l'écran contre lesquels le widget se trouve.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, Default, PartialEq)]
struct Edges {
    left: bool,
    right: bool,
    top: bool,
    bottom: bool,
}

/// Place visée pour le widget : ramené dans l'écran, et collé au bord s'il en
/// est tout près. Renvoie la position actuelle, la position visée, et les
/// bords touchés une fois en place.
fn settle_target(win: &WebviewWindow) -> Option<(PhysicalPosition<i32>, (i32, i32), Edges)> {
    let (left, top, right, bottom, scale) = work_area(win)?;
    let (pos, size) = (win.outer_position().ok()?, win.outer_size().ok()?);
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

    let edges = Edges {
        left: x == left,
        right: x == max_x,
        top: y == top,
        bottom: y == max_y,
    };
    Some((pos, (x, y), edges))
}

/// Fichier où l'ancrage du widget est gardé.
fn anchor_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("widget-anchor.json"))
}

/// Relit l'ancrage gardé. Renvoie faux s'il n'y en a pas encore.
fn load_anchor(app: &AppHandle) -> bool {
    let Some(file) = anchor_file(app) else {
        return false;
    };
    match std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Edges>(&bytes).ok())
    {
        Some(edges) => {
            *ANCHOR.lock().unwrap() = edges;
            true
        }
        None => false,
    }
}

/// Première fois avec l'ancrage : un widget laissé près d'un bord (même
/// remonté de quelques centimètres par les anciennes versions) y est recollé.
const MIGRATE_REACH: f64 = 220.0;

fn migrate_anchor(win: &WebviewWindow) {
    let (Some((left, top, right, bottom, scale)), Ok(pos), Ok(size)) =
        (work_area(win), win.outer_position(), win.outer_size())
    else {
        return;
    };
    let reach = (MIGRATE_REACH * scale).round() as i32;
    let (w, h) = (size.width as i32, size.height as i32);
    let near_left = pos.x - left <= reach;
    let near_bottom = bottom - (pos.y + h) <= reach;
    let edges = Edges {
        left: near_left,
        right: !near_left && right - (pos.x + w) <= reach,
        bottom: near_bottom,
        top: !near_bottom && pos.y - top <= reach,
    };
    if edges == Edges::default() {
        return;
    }
    ANCHOR_READY.store(true, Ordering::SeqCst);
    save_anchor(win.app_handle(), edges);
    ANCHOR_READY.store(false, Ordering::SeqCst);
    place_anchored(win);
}

/// Retient les bords où l'utilisateur a laissé le widget.
fn save_anchor(app: &AppHandle, edges: Edges) {
    if !ANCHOR_READY.load(Ordering::SeqCst) {
        return;
    }
    {
        let mut current = ANCHOR.lock().unwrap();
        if *current == edges {
            return;
        }
        *current = edges;
    }
    if let (Some(file), Ok(json)) = (anchor_file(app), serde_json::to_vec(&edges)) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(file, json);
    }
}

/// Position qui recolle un widget de taille `size` à ses bords d'ancrage.
/// Sur un axe sans bord retenu, la position actuelle est gardée.
fn anchored_position(
    win: &WebviewWindow,
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
) -> Option<(i32, i32)> {
    let edges = *ANCHOR.lock().unwrap();
    if edges == Edges::default() {
        return None;
    }
    let (left, top, right, bottom, _) = work_area(win)?;
    // `max` : un widget plus grand que l'écran reste accroché en haut à gauche.
    let x = if edges.left {
        left
    } else if edges.right {
        (right - size.width as i32).max(left)
    } else {
        pos.x
    };
    let y = if edges.bottom {
        (bottom - size.height as i32).max(top)
    } else if edges.top {
        top
    } else {
        pos.y
    };
    Some((x, y))
}

/// Recolle le widget à ses bords d'ancrage, s'il en a.
fn place_anchored(win: &WebviewWindow) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
        return;
    };
    if let Some((x, y)) = anchored_position(win, pos, size) {
        if (x, y) != (pos.x, pos.y) {
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Recadrage immédiat, sans animation (au démarrage).
fn settle(win: &WebviewWindow) {
    if let Some((pos, (x, y), _)) = settle_target(win) {
        if x != pos.x || y != pos.y {
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
}

/// Fait glisser le widget jusqu'à sa place, en ralentissant à l'arrivée :
/// on voit l'aimant le tirer vers le bord.
async fn glide(win: &WebviewWindow, from: PhysicalPosition<i32>, to: (i32, i32)) {
    for i in 1..=GLIDE_FRAMES {
        let t = f64::from(i) / f64::from(GLIDE_FRAMES);
        let ease = 1.0 - (1.0 - t).powi(3);
        let x = from.x + (f64::from(to.0 - from.x) * ease).round() as i32;
        let y = from.y + (f64::from(to.1 - from.y) * ease).round() as i32;
        let _ = win.set_position(PhysicalPosition::new(x, y));
        tokio::time::sleep(GLIDE_FRAME).await;
    }
}

/// Recadre le widget une fois qu'il a cessé de bouger. S'il vient de se
/// coller à un bord, le widget en est prévenu pour faire briller ce bord.
fn settle_later(win: WebviewWindow) {
    let gen = SETTLE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE_DELAY).await;
        if SETTLE_GEN.load(Ordering::SeqCst) != gen {
            return;
        }
        let Some((from, to, edges)) = settle_target(&win) else {
            return;
        };
        save_anchor(win.app_handle(), edges);
        if (from.x, from.y) == to {
            return;
        }
        glide(&win, from, to).await;
        if edges != Edges::default() {
            let _ = win.app_handle().emit_to(WIDGET, "snapped", edges);
        }
    });
}

/// Ajuste la taille du widget à son contenu (le mode compact est plus étroit).
///
/// Un widget posé dans la moitié basse de l'écran grandit et rétrécit par le
/// haut, et dans la moitié droite, par la gauche : le bord collé à la barre
/// des tâches ou au bord de l'écran reste en place.
#[tauri::command]
fn fit_widget(app: AppHandle, height: f64, width: Option<f64>) {
    let Some(win) = app.get_webview_window(WIDGET) else {
        return;
    };
    let (Ok(pos), Ok(size), Ok(scale)) =
        (win.outer_position(), win.outer_size(), win.scale_factor())
    else {
        return;
    };

    let logical_w = width.unwrap_or(WIDGET_WIDTH).clamp(120.0, 600.0);
    let new_w = (logical_w * scale).round() as u32;
    let new_h = (height.max(24.0) * scale).round() as u32;
    if new_w == size.width && new_h == size.height {
        return;
    }

    let (grow_up, grow_left) = work_area(&win)
        .map(|(left, top, right, bottom, _)| {
            (
                pos.y + size.height as i32 / 2 > (top + bottom) / 2,
                pos.x + size.width as i32 / 2 > (left + right) / 2,
            )
        })
        .unwrap_or((false, false));

    let _ = win.set_size(PhysicalSize::new(new_w, new_h));
    // Collé à des bords : il y reste exactement. Sinon, il grandit du côté
    // opposé au bord de l'écran le plus proche.
    let (x, y) = anchored_position(&win, pos, PhysicalSize::new(new_w, new_h)).unwrap_or((
        if grow_left {
            pos.x + size.width as i32 - new_w as i32
        } else {
            pos.x
        },
        if grow_up {
            pos.y + size.height as i32 - new_h as i32
        } else {
            pos.y
        },
    ));
    if x != pos.x || y != pos.y {
        let _ = win.set_position(PhysicalPosition::new(x, y));
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

/// Réglage « Widget » : faux pour « Sur le bureau ». Le widget reste alors sur le
/// bureau, derrière les fenêtres ; les notifications passent toujours devant.
static WIDGET_ON_TOP: AtomicBool = AtomicBool::new(true);

/// Met le widget à son étage : devant tout, ou sur le bureau.
fn place_layer(win: &WebviewWindow) {
    if WIDGET_ON_TOP.load(Ordering::SeqCst) {
        let _ = win.set_always_on_bottom(false);
        to_front(win);
    } else {
        let _ = win.set_always_on_top(false);
        let _ = win.set_always_on_bottom(true);
    }
}

#[tauri::command]
fn set_widget_on_top(app: AppHandle, on_top: bool) {
    WIDGET_ON_TOP.store(on_top, Ordering::SeqCst);
    if let Some(win) = app.get_webview_window(WIDGET) {
        place_layer(&win);
    }
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
            place_layer(&win);
            HIDDEN_FOR_FULLSCREEN.store(false, Ordering::SeqCst);
        }
    });
}

/* ---------- Notifications de l'app ---------- */

/// Remet une fenêtre « toujours au-dessus » en tête des fenêtres de ce type.
/// Windows garde l'ordre d'empilement d'une fenêtre cachée : réaffichée, elle
/// pouvait rester derrière une fenêtre passée au premier plan entre-temps.
/// Retirer puis remettre l'attribut la replace tout devant, sans lui donner
/// le clavier. (Le remettre seul ne fait rien : il est déjà actif.)
fn to_front(win: &WebviewWindow) {
    let _ = win.set_always_on_top(false);
    let _ = win.set_always_on_top(true);
}

/// Place la notification :
/// - widget affiché : juste au-dessus de lui (en dessous s'il n'y a pas la
///   place), alignée sur son bord gauche ;
/// - widget caché (mode « notifications seulement », ou masqué) : en bas à
///   gauche de l'écran, juste au-dessus de la barre des tâches.
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

/// Appelé par la fenêtre de notification quand elle affiche une carte : elle
/// apparaît devant tout, sans prendre le clavier.
#[tauri::command]
fn show_toast(app: AppHandle) {
    if let Some(win) = app.get_webview_window(TOAST) {
        let _ = win.show();
        to_front(&win);
    }
}

/* ---------- 9. Mises à jour ---------- */

/// Mise à jour trouvée, en attente de l'accord de l'utilisateur. Rien n'est
/// installé sans qu'il clique sur « Installer ».
struct PendingUpdate(Mutex<Option<Update>>);

/// Intervalle entre deux tentatives d'afficher la proposition de mise à jour
/// quand un jeu est en plein écran.
const UPDATE_PROMPT_RETRY: Duration = Duration::from_secs(60);

/// Cherche une version plus récente ; si elle existe, la garde en attente et
/// renvoie son numéro.
async fn find_update(app: &AppHandle) -> Result<Option<String>, String> {
    let found = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let version = found.as_ref().map(|u| u.version.clone());
    *app.state::<PendingUpdate>().0.lock().unwrap() = found;
    Ok(version)
}

/// Résultat d'une recherche de mise à jour demandée depuis les réglages.
#[derive(serde::Serialize)]
struct UpdateCheck {
    current: String,
    /// Version disponible, en attente d'accord, ou `None` si l'app est à jour.
    available: Option<String>,
}

/// Version installée, affichée dans les réglages.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Bouton « Rechercher une mise à jour » : cherche seulement. L'installation
/// attend que l'utilisateur accepte (commande `install_update`).
#[tauri::command]
async fn check_update(app: AppHandle) -> Result<UpdateCheck, String> {
    let current = app.package_info().version.to_string();
    let available = find_update(&app).await?;
    Ok(UpdateCheck { current, available })
}

/// L'utilisateur a accepté : on installe la mise à jour en attente. Le module
/// vérifie sa signature avec la clé publique de tauri.conf.json avant tout ;
/// une version non signée par nous est refusée. Puis l'app redémarre.
#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "aucune mise à jour en attente".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    // Sous Windows, l'installateur ferme lui-même l'app pour la remplacer ;
    // on ne passe ici que si ce n'est pas le cas.
    app.restart();
}

/// Recherche automatique : 20 s après le démarrage, puis toutes les 6 h. Une
/// version trouvée n'est pas installée : on propose de le faire, par une
/// notification de l'app avec « Installer » et « Plus tard ».
fn watch_updates(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(UPDATE_FIRST_CHECK).await;
        loop {
            match find_update(&app).await {
                Ok(Some(version)) => {
                    // Pas pendant un jeu en plein écran : on attend qu'il finisse.
                    while HIDE_FULLSCREEN.load(Ordering::SeqCst) && fullscreen_app_running() {
                        tokio::time::sleep(UPDATE_PROMPT_RETRY).await;
                    }
                    place_toast(&app);
                    let _ = app.emit_to(
                        TOAST,
                        "toast",
                        serde_json::json!({ "kind": "update", "version": version }),
                    );
                }
                Ok(None) => {}
                // Pas de réseau, GitHub injoignable… on réessaiera plus tard.
                Err(err) => eprintln!("recherche de mise à jour impossible : {err}"),
            }
            tokio::time::sleep(UPDATE_INTERVAL).await;
        }
    });
}

/* ---------- Affichage automatique du widget ---------- */

/// Montre ou cache le widget selon le réglage « Widget » : Toujours, Pendant
/// un match, Jamais (notifications seulement). Appelé par le widget lui-même,
/// qui continue de relever les scores quand il est caché.
///
/// À montrer pendant un jeu en plein écran : on ne passe pas devant, on
/// laisse la surveillance du plein écran l'afficher à la fin du jeu. Pas de
/// demande de focus : il apparaît sans prendre le clavier.
#[tauri::command]
fn set_widget_visible(app: AppHandle, visible: bool) {
    let Some(win) = app.get_webview_window(WIDGET) else {
        return;
    };
    if visible {
        if HIDE_FULLSCREEN.load(Ordering::SeqCst) && fullscreen_app_running() {
            HIDDEN_FOR_FULLSCREEN.store(true, Ordering::SeqCst);
            return;
        }
        if !win.is_visible().unwrap_or(false) {
            let _ = win.show();
            place_layer(&win);
        }
    } else {
        // Caché volontairement : la fin d'un jeu ne doit pas le faire revenir.
        HIDDEN_FOR_FULLSCREEN.store(false, Ordering::SeqCst);
        let _ = win.hide();
    }
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
        place_layer(&win);
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
        place_layer(&win);
        let _ = win.set_focus();
    }
}

/// Ouvre les réglages depuis l'icône près de l'horloge (clic gauche ou menu).
fn spawn_settings(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = open_settings(handle).await;
    });
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
        // Le menu ne sort qu'au clic droit : le clic gauche ouvre les réglages.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_widget(app),
            "settings" => spawn_settings(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => spawn_settings(tray.app_handle()),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
                .with_denylist(&[TOAST, NOTES])
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let [toggle, match_key] = *SHORTCUTS.lock().unwrap();
                    if Some(*shortcut) == toggle {
                        // Afficher/masquer le widget depuis n'importe où.
                        toggle_widget(app);
                    } else if Some(*shortcut) == match_key {
                        // Fenêtre Match : le widget sait quel match est en
                        // cours, on le lui demande et il ouvre la fenêtre.
                        let _ = app.emit_to(WIDGET, "shortcut-match", ());
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
            set_widget_on_top,
            set_shortcuts,
            open_espn,
            open_match,
            open_notes,
            translate_text,
            notify,
            show_toast,
            app_version,
            check_update,
            install_update,
            set_widget_visible
        ])
        .manage(PendingUpdate(Mutex::new(None)))
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
            let has_anchor = load_anchor(&handle);
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

            // Raccourcis par défaut ; le widget envoie ensuite ceux des réglages.
            {
                let mut current = SHORTCUTS.lock().unwrap();
                for (i, text) in DEFAULT_SHORTCUTS.iter().enumerate() {
                    let Ok(key) = parse_shortcut(text) else {
                        continue;
                    };
                    match app.global_shortcut().register(key) {
                        Ok(()) => current[i] = Some(key),
                        // Un autre logiciel occupe peut-être déjà le raccourci : ce n'est pas fatal.
                        Err(err) => eprintln!("raccourci global indisponible : {err}"),
                    }
                }
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
                    if has_anchor {
                        place_anchored(&win);
                    } else {
                        migrate_anchor(&win);
                    }
                }
                // Au premier lancement, le widget est en bas à gauche : c'est
                // aussi son ancrage tant que l'utilisateur ne le déplace pas.
                if needs_anchor {
                    *ANCHOR.lock().unwrap() = Edges {
                        left: true,
                        bottom: true,
                        ..Edges::default()
                    };
                }
            }
            // Passé le temps d'installation, les déplacements comptent.
            tauri::async_runtime::spawn(async {
                tokio::time::sleep(ANCHOR_GRACE).await;
                ANCHOR_READY.store(true, Ordering::SeqCst);
            });

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
