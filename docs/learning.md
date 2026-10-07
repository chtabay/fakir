# Apprentissage, mesures et limites

Fakir met en scène une boucle simple : **prédire, comparer, corriger**. Cette page précise ce qui est appris, ce qui est fourni par le programme et ce que les mesures permettent de conclure.

## Les trois niveaux de l'expérience

### 1. Apprendre un répertoire d'opérations

Le moteur reçoit deux nombres et produit une estimation. Pour chaque famille, les exemples d'entraînement appartiennent à une grille finie :

| Famille | Premier nombre | Second nombre | Taille de la grille complète | Tolérance par défaut |
| --- | --- | --- | --- | --- |
| Addition | Entier de 0 à 9 | Entier de 0 à 9 | 100 calculs | Erreur absolue ≤ 0,5 |
| Soustraction | Entier de 0 à 9 | Entier de 0 à 9 | 100 calculs | Erreur absolue ≤ 0,5 |
| Multiplication | Entier de 0 à 9 | Entier de 0 à 9 | 100 calculs | Erreur absolue ≤ 0,5 |
| Division | Entier de 0 à 9 | Entier de 1 à 9 | 90 calculs | Erreur absolue ≤ 0,15 |

Les couples sont ordonnés : `2 + 3` et `3 + 2` sont deux exemples distincts. La commutativité n'est pas ajoutée comme une règle au réseau. Le programme connaît les réponses attendues pour produire les exemples supervisés.

### 2. Composer des calculs

La calculatrice utilise les prédictions élémentaires dans des procédures d'assemblage. Les règles de numération, de position, de retenue, d'emprunt et de traitement des décimales sont écrites dans le programme. Le réseau n'apprend pas lui-même ces procédures.

Par exemple, traiter `38 + 47` peut réutiliser les additions entre chiffres et transporter une retenue. Cette réutilisation permet de dépasser la longueur des exemples élémentaires. Elle ne transforme pas la calculatrice en un unique réseau ayant appris directement toutes les additions de nombres à plusieurs chiffres.

Une étape élémentaire inexacte peut modifier une retenue ou un chiffre, puis affecter le reste du calcul. Le résultat composé et sa trace permettent d'observer ces effets. Une mesure globale sur le répertoire ne constitue pas une probabilité de réussite pour une expression particulière.

La [calculatrice actuelle](../js/calculator.js) accepte une opération entre deux nombres signés, avec au plus trois chiffres entiers et deux décimales par nombre. Elle fournit deux valeurs : une estimation conservant les sorties non arrondies des opérations élémentaires, et un résultat décodé pour l'assemblage. Ces valeurs peuvent différer ; le résultat n'est pas remplacé par l'évaluation native de l'expression complète.

La division posée réutilise notamment les produits appris et les soustractions apprises pour choisir les chiffres et mettre à jour le reste. Le réseau de division peut proposer un quotient lorsque les opérandes de l'étape sont des chiffres. Le programme traite six positions décimales internes avant l'arrondi final à quatre décimales. Des bornes de composition empêchent les estimations invalides de provoquer une boucle sans fin ; un reste décodé négatif est ramené à zéro avec une indication dans la trace. Ces règles de contrôle sont elles aussi fournies par le programme.

### 3. Démontrer une généralisation

La grille évaluée est celle dans laquelle les exemples d'entraînement sont tirés. À mesure que le modèle travaille, les mêmes couples peuvent être présentés de nombreuses fois. Les résultats actuels mesurent donc la qualité sur ce répertoire ; aucun ensemble de test indépendant n'est réservé dans cette version.

Le moteur accepte aussi des entrées finies hors de la grille pendant la prédiction. La simple possibilité de les saisir ne démontre pas qu'il sait extrapoler. Une expérience de généralisation demanderait un protocole distinct : réserver des couples avant l'entraînement, fixer les critères de réussite, puis mesurer séparément ces exemples et les entrées hors domaine.

Il faut ainsi distinguer une bonne approximation du répertoire, une composition réussie avec des règles fournies et un résultat obtenu sur des données effectivement nouvelles.

## Un réseau par famille

Le moteur est défini dans [`js/learning.js`](../js/learning.js). Chaque famille dispose d'un perceptron multicouche de taille **2 → 12 → 12 → 1** : deux entrées, deux couches cachées de douze neurones et une sortie. Cela représente 205 poids et biais entraînables par famille.

Les couches cachées utilisent `tanh`. La sortie est linéaire : sa valeur peut varier librement et n'est pas bornée à l'intervalle des réponses du répertoire. Les entrées sont normalisées par `x / 4,5 − 1` et la sortie est remise à l'échelle de sa famille.

Les paramètres de chaque réseau sont indépendants. Entraîner une addition ne modifie pas les poids de la multiplication. À l'intérieur d'une même famille, tous les couples partagent les mêmes paramètres : corriger un calcul peut améliorer ou dégrader les réponses à d'autres calculs.

## Ce que fait un exemple d'entraînement

Une opération d'entraînement comporte les étapes suivantes :

1. Le réseau calcule sa proposition à partir des deux entrées et de ses poids courants.
2. Le professeur calcule la cible arithmétique exacte.
3. Le moteur forme l'erreur entre la prédiction normalisée et la cible normalisée.
4. La rétropropagation calcule comment les poids et les biais contribuent à cette erreur.
5. Adam met à jour ces paramètres, puis le réseau produit une nouvelle proposition pour montrer l'effet de la correction.

La fonction de perte est la moitié du carré de l'erreur sur la sortie normalisée. Adam conserve des moyennes mobiles du gradient et de son carré. L'implémentation utilise `β1 = 0,5`, `β2 = 0,999`, `ε = 10⁻⁸`, un gradient borné composante par composante à `[-5, 5]` et un taux d'apprentissage `0,006 / (1 + t / 1500)`, où `t` compte les mises à jour. Ces réglages appartiennent à Fakir ; ce ne sont pas tous les paramètres par défaut de l'article Adam de Kingma et Ba.[¹](#sources)

Un exemple produit une mise à jour. Les commandes accélérées présentent plusieurs exemples ; elles ne remplacent pas le calcul des gradients par une augmentation artificielle de la précision. Une correction n'est pas garantie d'améliorer chaque réponse à chaque étape.

### Le programme d'entraînement

Le curriculum automatique des additions commence par répéter `2 + 3` pendant les 20 premiers exemples. Il passe ensuite aux chiffres de 0 à 4 jusqu'à 200 exemples entraînés, puis aux chiffres de 0 à 9. Les autres familles utilisent leur grille complète par défaut.

Ce curriculum décrit le moteur. Les chapitres et les améliorations du clicker règlent l'accès aux commandes et le rythme des exemples ; ils ne constituent pas une mesure scientifique indépendante.

## Le professeur et la prédiction

Un apprentissage supervisé a besoin de réponses de référence. Ici, elles sont obtenues par les opérations arithmétiques du programme, dans les chemins d'entraînement et d'évaluation.

La séparation est explicite dans le code : `predict()` lance le calcul du réseau et remet sa sortie à l'échelle ; cette inférence ne consulte ni la bonne réponse du couple, ni le compteur d'exemples pour fabriquer son résultat. Le compteur intervient dans le curriculum et l'optimiseur, mais ne donne pas directement une « précision » à la prédiction.

La calculatrice possède, de son côté, les règles d'assemblage décrites plus haut. La séparation entre inférence et professeur ne signifie donc pas que toute l'arithmétique du logiciel a été apprise.

## Lire les mesures

`evaluate()` parcourt tous les couples de la grille demandée, sans entraîner le modèle. Le programme peut mesurer le premier exemple, la petite grille ou la grille complète ; il faut lire le périmètre affiché avec le résultat.

| Mesure | Interprétation |
| --- | --- |
| Nombre d'exemples entraînés | Nombre de mises à jour effectuées ; un même couple peut revenir. |
| Erreur absolue d'un calcul | Distance entre la sortie du réseau et sa cible. |
| Erreur absolue moyenne, ou MAE | Moyenne de ces distances sur tous les couples évalués. |
| Erreur maximale | Plus grand écart observé dans cette grille. |
| Part dans la tolérance | Proportion de couples dont l'erreur absolue ne dépasse pas le seuil choisi. |

Une valeur de 95 % dans la tolérance signifie que 95 % des couples du périmètre satisfont le seuil au moment de la mesure. Elle ne signifie pas « 95 % de chances que le prochain résultat soit exact ». Une progression du compteur n'impose aucune progression de cette jauge.

Les réponses de division restent décimales dans le moteur : `1 ÷ 2` a pour cible `0,5`. `predict()` ne les arrondit pas à un entier. Les arrondis nécessaires pour écrire un chiffre dans un calcul composé appartiennent à la calculatrice et doivent être distingués de la sortie brute du modèle.

## Le rôle du plateau

Le plateau et ses animations servent à lire le réseau : entrées, activité des neurones, connexions et retour de correction. Une bille représente un exemple présenté au modèle.

Cette représentation ne simule pas une bille matérielle heurtant des clous. Le résultat est produit par les opérations numériques du réseau. La visualisation expose son activité sans devenir une deuxième implémentation de l'apprentissage.

## Sauvegarde et reprise

L'état du moteur contient les poids, les biais, les compteurs, les mémoires Adam et l'état pseudoaléatoire de chaque famille. La conservation de ces éléments permet de poursuivre le même entraînement après restauration, dans le même environnement de calcul.

L'import vérifie la version, l'architecture, les dimensions, les nombres finis, les variances et la cohérence des compteurs avant de remplacer l'état courant. Un import de modèle invalide est rejeté sans modifier le modèle en cours.

La sauvegarde du jeu utilise le stockage local du navigateur et peut être exportée en JSON. Les états d'entraînement restent sur l'appareil ; aucun service d'apprentissage distant n'intervient.

## Comparaison avec le prototype d'origine

Le fichier [`reference/prototype-v1.html`](../reference/prototype-v1.html) conserve la première expérience de plateau, de corrections et de déblocages. Cette référence permet d'examiner les choix qui ont évolué.

| Sujet | Prototype conservé | Version actuelle |
| --- | --- | --- |
| Proposition de la machine | La simulation réintroduit la cible dans la trajectoire et le résultat, en fonction d'un indice de progression. | L'inférence provient des poids et biais du réseau. La cible est utilisée ensuite pour corriger et mesurer. |
| Précision affichée | Une formule dépend surtout du nombre de tours et de la cible. | L'évaluation calcule les erreurs sur chaque couple de la grille choisie. |
| Domaine de sortie | La proposition est bornée à `[-10, 20]`, ce qui empêche notamment d'atteindre `9 × 9 = 81`. | La sortie linéaire du réseau peut dépasser 20 ; ses erreurs restent mesurées. |
| Mémoire | L'état de progression et le biais sont attachés aux couples d'opérandes, avec des clous partagés. | Les couples d'une famille partagent un réseau entraînable. |
| Décimales | La fonction de table arrondit la proposition à un entier. | Le moteur conserve la prédiction brute, y compris pour les quotients décimaux. |
| Grandes opérations | Plusieurs chemins reposent sur des approximations spécifiques au prototype. | La calculatrice sépare les prédictions élémentaires des règles de composition fournies. |

Le prototype reste une référence de conception. Il n'est pas importé par le jeu et ses mécanismes ne servent pas à entraîner les réseaux actuels.

## Ce que vérifient les tests du moteur

[`tests/learning.test.mjs`](../tests/learning.test.mjs) examine notamment :

- l'apprentissage du premier exemple et l'amélioration sur les quatre grilles ;
- la dépendance de l'inférence aux paramètres, en modifiant explicitement les poids ;
- l'indépendance des mémoires entre familles ;
- la concordance de gradients analytiques avec des dérivées numériques ;
- la reprise déterministe de l'entraînement après export et restauration ;
- le calcul exhaustif des métriques, sans effet sur l'état appris ;
- le rejet de sauvegardes invalides sans altérer l'état en cours.

Ces contrôles portent sur les comportements décrits. Ils ne démontrent ni une exactitude générale de la calculatrice, ni une généralisation hors du répertoire, ni une progression monotone pour toutes les graines et tous les ordres d'exemples.

## Sources

- **Sources du projet :** le [prototype conservé](../reference/prototype-v1.html), le [moteur courant](../js/learning.js), ses [tests](../tests/learning.test.mjs) et la [calculatrice](../js/calculator.js). Les exemples supervisés sont générés par le programme ; aucun corpus externe n'est téléchargé.
- **¹ Optimiseur :** Diederik P. Kingma et Jimmy Ba, [*Adam: A Method for Stochastic Optimization*](https://arxiv.org/abs/1412.6980), article présenté à ICLR 2015. Fakir en utilise le principe d'estimation des deux premiers moments du gradient, avec les réglages indiqués dans cette page.
