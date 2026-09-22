# Sports Counter

Widget flottant de scores sportifs en direct pour **Windows**.
Il reste au-dessus de toutes les fenêtres, se déplace à la souris, et affiche
seulement les équipes que tu choisis.

![Le widget](tools/preview/widget.png)

## Ce que ça fait

- **Toujours au-dessus** des autres fenêtres, sur tous les bureaux virtuels.
- **Déplaçable** : tu attrapes la barre du haut, la position est retenue au prochain lancement.
- **Activable / désactivable** : `Ctrl + Alt + S`, ou clic sur l'icône dans la zone de notification.
- **Logos des équipes** affichés à côté de chaque score.
- **Choix des équipes** dans une fenêtre de réglages, ligue par ligue.
- **Rafraîchissement adaptatif** : toutes les 25 s pendant un match, toutes les 5 min sinon.

## Ligues couvertes

LNH, NBA, NFL, MLB, Premier League, Ligue des champions, Formule 1.

Les données viennent de l'API publique d'ESPN : **aucun compte, aucune clé
d'API**. En contrepartie, c'est une API non officielle, qui peut changer sans
préavis.

## Installation pour développer

Il faut installer une fois :

1. **Rust** — https://rustup.rs
2. **Visual Studio Build Tools** avec la charge de travail « Développement Desktop en C++ »
3. **WebView2** — déjà présent sur Windows 11 et sur Windows 10 à jour
4. **Node.js** — https://nodejs.org

Ensuite :

```bash
npm install
npm run dev      # lance l'app en mode développement
npm run build    # produit l'installateur dans src-tauri/target/release/bundle/
```

> **Note sur le poids** : l'outillage ci-dessus est volumineux, mais il ne sert
> qu'à compiler. L'app produite, elle, pèse quelques mégaoctets, parce que
> Tauri réutilise le moteur WebView2 déjà installé dans Windows au lieu
> d'embarquer son propre navigateur.

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

Les requêtes réseau passent par Rust (commande `espn_get`) plutôt que par la
page web : ça évite les blocages CORS, et le domaine appelé est fixé dans le
code, donc l'interface ne peut pas rediriger les appels ailleurs.

## Réglages disponibles

- Équipes suivies, par ligue
- Mode compact (masque les noms d'équipes)
- Nombre de matchs affichés (1 à 10)
- Opacité du widget
- Masquage automatique des matchs terminés depuis plus de 6 h

## Limites connues

- L'API ESPN n'est pas officielle : si ESPN change son format, il faudra adapter
  `src/lib/api.js`.
- La Formule 1 n'a pas de suivi tour par tour : le widget affiche la course en
  cours ou la prochaine, sans classement en direct.
- Le flou acrylique nécessite Windows 10 (version 1809) ou plus récent. S'il
  n'est pas disponible, le widget reste simplement semi-transparent.
