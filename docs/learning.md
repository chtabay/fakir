# Moteur, apprentissage et mesures

Fakir utilise un plateau différentiable : la trajectoire numérique produit la réponse et ses paramètres sont corrigés à partir d'exemples supervisés. Cette page décrit le moteur de la partie v3. Les sources de référence sont [`learning.js`](../js/learning.js), [`optimizer.js`](../js/optimizer.js), [`network-view.js`](../js/network-view.js) et leurs [tests](../tests/).

## Trois notions différentes

| Notion | Ce que réalise le projet |
| --- | --- |
| Apprendre le répertoire | Ajuster les angles sur des opérations entre chiffres et mesurer les réponses sur cette grille. |
| Composer un calcul | Réutiliser les prédictions avec des règles de position, retenue, emprunt et traitement des décimales écrites dans le programme. |
| Démontrer une généralisation | Évaluer séparément des couples réservés ou un autre domaine. Les jauges du jeu ne constituent pas ce test. |

Les exemples sont tirés dans une grille finie. Un même couple revient et peut être révisé plusieurs fois. Une bonne approximation de cette grille ne démontre ni l'extrapolation, ni une compréhension générale de l'arithmétique.

## Le plateau est le modèle

Chaque famille — addition, soustraction, multiplication et division — possède **8 rangées de 17 guides**. Un guide porte un paramètre entraînable `p` et son angle est `θ = 1,05 × tanh(p)`, en radians. Il y a donc **136 paramètres par famille**. Les angles restent compris entre `−1,05` et `1,05` radians ; ils ne sont pas les biais d'un MLP dessiné sous forme de potards.

Les guides sont régulièrement placés sur `[-2, 2]`. À une position donnée, une interpolation B-spline cubique combine **au plus quatre guides voisins** de la rangée. Les paramètres éloignés ne contribuent pas à cette interaction. Aux bords, les indices sont ramenés aux guides disponibles.

Pour deux chiffres `a` et `b`, les deux rails fournissent :

```text
A = 2a / 9 − 1
B = 2b / 9 − 1
v = B − A
x = B + 0,25v
```

`x` est la position du premier impact et `v` la direction horizontale. **La position et la direction comptent ensemble** : `(2, 3)` et `(4, 5)` ont la même différence, donc la même direction initiale, mais occupent des positions différentes.

À chaque rangée, le moteur interpole l'angle local puis applique :

```text
v' = −v + tan(angle local)
x' = x + 0,7v'
```

Les nouveaux `x` et `v` alimentent la rangée suivante. La réponse vaut `décalage + échelle × x final`, avec des constantes propres à chaque famille :

| Famille | Décalage | Échelle |
| --- | ---: | ---: |
| Addition | 9 | 9 |
| Soustraction | 0 | 9 |
| Multiplication | 40,5 | 40,5 |
| Division | 4,5 | 4,5 |

La position et la sortie ne sont pas tronquées aux limites du plateau. Les sorties négatives, décimales ou incorrectes restent observables.

Cette règle est un modèle simplifié de rebond, conçu pour être différentiable. Elle ne prétend pas reproduire une réflexion spéculaire exacte, une gravité ou des collisions de billes solides. Le dessin suit les traces calculées par ce moteur ; il ne substitue pas une trajectoire décorative à une réponse produite ailleurs.

## Corriger et réviser

Un lancement présente un couple au moteur. Celui-ci calcule d'abord sa réponse avec ses paramètres actuels. Le professeur fournit ensuite la cible arithmétique exacte, utilisée pour former la perte et ses gradients. `predict()` ne consulte ni cette cible, ni une table de réponses mémorisées : l'inférence utilise les entrées et les angles appris.

Les paramètres commencent avec de petits angles aléatoires, sans poids préentraînés. L'ouverture d'une nouvelle étape conserve ce qui a été appris. Chaque famille garde son propre plateau : entraîner l'addition ne modifie pas la multiplication.

L'optimiseur **L-BFGS**, implémenté en JavaScript, reprend les seuls couples déjà présentés. La mémoire contient une cible par couple distinct et conserve aussi ses répétitions. Les répétitions sont comptées sans multiplier silencieusement le poids de ce couple dans l'objectif de révision. Aucune grille complète n'est injectée dans l'entraînement avant d'avoir été rencontrée.

La perte moyenne combine, pour chaque couple mémorisé, l'erreur quadratique sur la sortie normalisée et une pénalité de bord : `0,1 × somme(max(|x| − 1,9, 0)²)` sur les neuf positions du trajet. Cette pénalité encourage la bille à rester près du plateau sans borner sa position ni lui fournir la bonne réponse.

Chaque présentation demande au plus **un pas L-BFGS accepté**, avec une mémoire de vingt couples de courbure et une recherche limitée à quarante essais. Tant qu'un seul couple distinct est connu, la variation de chaque paramètre `p` est limitée à `0,004` par pas pour rendre les premières corrections visibles. Elle est ensuite limitée à `0,003` jusqu'à la couverture de toute la grille : 100 couples, ou 90 pour la division. Après cette couverture, cette limite supplémentaire est retirée. Les premiers cas peuvent ainsi être corrigés sans déformer trop vite les guides, tout en conservant les paramètres acquis. Un pas peut aussi ne rien modifier lorsque l'optimiseur a convergé ou ne trouve pas d'amélioration acceptable.

Une révision évalue la perte et le gradient sur ces exemples mémorisés, puis cherche une mise à jour acceptable. Les essais de la recherche de pas ne deviennent pas des états appris intermédiaires. Quand la liste des couples change, les informations de courbure devenues périmées sont invalidées ; les paramètres acquis restent conservés.

Il faut distinguer **la localité d'un trajet** et **la portée d'une révision**. Un trajet utilise au plus quatre guides par rangée. Une révision de plusieurs couples utilise l'union de leurs trajets : elle peut corriger plus de guides que ceux visités par la seule bille affichée. On ne peut donc pas attribuer toute une révision collective à cette unique bille.

Les compteurs conservés par le moteur distinguent ces événements :

| Compteur | Ce qu'il compte |
| --- | --- |
| `trained` | Présentations, y compris les répétitions d'un même couple. |
| `observed` | Couples distincts déjà rencontrés. |
| `optimizerSteps` | Mises à jour effectivement acceptées. |
| `gradientEvaluations` | Évaluations de l'objectif et de son gradient par l'optimiseur. |
| `exampleEvaluations` | Couples évalués au total dans ces évaluations d'objectif. |
| `revisions` | Réévaluations des autres couples mémorisés : `exampleEvaluations − gradientEvaluations`, soit `(couples connus − 1) × évaluations du pas`, cumulées. |

Réévaluer cent couples déjà connus pendant une recherche de pas n'est pas lancer cent nouveaux exemples. Ces compteurs ne sont pas tous affichés à l'écran ; la partie distingue notamment **Exemples** et **Révisions**. Les calculs auxiliaires des traces et des gradients destinés à l'animation ne sont pas ajoutés au compteur d'évaluations de l'optimiseur.

## Lire la précision

`evaluate()` calcule les réponses de tous les couples du périmètre demandé, sans entraîner le modèle ni enrichir sa mémoire d'exemples. Le premier calcul, la petite grille et la grille complète sont des périmètres différents.

| Famille | Premier nombre | Second nombre | Grille complète | Tolérance par défaut |
| --- | --- | --- | ---: | --- |
| Addition | Entier de 0 à 9 | Entier de 0 à 9 | 100 couples | Erreur absolue ≤ 0,5 |
| Soustraction | Entier de 0 à 9 | Entier de 0 à 9 | 100 couples | Erreur absolue ≤ 0,5 |
| Multiplication | Entier de 0 à 9 | Entier de 0 à 9 | 100 couples | Erreur absolue ≤ 0,5 |
| Division | Entier de 0 à 9 | Entier de 1 à 9 | 90 couples | Erreur absolue ≤ 0,15 |

Les couples sont ordonnés : `2 + 3` et `3 + 2` restent distincts. La commutativité n'est pas introduite comme règle dans l'inférence.

| Mesure | Signification |
| --- | --- |
| Erreur d'un calcul | Valeur absolue de la différence entre réponse et cible. |
| Erreur moyenne, ou MAE | Moyenne de ces écarts sur le périmètre évalué. |
| Erreur maximale | Plus grand écart dans ce périmètre. |
| Part dans la tolérance | Proportion des couples dont l'écart ne dépasse pas le seuil. |

Le jalon de multiplication demande **au moins 97 couples sur 100 à un écart ≤ 0,5**, ainsi que le minimum de lancers prévu par la [progression](../js/game-state.js). Cela ne signifie pas « 97 % de chances que le prochain résultat soit exact ». Ce seuil est un objectif du jeu, pas une garantie de convergence pour toute graine et tout ordre d'exemples. Une correction peut améliorer certaines réponses et en dégrader d'autres.

Le compteur n'impose pas la qualité affichée. La division conserve les sorties décimales : la cible de `1 ÷ 2` est `0,5`. Les arrondis de la calculatrice sont une étape distincte de la prédiction brute.

## La calculatrice

La [calculatrice](../js/calculator.js) accepte une opération entre deux nombres signés, avec au plus trois chiffres entiers et deux décimales par nombre. Elle compose les petites opérations prédites avec des règles de numération et de calcul posé fournies par le programme. Le plateau n'apprend pas lui-même les retenues, les emprunts ou les positions décimales.

Le résultat n'est pas remplacé par l'évaluation native de toute l'expression. Une estimation élémentaire erronée peut changer un chiffre ou une retenue et affecter la suite. La trace permet d'examiner ces étapes. Une précision élevée sur la grille ne garantit pas tous les calculs composés.

La division posée réutilise des produits et des soustractions appris ; le modèle de division peut proposer un quotient pour une étape entre chiffres. La composition traite six positions décimales internes avant l'arrondi final à quatre décimales. Des bornes de contrôle évitent les boucles sans fin lorsque les prédictions sont incohérentes. Une division par zéro est refusée.

## Sauvegardes v3 et partie précédente

La partie actuelle utilise la clé locale **`fakir-v3-progress`**. Son export JSON conserve la progression, les paramètres, les exemples déjà rencontrés, les compteurs, le générateur pseudoaléatoire et l'état d'optimisation. L'import valide l'état avant de remplacer la partie courante.

La version MLP précédente reste disponible dans [`reference/fakir-v2.html`](../reference/fakir-v2.html), un fichier autonome. Elle continue d'utiliser **`fakir-v2-progress`**. Le lien **Partie → Partie précédente** apparaît lorsqu'une sauvegarde v2 existe sur la même origine. Les anciens poids ne sont pas convertis en angles et la nouvelle partie ne les charge pas. Recommencer en v3 ne supprime pas la sauvegarde v2.

Chaque origine web possède son stockage : GitHub Pages, une adresse locale et un fichier ouvert directement ne partagent pas automatiquement leurs parties. **Exporter / Importer** permet de les transférer dans la version compatible. Aucun service distant ne reçoit les états appris.

## Les deux références conservées

Le [prototype v1](../reference/prototype-v1.html) conserve l'idée initiale du plateau, des corrections et des déblocages. Sa simulation réintroduit la cible dans la trajectoire et la prédiction à partir d'un indice lié au nombre de tours. Sa sortie est bornée à `[-10, 20]`, ce qui empêche notamment d'atteindre `9 × 9 = 81`, et sa fonction de table arrondit les propositions à un entier. Ces choix en font une référence de conception, pas le moteur d'apprentissage actuel.

La [version v2](../reference/fakir-v2.html) remplace cette simulation par de vrais MLP denses **2 → 12 → 12 → 1**, entraînés avec Adam. Ses potards représentent des biais et les connexions restent denses. La v3 utilise directement le plateau à interactions locales pour calculer la réponse. Les trois versions permettent de comparer les expériences ; les archives ne sont pas importées par le moteur courant.

## Vérifications et limites

Les [tests](../tests/) constituent les contrôles reproductibles du moteur JavaScript. Un résultat dépend de la graine, des couples présentés et du budget de révision ; il ne peut pas être transformé en garantie universelle à partir de quelques expériences.

Les vérifications pertinentes portent sur les gradients, la dépendance des sorties aux angles, la localité des interactions, l'absence de cibles cachées dans la prédiction, l'indépendance des familles, les compteurs, la restauration et l'évaluation sans entraînement. La visualisation demande également une vérification dans le navigateur.

Cette expérience reste limitée à un petit domaine supervisé. Elle ne démontre pas une exactitude générale, une amélioration monotone, une convergence pour toute initialisation ou une simulation mécanique complète. Les exemples sont produits par le professeur du programme ; aucun corpus externe ni poids préentraîné n'est téléchargé.
