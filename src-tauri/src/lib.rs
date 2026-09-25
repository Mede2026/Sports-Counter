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
/// TheSportsDB, base sportive gratuite : seulement pour les logos manquants.
const SPORTSDB: &str = "https://www.thesportsdb.com/api/v1/json";
/// API de Wikipédia : seulement pour les logos manquants.
const WIKI_API: &str = "https://en.wikipedia.org/w/api.php";
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
    // Même demande il y a moins de 10 s (une autre fenêtre de l'app, par
    // exemple) : la même réponse, sans redemander à ESPN.
    if let Some(body) = relay_cache_get(&path) {
        return Ok(body);
    }
    let body = relay_fetch(&path).await?;
    relay_cache_put(path, body.clone());
    Ok(body)
}

/// Réponses récentes du relais : chemin -> (moment, contenu).
static RELAY_CACHE: Mutex<Vec<(String, std::time::Instant, String)>> = Mutex::new(Vec::new());
const RELAY_CACHE_TTL: Duration = Duration::from_secs(10);

fn relay_cache_get(path: &str) -> Option<String> {
    let cache = RELAY_CACHE.lock().unwrap();
    cache
        .iter()
        .find(|(p, at, _)| p == path && at.elapsed() < RELAY_CACHE_TTL)
        .map(|(_, _, body)| body.clone())
}

fn relay_cache_put(path: String, body: String) {
    let mut cache = RELAY_CACHE.lock().unwrap();
    cache.retain(|(p, at, _)| p != &path && at.elapsed() < RELAY_CACHE_TTL);
    // Pas plus de 60 réponses gardées : la mémoire reste petite.
    if cache.len() >= 60 {
        cache.remove(0);
    }
    cache.push((path, std::time::Instant::now(), body));
}

async fn relay_fetch(path: &str) -> Result<String, String> {
    let path = path.to_string();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| e.to_string())?;

    let url = if let Some(rest) = path.strip_prefix("v2/") {
        format!("{ESPN_BASE_V2}/{rest}")
    } else if let Some(rest) = path.strip_prefix("core/") {
        format!("{ESPN_CORE}/{rest}")
    } else if let Some(rest) = path.strip_prefix("openf1/") {
        // Pneus de F1 : ESPN ne les donne pas.
        format!("https://api.openf1.org/v1/{rest}")
    } else if let Some(rest) = path.strip_prefix("wiki/") {
        // Logos de secours : l'image de l'article Wikipédia d'une équipe.
        format!("{WIKI_API}{rest}")
    } else if let Some(rest) = path.strip_prefix("tsdb/") {
        // Logos de secours, pour les ligues dont ESPN n'a pas les logos (LCF).
        format!("{SPORTSDB}/{rest}")
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

    // Jusqu'à 560 px choisis à la souris, fois le zoom « Grand » (1,2).
    let logical_w = width.unwrap_or(WIDGET_WIDTH).clamp(120.0, 700.0);
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
    if hr < 0 {
        return false;
    }
    match state {
        QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE => true,
        // « Occupé » est aussi renvoyé quand on clique sur le bureau : on
        // vérifie qu'une vraie fenêtre couvre tout l'écran.
        QUNS_BUSY => foreground_covers_screen(),
        _ => false,
    }
}

/// Vrai si la fenêtre au premier plan couvre tout son écran, barre des tâches
/// comprise — sauf le bureau de Windows lui-même, qui couvre aussi l'écran.
#[cfg(windows)]
fn foreground_covers_screen() -> bool {
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct MonitorInfo {
        size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetShellWindow() -> isize;
        fn GetDesktopWindow() -> isize;
        fn GetClassNameW(hwnd: isize, name: *mut u16, max: i32) -> i32;
        fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    }
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    // Bureau, fond d'écran et barre des tâches : jamais « plein écran ».
    const SHELL_CLASSES: [&str; 4] = [
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "Shell_SecondaryTrayWnd",
    ];

    // SAFETY : fonctions de user32 appelées avec des pointeurs vers des
    // variables locales valides pendant tout l'appel ; une fenêtre fermée
    // entre-temps fait seulement échouer l'appel (valeur 0).
    unsafe {
        let fg = GetForegroundWindow();
        if fg == 0 || fg == GetShellWindow() || fg == GetDesktopWindow() {
            return false;
        }
        let mut name = [0u16; 64];
        let len = GetClassNameW(fg, name.as_mut_ptr(), name.len() as i32).max(0) as usize;
        let class = String::from_utf16_lossy(&name[..len]);
        if SHELL_CLASSES.contains(&class.as_str()) {
            return false;
        }
        let mut win = Rect::default();
        let mut info = MonitorInfo {
            size: std::mem::size_of::<MonitorInfo>() as u32,
            ..Default::default()
        };
        if GetWindowRect(fg, &mut win) == 0
            || GetMonitorInfoW(MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST), &mut info) == 0
        {
            return false;
        }
        let screen = &info.monitor;
        win.left <= screen.left
            && win.top <= screen.top
            && win.right >= screen.right
            && win.bottom >= screen.bottom
    }
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

/* ---------- Mode « Widget + fond d'écran » ---------- */

/// Vrai en mode « Widget + fond d'écran » : le widget s'efface sur le bureau,
/// où le fond d'écran montre déjà les infos.
static HIDE_ON_DESKTOP: AtomicBool = AtomicBool::new(false);
/// Vrai si c'est cette surveillance qui a caché le widget.
static HIDDEN_FOR_DESKTOP: AtomicBool = AtomicBool::new(false);
static DESKTOP_WATCH_STARTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn set_hide_on_desktop(app: AppHandle, enabled: bool) {
    HIDE_ON_DESKTOP.store(enabled, Ordering::SeqCst);
    if !enabled {
        // Mode quitté : le widget n'est pas remontré ici, le nouveau mode décide.
        HIDDEN_FOR_DESKTOP.store(false, Ordering::SeqCst);
    }
    if enabled && !DESKTOP_WATCH_STARTED.swap(true, Ordering::SeqCst) {
        watch_desktop_focus(app);
    }
}

/// Vrai quand la fenêtre au premier plan est le bureau de Windows (clic sur
/// le bureau, Win + D, toutes les fenêtres réduites).
#[cfg(windows)]
fn desktop_in_front() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetClassNameW(hwnd: isize, name: *mut u16, max: i32) -> i32;
    }
    // SAFETY : tampon local, taille donnée ; une fenêtre nulle fait échouer l'appel.
    unsafe {
        let fg = GetForegroundWindow();
        let mut name = [0u16; 32];
        let len = GetClassNameW(fg, name.as_mut_ptr(), name.len() as i32).max(0) as usize;
        matches!(
            String::from_utf16_lossy(&name[..len]).as_str(),
            "Progman" | "WorkerW"
        )
    }
}

#[cfg(not(windows))]
fn desktop_in_front() -> bool {
    false
}

/// Cache le widget pendant que le bureau est au premier plan, et le remontre
/// ensuite — seulement si c'est cette surveillance qui l'avait caché.
fn watch_desktop_focus(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let Some(win) = app.get_webview_window(WIDGET) else {
            continue;
        };
        let hide = HIDE_ON_DESKTOP.load(Ordering::SeqCst) && desktop_in_front();
        let hidden_by_us = HIDDEN_FOR_DESKTOP.load(Ordering::SeqCst);
        if hide && !hidden_by_us {
            if win.is_visible().unwrap_or(false) {
                let _ = win.hide();
                HIDDEN_FOR_DESKTOP.store(true, Ordering::SeqCst);
            }
        } else if !hide && hidden_by_us {
            HIDDEN_FOR_DESKTOP.store(false, Ordering::SeqCst);
            // Pas pendant un jeu en plein écran : l'autre surveillance s'en charge.
            if !HIDDEN_FOR_FULLSCREEN.load(Ordering::SeqCst) {
                let _ = win.show();
                place_layer(&win);
            }
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

/// Met la notification tout devant, tout de suite. Les appels de `to_front`
/// sont asynchrones : on confirme par un appel direct à Windows, pour qu'elle
/// passe devant la fenêtre active même quand le widget est sur le bureau.
#[cfg(windows)]
fn force_topmost(win: &WebviewWindow) {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: isize,
            after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    const HWND_TOPMOST: isize = -1;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_SHOWWINDOW: u32 = 0x0040;
    if let Ok(hwnd) = win.hwnd() {
        // SAFETY : la fenêtre appartient à l'app et existe ; sans déplacer ni
        // redimensionner, l'appel change seulement son ordre d'empilement.
        unsafe {
            SetWindowPos(
                hwnd.0 as isize,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }
}

#[cfg(not(windows))]
fn force_topmost(_win: &WebviewWindow) {}

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
        force_topmost(&win);
    }
}

/* ---------- Fond d'écran avec les infos ---------- */

/// Taille maximale d'un logo relayé (octets).
const IMAGE_MAX_BYTES: usize = 3 * 1024 * 1024;

/// Vrai pour une adresse d'image permise : les logos d'ESPN et de TheSportsDB.
fn image_url_is_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    host == "a.espncdn.com"
        || host.ends_with(".espncdn.com")
        || host == "www.thesportsdb.com"
        || host == "r2.thesportsdb.com"
        || host == "upload.wikimedia.org"
}

/// Relaie les octets d'un logo. Le fond d'écran est dessiné dans un canevas :
/// une image venue d'un autre site le « salirait » et empêcherait de
/// l'enregistrer, alors qu'une image reçue en octets reste utilisable.
#[tauri::command]
async fn image_bytes(url: String) -> Result<tauri::ipc::Response, String> {
    if !image_url_is_allowed(&url) {
        return Err("adresse d'image refusée".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent(BROWSER_UA)
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("réseau : {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > IMAGE_MAX_BYTES {
        return Err("image trop lourde".into());
    }
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

/// Dossier des fonds d'écran de l'app.
fn wallpaper_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fond-ecran");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Fond d'écran actuel de Windows (chemin du fichier, vide pour une couleur unie).
#[cfg(windows)]
fn current_wallpaper() -> Option<String> {
    let mut buf = [0u16; 1024];
    // SAFETY : le tampon vit pendant l'appel et sa taille est donnée.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            buf.as_mut_ptr().cast(),
            0,
        )
    };
    if ok == 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

/// Change le fond d'écran de Windows pour ce fichier (vide : couleur unie).
#[cfg(windows)]
fn apply_wallpaper(path: &str) -> Result<(), String> {
    let mut wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY : chaîne terminée par un zéro, vivante pendant l'appel.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_SETDESKWALLPAPER,
            0,
            wide.as_mut_ptr().cast(),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        )
    };
    if ok == 0 {
        Err("Windows a refusé le fond d'écran".into())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SystemParametersInfoW(
        action: u32,
        param: u32,
        pv: *mut std::ffi::c_void,
        win_ini: u32,
    ) -> i32;
}
#[cfg(windows)]
const SPI_GETDESKWALLPAPER: u32 = 0x0073;
#[cfg(windows)]
const SPI_SETDESKWALLPAPER: u32 = 0x0014;
#[cfg(windows)]
const SPIF_UPDATEINIFILE: u32 = 0x01;
#[cfg(windows)]
const SPIF_SENDCHANGE: u32 = 0x02;

/// Clé du registre où Windows range la façon d'afficher le fond d'écran.
#[cfg(windows)]
const DESKTOP_KEY: &str = "Control Panel\\Desktop";

#[cfg(windows)]
#[link(name = "advapi32")]
extern "system" {
    fn RegGetValueW(
        key: isize,
        sub_key: *const u16,
        value: *const u16,
        flags: u32,
        kind: *mut u32,
        data: *mut std::ffi::c_void,
        size: *mut u32,
    ) -> i32;
    fn RegSetKeyValueW(
        key: isize,
        sub_key: *const u16,
        value: *const u16,
        kind: u32,
        data: *const std::ffi::c_void,
        size: u32,
    ) -> i32;
}
#[cfg(windows)]
const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Valeur texte de HKCU\Control Panel\Desktop (« WallpaperStyle »…).
#[cfg(windows)]
fn desktop_value(name: &str) -> Option<String> {
    const RRF_RT_REG_SZ: u32 = 0x2;
    let mut buf = [0u16; 64];
    let mut size = (buf.len() * 2) as u32;
    let (key, value) = (wide(DESKTOP_KEY), wide(name));
    // SAFETY : chaînes terminées par zéro et tampon de la taille annoncée.
    let rc = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if rc != 0 {
        return None;
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

#[cfg(windows)]
fn set_desktop_value(name: &str, data: &str) {
    const REG_SZ: u32 = 1;
    let (key, value, text) = (wide(DESKTOP_KEY), wide(name), wide(data));
    // SAFETY : chaînes terminées par zéro ; la taille compte le zéro final.
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            REG_SZ,
            text.as_ptr().cast(),
            (text.len() * 2) as u32,
        );
    }
}

/// Façon d'afficher le fond d'écran : (style, mosaïque).
#[cfg(windows)]
fn wallpaper_fit() -> Option<(String, String)> {
    Some((
        desktop_value("WallpaperStyle")?,
        desktop_value("TileWallpaper").unwrap_or_else(|| "0".into()),
    ))
}

#[cfg(windows)]
fn set_wallpaper_fit(style: &str, tile: &str) {
    set_desktop_value("WallpaperStyle", style);
    set_desktop_value("TileWallpaper", tile);
}

#[cfg(not(windows))]
fn wallpaper_fit() -> Option<(String, String)> {
    None
}

#[cfg(not(windows))]
fn set_wallpaper_fit(_style: &str, _tile: &str) {}

#[cfg(not(windows))]
fn current_wallpaper() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn apply_wallpaper(_path: &str) -> Result<(), String> {
    Err("seulement sous Windows".into())
}

/// Reçoit l'image (JPEG) dessinée par le widget et en fait le fond d'écran.
/// La première fois, le fond d'écran d'origine est noté pour le remettre.
#[tauri::command]
fn set_wallpaper(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("image attendue".into());
    };
    // Un JPEG commence toujours par FF D8 FF.
    if bytes.len() < 4 || bytes[..3] != [0xFF, 0xD8, 0xFF] || bytes.len() > 40 * 1024 * 1024 {
        return Err("image invalide".into());
    }
    let dir = wallpaper_dir(&app)?;
    let original = dir.join("origine.txt");
    let active = dir.join(ACTIVE_FILE);
    let current = current_wallpaper().unwrap_or_default();

    // Fond d'écran changé à la main dans Windows depuis notre dernière image :
    // on respecte son choix au lieu de l'écraser. Le widget quitte le mode.
    if let Ok(ours) = std::fs::read_to_string(&active) {
        if !current.is_empty()
            && current != ours.trim()
            && !current.starts_with(&*dir.to_string_lossy())
        {
            forget_original(&dir);
            return Err(WALLPAPER_CHANGED.into());
        }
    }

    if !original.exists() && !current.starts_with(&*dir.to_string_lossy()) {
        std::fs::write(&original, &current).map_err(|e| e.to_string())?;
        // Une copie de l'image elle-même : Windows garde souvent le fond dans
        // un fichier à lui (« TranscodedWallpaper ») qu'il remplacera par le
        // nôtre. Sans copie, impossible de remettre le vrai fond ensuite.
        if let Ok(bytes) = std::fs::read(&current) {
            if is_image(&bytes) && bytes.len() <= 40 * 1024 * 1024 {
                let _ = std::fs::write(dir.join(ORIGINAL_COPY), bytes);
            }
        }
        if let Some((style, tile)) = wallpaper_fit() {
            let _ = std::fs::write(dir.join("origine-style.txt"), format!("{style}\n{tile}"));
        }
    }
    // « Remplir » : l'image couvre l'écran sans déformation. Les zones
    // cliquables (les matchs) tombent alors au bon endroit.
    set_wallpaper_fit("10", "0");
    // Deux noms en alternance : avec toujours le même, Windows peut garder
    // l'ancienne image en mémoire.
    let flip = NEXT_WALLPAPER.fetch_add(1, Ordering::SeqCst) % 2;
    let file = dir.join(format!("sports-counter-{flip}.jpg"));
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let path = file.to_string_lossy().to_string();
    apply_wallpaper(&path)?;
    // Ce qu'on vient de poser, pour reconnaître un changement fait à la main.
    let _ = std::fs::write(&active, current_wallpaper().unwrap_or(path));
    Ok(())
}

/// Réponse de `set_wallpaper` quand l'utilisateur a choisi un autre fond d'écran.
const WALLPAPER_CHANGED: &str = "fond-change";
/// Chemin du dernier fond posé par l'app (présent tant que le mode est actif).
const ACTIVE_FILE: &str = "actif.txt";
/// Copie de l'image du fond d'écran d'origine.
const ORIGINAL_COPY: &str = "origine-copie";

/// Oublie le fond d'origine noté (l'utilisateur en a choisi un nouveau).
fn forget_original(dir: &std::path::Path) {
    for name in [
        "origine.txt",
        "origine-style.txt",
        ORIGINAL_COPY,
        ACTIVE_FILE,
    ] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    WALL_SPOTS.lock().unwrap().spots.clear();
}

/// Vrai pour le fichier interne où Windows range le fond d'écran : son contenu
/// change dès qu'un autre fond est posé, il ne sert donc pas à le remettre.
fn is_windows_copy(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.contains("transcodedwallpaper") || lower.contains("\\themes\\cachedfiles")
}

/// Extension d'après les premiers octets d'une image.
fn image_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG") {
        "png"
    } else if bytes.starts_with(b"BM") {
        "bmp"
    } else if bytes.starts_with(b"RIFF") {
        "webp"
    } else {
        "jpg"
    }
}

static NEXT_WALLPAPER: AtomicU64 = AtomicU64::new(0);

/// Image choisie pour l'arrière-plan du fond d'écran d'infos.
const PHOTO_FILE: &str = "photo-choisie";

/// Vrai pour une image que Windows et le canevas savent lire.
fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(b"\x89PNG")
        || bytes.starts_with(b"BM")
        || (bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

/// Photo d'arrière-plan : celle choisie dans les réglages, sinon le fond
/// d'écran d'origine de l'utilisateur.
#[tauri::command]
fn wallpaper_photo(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    let dir = wallpaper_dir(&app)?;
    let chosen = dir.join(PHOTO_FILE);
    let copy = dir.join(ORIGINAL_COPY);
    let path = if chosen.exists() {
        chosen
    } else if copy.exists() {
        copy
    } else if let Ok(original) = std::fs::read_to_string(dir.join("origine.txt")) {
        std::path::PathBuf::from(original.trim())
    } else {
        std::path::PathBuf::from(current_wallpaper().unwrap_or_default())
    };
    // Jamais un de nos propres fonds : l'image s'afficherait dans elle-même.
    let own =
        path.starts_with(&dir) && !path.ends_with(PHOTO_FILE) && !path.ends_with(ORIGINAL_COPY);
    if path.as_os_str().is_empty() || own || is_windows_copy(&path.to_string_lossy()) {
        return Err("aucune photo".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 40 * 1024 * 1024 || !is_image(&bytes) {
        return Err("photo illisible".into());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

/// Garde l'image choisie dans les réglages ; vide : reprendre la sienne.
#[tauri::command]
fn save_wallpaper_photo(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("image attendue".into());
    };
    let file = wallpaper_dir(&app)?.join(PHOTO_FILE);
    if bytes.is_empty() {
        let _ = std::fs::remove_file(file);
        return Ok(());
    }
    if bytes.len() > 40 * 1024 * 1024 || !is_image(bytes) {
        return Err("format d'image non pris en charge (JPEG, PNG, BMP ou WebP)".into());
    }
    std::fs::write(file, bytes).map_err(|e| e.to_string())
}

/// Zone cliquable du fond d'écran : un match dessiné dans l'image.
#[derive(serde::Deserialize, Clone)]
struct WallSpot {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    league: String,
    event: String,
}

/// Zones cliquables, avec la taille de l'image où elles ont été mesurées.
struct WallSpots {
    width: f64,
    height: f64,
    spots: Vec<WallSpot>,
}

static WALL_SPOTS: Mutex<WallSpots> = Mutex::new(WallSpots {
    width: 0.0,
    height: 0.0,
    spots: Vec::new(),
});
static WALL_CLICKS_STARTED: AtomicBool = AtomicBool::new(false);

/// Le widget donne l'emplacement des matchs dans l'image : un clic sur le
/// bureau à cet endroit ouvre la fenêtre Match, comme un clic dans le widget.
#[tauri::command]
fn set_wallpaper_spots(app: AppHandle, width: f64, height: f64, spots: Vec<WallSpot>) {
    let spots: Vec<WallSpot> = spots
        .into_iter()
        .filter(|s| id_is_safe(&s.league) && id_is_safe(&s.event))
        .take(64)
        .collect();
    *WALL_SPOTS.lock().unwrap() = WallSpots {
        width,
        height,
        spots,
    };
    if !WALL_CLICKS_STARTED.swap(true, Ordering::SeqCst) {
        watch_desktop_clicks(app);
    }
}

/// Match sous ce point de l'image, s'il y en a un.
fn spot_at(x: f64, y: f64) -> Option<(String, String)> {
    let wall = WALL_SPOTS.lock().unwrap();
    wall.spots
        .iter()
        .find(|s| x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h)
        .map(|s| (s.league.clone(), s.event.clone()))
}

/// Surveille les clics sur le bureau (et seulement là) tant que le fond
/// d'écran d'infos est posé. On lit l'état du bouton toutes les 35 ms, sans
/// crochet système : rien ne s'intercale entre la souris et les autres logiciels.
#[cfg(windows)]
fn watch_desktop_clicks(app: AppHandle) {
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct MonitorInfo {
        size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
        fn GetCursorPos(point: *mut Point) -> i32;
        fn WindowFromPoint(point: Point) -> isize;
        fn GetAncestor(hwnd: isize, flags: u32) -> isize;
        fn GetClassNameW(hwnd: isize, name: *mut u16, max: i32) -> i32;
        fn MonitorFromPoint(point: Point, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfo) -> i32;
    }
    const VK_LBUTTON: i32 = 0x01;
    const GA_ROOT: u32 = 2;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    // SAFETY (toute la fonction) : appels de user32 avec des pointeurs vers
    // des variables locales valides ; une fenêtre disparue fait seulement
    // échouer l'appel.
    let on_desktop = |p: Point| unsafe {
        let root = GetAncestor(WindowFromPoint(p), GA_ROOT);
        let mut name = [0u16; 32];
        let len = GetClassNameW(root, name.as_mut_ptr(), name.len() as i32).max(0) as usize;
        matches!(
            String::from_utf16_lossy(&name[..len]).as_str(),
            "Progman" | "WorkerW"
        )
    };

    std::thread::spawn(move || {
        let mut down: Option<Point> = None;
        loop {
            let idle = WALL_SPOTS.lock().unwrap().spots.is_empty();
            std::thread::sleep(Duration::from_millis(if idle { 500 } else { 35 }));
            if idle {
                down = None;
                continue;
            }
            let pressed = unsafe { GetAsyncKeyState(VK_LBUTTON) } as u16 & 0x8000 != 0;
            let mut p = Point::default();
            if unsafe { GetCursorPos(&mut p) } == 0 {
                continue;
            }
            match (pressed, down) {
                (true, None) => down = Some(p),
                (false, Some(start)) => {
                    down = None;
                    // Un vrai clic : pas un glisser (sélection de fichiers).
                    if (p.x - start.x).abs() > 6 || (p.y - start.y).abs() > 6 || !on_desktop(p) {
                        continue;
                    }
                    let mut info = MonitorInfo {
                        size: std::mem::size_of::<MonitorInfo>() as u32,
                        ..Default::default()
                    };
                    let monitor = unsafe { MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST) };
                    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
                        continue;
                    }
                    // La même image remplit chaque écran : on ramène le point
                    // à ses coordonnées dans l'image.
                    let (mw, mh) = (
                        (info.monitor.right - info.monitor.left).max(1) as f64,
                        (info.monitor.bottom - info.monitor.top).max(1) as f64,
                    );
                    let (iw, ih) = {
                        let wall = WALL_SPOTS.lock().unwrap();
                        (wall.width, wall.height)
                    };
                    if iw <= 0.0 || ih <= 0.0 {
                        continue;
                    }
                    // Remplissage « couverture » : l'échelle la plus grande.
                    let k = (mw / iw).max(mh / ih);
                    let ox = (mw - iw * k) / 2.0;
                    let oy = (mh - ih * k) / 2.0;
                    let x = ((p.x - info.monitor.left) as f64 - ox) / k;
                    let y = ((p.y - info.monitor.top) as f64 - oy) / k;
                    if let Some((league, event)) = spot_at(x, y) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = open_match(app, league, event).await;
                        });
                    }
                }
                _ => {}
            }
        }
    });
}

#[cfg(not(windows))]
fn watch_desktop_clicks(_app: AppHandle) {}

/// Remet le fond d'écran d'origine (en quittant le mode « Fond d'écran »).
#[tauri::command]
fn restore_wallpaper(app: AppHandle) -> Result<(), String> {
    let dir = wallpaper_dir(&app)?;
    WALL_SPOTS.lock().unwrap().spots.clear();
    let Ok(path) = std::fs::read_to_string(dir.join("origine.txt")) else {
        let _ = std::fs::remove_file(dir.join(ACTIVE_FILE));
        return Ok(()); // jamais changé
    };
    let path = path.trim().to_string();
    // Sa façon d'afficher le fond d'écran d'abord : Windows la relit en le posant.
    if let Ok(fit) = std::fs::read_to_string(dir.join("origine-style.txt")) {
        let mut parts = fit.lines();
        if let (Some(style), Some(tile)) = (parts.next(), parts.next()) {
            set_wallpaper_fit(style.trim(), tile.trim());
        }
    }
    // Le fichier d'origine s'il existe encore et n'est pas la copie interne
    // de Windows ; sinon la copie gardée par l'app ; sinon une couleur unie
    // (mieux que de laisser nos infos, devenues périmées).
    let usable = !path.is_empty()
        && !is_windows_copy(&path)
        && !path.starts_with(&*dir.to_string_lossy())
        && std::path::Path::new(&path).exists();
    let target = if usable {
        path
    } else if let Ok(bytes) = std::fs::read(dir.join(ORIGINAL_COPY)) {
        let file = dir.join(format!("fond-origine.{}", image_ext(&bytes)));
        std::fs::write(&file, &bytes).map_err(|e| e.to_string())?;
        file.to_string_lossy().to_string()
    } else if !path.is_empty()
        && !path.starts_with(&*dir.to_string_lossy())
        && !is_windows_copy(&path)
    {
        path
    } else {
        String::new()
    };
    apply_wallpaper(&target)?;
    forget_original(&dir);
    Ok(())
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
        // Sur le bureau en mode « Widget + fond d'écran » : il reviendra en
        // quittant le bureau.
        if HIDE_ON_DESKTOP.load(Ordering::SeqCst) && desktop_in_front() {
            HIDDEN_FOR_DESKTOP.store(true, Ordering::SeqCst);
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
            "quit" => {
                // L'image d'infos deviendrait périmée : on remet le fond d'origine.
                // Il reviendra au prochain démarrage si le mode est toujours choisi.
                let _ = restore_wallpaper(app.clone());
                app.exit(0)
            }
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
            set_widget_visible,
            image_bytes,
            set_wallpaper,
            restore_wallpaper,
            wallpaper_photo,
            save_wallpaper_photo,
            set_wallpaper_spots,
            set_hide_on_desktop
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
