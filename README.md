# Sports Counter

Widget flottant de scores sportifs en direct pour **Windows**.
Il reste au-dessus de toutes les fenêtres, se déplace à la souris, et affiche
seulement les équipes que tu choisis.

![Le widget](tools/preview/widget.png)

## Ce que ça fait

- **Toujours au-dessus** des autres fenêtres, sur tous les bureaux virtuels.
- **Déplaçable** : tu attrapes la barre du haut, la position est retenue au prochain lancement.
- **Impossible à perdre hors de l'écran** : le widget est ramené dans la zone
  visible s'il en dépasse, et ne passe jamais sous la barre des tâches.
- **Collé en bas à gauche** au premier lancement, juste au-dessus de la barre
  des tâches. Posé dans la moitié basse de l'écran, il grandit vers le haut :
  son bord inférieur reste collé à la barre.
- **Activable / désactivable** : `Ctrl + Alt + S`, ou clic sur l'icône dans la zone de notification.
- **Logos des équipes** affichés à côté de chaque score.
- **Choix des équipes** dans une fenêtre de réglages, ligue par ligue.
- **Rafraîchissement adaptatif** : toutes les 25 s pendant un match, toutes les 5 min sinon.
- **Prochain match** : une équipe favorite qui ne joue pas aujourd'hui montre
  quand même son prochain match (jusqu'à 10 jours).
- **F1** : la séance en cours ou la prochaine, et le **top 3** pendant et
  après chaque séance.
- **Couleurs de ton équipe** sur la bordure du widget.
- **Clic sur un match** : ouvre sa page sur ESPN.
- **Démarre avec Windows** et **se cache pendant les jeux en plein écran**
  (deux cases dans les réglages).
- **Mises à jour** : l'app en cherche toute seule et **demande avant
  d'installer** (« Installer » / « Plus tard ») ; bouton « Rechercher une mise
  à jour » dans les réglages.
- **Affichage du widget** : Toujours, Pendant un match (il apparaît quand un de
  tes matchs est en direct), ou Jamais (notifications seulement).
- **Mode compact** : une ligne par match — logo, pointage | pointage, logo.
- **Séries éliminatoires de la LNH** : ronde, numéro du match, état de la série,
  prolongations multiples ; statuts du hockey en français.
- **Aimant** : lâché à moins de 40 px d'un bord, le widget y glisse et le bord
  s'illumine.
- **Notifications de l'app** : un encadré aux couleurs de l'équipe surgit
  au-dessus du widget (en bas à gauche s'il est caché) pour un but — avec le
  buteur quand ESPN le fournit —, un début ou une fin de match, ou une séance
  de F1, puis disparaît après 6 s. Il ne prend jamais le clavier, se
  tait pendant les jeux en plein écran, et un clic ouvre le match sur ESPN.
  Au basket, seulement le début et la fin : le score y change trop souvent.

![Une notification](tools/preview/toast.png)

## Ligues couvertes

LNH, NBA, NFL, MLB, Premier League, Ligue des champions, Formule 1.

Les données viennent de l'API publique d'ESPN : **aucun compte, aucune clé
d'API**. En contrepartie, c'est une API non officielle, qui peut changer sans
préavis.

La liste des équipes de la LNH est intégrée à l'app (`src/lib/teams-nhl.js`) :
l'adresse d'ESPN qui la fournit est illisible depuis une application. Pour les
autres ligues, les équipes sont retrouvées dans le calendrier des matchs, qui,
lui, est lisible.

## Obtenir l'app sans rien installer

C'est la voie recommandée. **Tu n'installes aucun outil de développement.**

1. Onglet **Actions** du dépôt → dernière exécution de « Compiler pour Windows »
2. Section **Artifacts** en bas → télécharger `Sports-Counter-Windows`
3. Décompresser, lancer l'installateur

GitHub compile l'app sur une vraie machine Windows, et la taille exacte des
fichiers produits s'affiche dans le résumé de chaque exécution.

Pour un lien de téléchargement permanent, voir « Publier une version »
plus bas : l'installateur apparaît alors dans les **Releases** du dépôt.

## Mises à jour automatiques

L'app vérifie au démarrage, puis toutes les 6 heures, s'il existe une version
plus récente dans les **Releases** du dépôt. Si oui, elle la télécharge,
**vérifie sa signature**, puis l'installe.

### La signature

Chaque version publiée est signée avec une **clé privée**. L'app contient la
**clé publique** correspondante (`src-tauri/tauri.conf.json`) et refuse toute
mise à jour qui n'a pas été signée avec la clé privée. Personne d'autre ne peut
donc lui faire installer une fausse version.

**La clé privée ne doit jamais entrer dans le dépôt.** Elle vit uniquement
dans un secret GitHub :

1. Dépôt → **Settings** → **Secrets and variables** → **Actions**
2. **New repository secret**
3. Nom : `TAURI_SIGNING_PRIVATE_KEY`
4. Valeur : tout le contenu du fichier de clé privée

Si ce secret est perdu, les versions déjà installées ne pourront plus se mettre
à jour : il faudra générer une nouvelle paire de clés et réinstaller l'app une
fois à la main.

### Publier une version

1. Monter la version dans `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
   et `package.json` (par exemple `0.2.1`), et pousser
2. Onglet **Actions** → **Compiler pour Windows** → **Run workflow**, cocher
   **Publier une version signée**, puis **Run workflow**

GitHub crée l'étiquette `v0.2.1`, compile, signe et publie. Pousser soi-même
une étiquette `v0.2.1` fonctionne aussi. La publication refuse de continuer
si le secret est absent, ou si une étiquette poussée à la main ne correspond
pas à la version de l'app.

## Compiler soi-même (facultatif)

À ne faire que pour modifier le code et voir le résultat immédiatement.
Il faut alors installer, une seule fois :

1. **Rust** — https://rustup.rs
2. **Visual Studio Build Tools** avec la charge de travail « Développement Desktop en C++ »
3. **Node.js** — https://nodejs.org

```bash
npm install
npm run dev      # lance l'app en mode développement
npm run build    # produit l'installateur dans src-tauri/target/release/bundle/
```

> **Attention** : cet outillage occupe **3 à 6 Go**, et le dossier de
> compilation `src-tauri/target` encore **2 à 4 Go**. Ça ne concerne que la
> machine qui compile — l'app produite, elle, reste à quelques mégaoctets.
> Tu peux supprimer `src-tauri/target` à tout moment, il se régénère.
>
> Si tu ne veux pas de ça, utilise la GitHub Action ci-dessus : tu modifies le
> code, tu pousses, et tu récupères l'installateur compilé.

## Aperçu sans compiler

```bash
npm run preview
```

Rend le widget et l'écran de réglages dans Chromium avec des données de
démonstration, et enregistre les captures dans `tools/preview/`.
Tu peux aussi ouvrir `src/index.html?demo` via n'importe quel serveur local.

## Organisation du code

| Chemin | Rôle |
|---|---|
| `src/index.html`, `widget.js`, `widget.css` | le widget lui-même |
| `src/settings.html`, `settings.js`, `settings.css` | le choix des équipes et les options |
| `src/lib/api.js` | appels à ESPN et mise en forme des données |
| `src/lib/leagues.js` | catalogue des ligues |
| `src/lib/store.js` | préférences, dans `localStorage` |
| `src/lib/crest.js` | logo d'équipe, avec repli sur un monogramme coloré |
| `src-tauri/src/lib.rs` | fenêtre, zone de notification, raccourci global, relais réseau |
| `tools/` | génération des icônes et des aperçus |

Les requêtes réseau partent d'abord de la page elle-même : dans l'app, elle
tourne dans WebView2, un vrai Chromium, et le pare-feu d'ESPN accepte ce type
de client. Si ce chemin échoue, un relais Rust (commande `espn_get`) prend le
relais ; son domaine est fixé dans le code, donc l'interface ne peut pas
rediriger les appels ailleurs.

## Réglages disponibles

- Équipes suivies, par ligue
- Mode compact (masque les noms d'équipes)
- Nombre de matchs affichés (1 à 10)
- Opacité du widget
- Masquage automatique des matchs terminés depuis plus de 6 h

## Retrouver le widget quand il a disparu

Windows range souvent les nouvelles icônes de la zone de notification derrière
la petite flèche `^`, à côté de l'horloge. Trois façons de rappeler le widget :

1. **`Ctrl + Alt + S`**
2. **Relancer l'app** depuis le menu Démarrer : elle ne s'ouvre pas en double,
   elle réaffiche le widget
3. Bouton **« Afficher le widget »** dans la fenêtre de réglages

Pour épingler l'icône à côté de l'horloge : *Paramètres → Personnalisation →
Barre des tâches → Autres icônes de la barre d'état système*.

## Limites connues

- L'API ESPN n'est pas officielle : si ESPN change son format, il faudra adapter
  `src/lib/api.js`.
- La Formule 1 n'a pas de suivi tour par tour : le widget affiche la course en
  cours ou la prochaine, sans classement en direct.
- Le chiffrement des connexions passe par Schannel, le composant TLS de
  Windows, plutôt que par une bibliothèque embarquée. L'app est plus légère,
  mais elle suit le magasin de certificats du système.
