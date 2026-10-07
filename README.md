# Fakir

**Une bille, une erreur, un déclic : une petite machine apprend à calculer.**

[Jouer à Fakir](https://chtabay.github.io/fakir/)

Fakir est un clicker jouable dans le navigateur. Chaque entraînement présente un exemple à un petit réseau neuronal : il propose une réponse, reçoit une correction, puis ajuste ses connexions. La progression ouvre de nouvelles opérations, des améliorations et une calculatrice qui réutilise les apprentissages.

Le projet reprend l'idée d'un plateau de fakir pour rendre l'apprentissage visible. Deux rails gradués placent les entrées **A** et **B** ; leur position et la direction du segment qui les relie décrivent le couple. L'angle seul ne suffit pas à identifier les deux valeurs. La bille, les connexions et les potards représentent les signaux et les biais du réseau multicouche, sans simuler des collisions physiques.

## Jouer

Commence par **2 + 3** avec un bouton et un compteur. Les améliorations, le choix des entrées, les mesures et les vues supplémentaires apparaissent progressivement. Les crédits gagnés permettent ensuite d'accélérer l'entraînement.

- **La machine** montre les deux rails d'entrée, les connexions, la prédiction et la correction. Une fois les sélecteurs disponibles, passer de `2 + 3` à `2 + 1` change la géométrie d'entrée et les signaux observés.
- **Le répertoire** permet d'examiner les erreurs calcul par calcul.
- **La calculatrice** assemble les petites opérations apprises pour traiter des calculs plus longs.
- **Partie**, en bas de page, permet d'ajuster les effets, d'exporter la progression, de la réimporter ou de recommencer.

Un compteur indique le travail effectué. Les jauges de qualité sont calculées à partir des réponses du modèle : elles peuvent progresser, stagner ou reculer au cours de l'entraînement.

## Lancer en local

Depuis la racine du dépôt, avec Python 3 :

```sh
python3 -m http.server 4173
```

Ouvre ensuite [http://localhost:4173](http://localhost:4173) dans un navigateur récent.

Le projet utilise des modules JavaScript ES. Passe par ce serveur HTTP local pour les charger ; l'ouverture directe de `index.html` avec une URL `file://` peut bloquer leur chargement.

Le jeu ne nécessite aucune installation de dépendances, aucun backend, aucun compte et aucune clé d'API. HTML, CSS et JavaScript sont servis tels quels. L'entraînement et les calculs s'exécutent sur l'appareil.

## Version autonome

Pour produire un fichier HTML qui s'ouvre par double-clic, avec Node.js et npm :

```sh
npm run build
```

Le résultat est `dist/fakir.html`. Il contient le jeu, ses styles et ses icônes ; aucune installation de dépendances ni connexion internet n'est nécessaire pour le jouer. L'interface utilise les polices système de l'appareil.

La sauvegarde locale dépend de ce que le navigateur autorise pour un fichier ouvert directement. L'export et l'import JSON restent disponibles pour conserver une expérience et la transférer entre ce fichier, la version locale servie par HTTP et une version publiée.

## Sauvegarder une expérience

La progression est enregistrée dans le `localStorage` du navigateur. L'état appris comprend les poids des réseaux, les mémoires de l'optimiseur et l'état du générateur pseudoaléatoire ; reprendre une expérience conserve donc son apprentissage.

Utilise **Partie → Exporter** pour obtenir un fichier JSON, puis **Importer** pour le reprendre ailleurs. Cette exportation est utile avant un changement d'appareil, de navigateur ou d'adresse du jeu : chaque origine web dispose de son propre stockage. La copie locale et une publication GitHub Pages n'utilisent donc pas automatiquement la même sauvegarde.

Les données restent dans le navigateur et dans les fichiers que tu exportes. Il n'y a pas de synchronisation entre appareils.

## Ce que la machine apprend

Chaque famille possède son propre réseau **2 → 12 → 12 → 1** : addition, soustraction, multiplication et division. Les réseaux sont entraînés par rétropropagation avec un optimiseur Adam implémenté en JavaScript.

Les exemples portent sur deux chiffres de 0 à 9 ; le diviseur zéro est exclu. Les réponses attendues servent à corriger et à évaluer le modèle. La fonction de prédiction utilise les entrées et les paramètres appris.

Trois notions sont distinguées dans le jeu :

| Notion | Ce qui est réalisé |
| --- | --- |
| Apprendre le répertoire | Ajuster un réseau sur les opérations entre chiffres, puis mesurer ses réponses sur cette grille. |
| Composer un calcul | Réutiliser ces prédictions avec des règles de retenue, d'emprunt, de position et d'assemblage fournies par le programme. |
| Généraliser | Réussir sur un domaine réservé ou différent de celui d'entraînement ; les jauges actuelles ne démontrent pas cette capacité. |

La calculatrice conserve les erreurs possibles des opérations apprises. Une réussite élevée dans le répertoire ne garantit pas l'exactitude de tous les calculs composés. Le fonctionnement et ses limites sont détaillés dans [Apprentissage, mesures et limites](docs/learning.md).

Elle accepte une opération entre deux nombres signés, avec au plus trois chiffres avant la virgule et deux après. Les points et les virgules décimales sont reconnus. Une division par zéro est refusée ; les quotients sont arrondis à quatre décimales.

## Structure du projet

| Chemin | Rôle |
| --- | --- |
| `index.html` | Page d'entrée du jeu. |
| `style.css` | Présentation et adaptations aux tailles d'écran. |
| `favicon.svg` | Icône du projet. |
| `js/game.js` | Interface, progression du clicker et coordination du jeu. |
| `js/learning.js` | Réseaux, entraînement, évaluation et état des modèles ; indépendant du DOM. |
| `js/network-view.js` | Rails d'entrée, signaux, potards des biais et animation des corrections. |
| `js/calculator.js` | Composition des calculs à partir des prédictions élémentaires. |
| `tests/` | Tests automatisés exécutés avec Node.js. |
| `docs/learning.md` | Explication technique, sources et limites de l'expérience. |
| `reference/prototype-v1.html` | Prototype d'origine conservé comme référence de comparaison. |
| `.nojekyll` | Indique à GitHub Pages de servir les fichiers statiques sans traitement Jekyll. |

Le prototype de référence est séparé du jeu courant. Il permet de comparer l'expérience initiale avec cette version, sans servir de moteur au jeu actuel. Le dépôt ne contient pas les échanges privés ni les documents de conversation ayant accompagné sa conception.

## Vérifier le projet

Avec une version de Node.js disposant du lanceur `node:test`, depuis la racine :

```sh
node --test
```

Les tests du moteur couvrent notamment l'évolution des erreurs après entraînement, la dépendance des prédictions aux poids, l'indépendance des familles, les gradients, les mesures exhaustives et la reprise après sauvegarde. Aucun paquet de test externe n'est nécessaire.

Pour vérifier l'expérience, lance aussi le jeu dans le navigateur : entraîne la première opération, examine le répertoire, puis exporte et réimporte une progression. Les tests du moteur ne remplacent pas cette vérification de l'interface.

## Publier sur GitHub Pages

Cette section décrit comment publier une copie du projet.

1. Crée un dépôt public et place les fichiers du projet sur sa branche `main`, avec `index.html` et `.nojekyll` à la racine.
2. Ouvre **Settings → Pages** dans le dépôt.
3. Dans **Build and deployment**, choisis **Deploy from a branch**.
4. Sélectionne **main** et **/(root)**, puis enregistre.
5. Attends la fin du déploiement, ouvre l'adresse affichée par GitHub et vérifie le jeu ainsi que sa sauvegarde.

Les chemins des assets et des modules sont relatifs pour fonctionner sous le chemin d'un dépôt GitHub Pages. Une modification publiée sur la branche choisie entraîne une mise à jour du site. Voir la [documentation officielle sur les sources de publication GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

Pour cette application statique, le déploiement depuis `main` ne demande pas de workflow de compilation personnalisé.
