# Fakir

[Jouer à Fakir](https://chtabay.github.io/fakir/) · [Code source](https://github.com/chtabay/fakir)

Fakir est un clicker d'apprentissage dans le navigateur. Deux rails placent les nombres A et B ; une bille traverse des rangées de potards, propose une réponse, puis reçoit une correction. Le jeu commence par `2 + 3`. Les commandes, les opérations, le répertoire et la calculatrice apparaissent progressivement.

Le plateau est le modèle de calcul : **8 rangées de 17 angles**, dont au plus quatre voisins interviennent à chaque rangée d'un trajet. Chaque famille possède ses paramètres. Ils partent sans apprentissage préalable et restent acquis au fil de la partie. Les révisions internes reprennent uniquement des couples déjà présentés et ont leurs propres compteurs, distincts des lancers.

Les mesures proviennent des réponses du modèle. Le jalon de multiplication demande **97 % des 100 couples entre chiffres à une erreur absolue ≤ 0,5**, en plus du nombre de lancers requis. Ce score sur le répertoire ne prouve pas une généralisation. La calculatrice réutilise les prédictions élémentaires avec des règles de composition fournies par le programme. Voir [le moteur, les mesures et leurs limites](docs/learning.md).

## Lancer en local

Depuis la racine du dépôt :

```sh
python3 -m http.server 4173
```

Ouvre [http://localhost:4173](http://localhost:4173). Le jeu est écrit en HTML, CSS et modules JavaScript ES, sans dépendance d'exécution, backend, compte ni clé d'API. Un serveur HTTP permet de charger les modules de `index.html`.

## Version autonome

Avec Node.js et npm :

```sh
npm run build
```

Ouvre ensuite `dist/fakir.html` par double-clic. Styles, icônes et code sont intégrés ; le jeu utilise les polices système et fonctionne hors ligne. Aucune installation de dépendances n'est nécessaire pour cet assemblage. La disponibilité du stockage local pour un fichier dépend du navigateur ; l'export et l'import JSON restent utilisables.

## Conserver une partie

La sauvegarde automatique reste dans le navigateur. **Partie → Exporter / Importer** transfère la progression, les paramètres appris, les exemples mémorisés et l'état d'optimisation. Un changement de navigateur, d'appareil ou d'adresse nécessite ce transfert ; il n'y a pas de synchronisation distante.

Le moteur actuel utilise une sauvegarde **v3**, distincte de la **v2**. Les anciens poids MLP ne sont pas convertis. Si une progression v2 est présente, **Partie → Partie précédente** ouvre la [version précédente autonome](reference/fakir-v2.html), avec sa sauvegarde d'origine conservée. Recommencer la partie actuelle n'efface pas cette ancienne partie.

## Sources et références

| Fichier | Rôle |
| --- | --- |
| [index.html](index.html), [style.css](style.css) | Interface sobre et responsive. |
| [js/learning.js](js/learning.js), [js/optimizer.js](js/optimizer.js) | Trajectoire, apprentissage local, mémoire des exemples et L-BFGS. |
| [js/network-view.js](js/network-view.js) | Animation des traces et angles calculés par le moteur. |
| [js/game-state.js](js/game-state.js), [js/game.js](js/game.js) | Progression, commandes et sauvegarde. |
| [js/calculator.js](js/calculator.js) | Composition des opérations élémentaires. |
| [tests/](tests/), [docs/learning.md](docs/learning.md) | Vérifications et détails techniques. |
| [reference/prototype-v1.html](reference/prototype-v1.html) | Prototype d'origine conservé pour comparaison. |
| [reference/fakir-v2.html](reference/fakir-v2.html) | Ancienne version MLP, jouable séparément. |

Les archives ne servent pas de moteur à la partie actuelle. Les échanges privés et documents de conversation ne sont pas inclus.

## Vérifier

Avec Node.js, sans paquet de test externe :

```sh
node --test
```

Pour l'interface, vérifier aussi dans le navigateur un lancement, une correction, les commandes débloquées et un aller-retour export/import.

## Publier une copie sur GitHub Pages

1. Place les sources dans un dépôt public, sur `main`, avec `index.html` et `.nojekyll` à la racine.
2. Dans **Settings → Pages → Build and deployment**, choisis **Deploy from a branch**, puis **main** et **/(root)**.
3. Attends le déploiement et ouvre l'adresse affichée par GitHub.

Les chemins relatifs fonctionnent sous l'adresse d'un dépôt. Aucun workflow de compilation personnalisé n'est nécessaire pour servir les sources. Voir la [documentation GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
