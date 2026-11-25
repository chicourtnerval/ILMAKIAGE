# Boutique MAISON

Une boutique de maquillage en ligne dont la mise en page reprend celle d’Il Makiage (bande noire en biais, barre de catégories, fiches produits), en anglais, avec un back-office en français pour tout gérer sans toucher au code.

- La boutique : l’adresse de votre site, par exemple `https://ma-boutique.herokuapp.com`
- Le back-office : la même adresse suivie de `/admin`, par exemple `https://ma-boutique.herokuapp.com/admin`

## Ce que contient le dossier

| Fichier | À quoi il sert |
|---|---|
| `server.js` | Le serveur : il affiche la boutique et enregistre vos modifications |
| `public/index.html` | La boutique |
| `public/admin.html` | Le back-office |
| `public/apercu.html` | L’aperçu « Format téléphone » du back-office |
| `seed.json` | Le contenu de la boutique chargé au premier lancement (produits de démonstration, ou votre boutique si le dossier vient de « Télécharger une sauvegarde ») |
| `seed-images/` | Les photos chargées au premier lancement (présent seulement dans un site téléchargé depuis le back-office) |
| `package.json`, `Procfile` | Les instructions pour Heroku (ne pas modifier) |

Vous n’avez rien à modifier dans ces fichiers : tout se règle depuis le back-office.

## Ce que ça coûte

Heroku n’a plus d’offre gratuite. Il faut compter environ :

- **5 $ par mois** pour faire tourner le site (formule « Eco »). Le site se met en veille après 30 minutes sans visite, et le premier visiteur attend alors quelques secondes. La formule « Basic » (environ 7 $) n’a pas de mise en veille.
- **5 $ par mois** pour la base de données qui garde vos produits et vos photos (formule « Essential 0 »).

Vérifiez les tarifs à jour sur heroku.com/pricing. Heroku demande une carte bancaire à l’inscription.

---

## Étape 1 : mettre les fichiers sur GitHub

1. Créez un compte sur **github.com** (gratuit).
2. En haut à droite, cliquez sur **+** puis **New repository**.
3. Donnez un nom (par exemple `ma-boutique`), cochez **Private**, puis cliquez sur **Create repository**.
4. Sur la page qui s’affiche, cliquez sur le lien **uploading an existing file**.
5. Décompressez le fichier `.zip` sur votre ordinateur. Ouvrez le dossier `maison-boutique`, sélectionnez **tout son contenu** (les fichiers et le dossier `public`) et faites-le glisser dans la page GitHub.
   Attention : glissez le contenu du dossier, pas le dossier lui-même.
6. Attendez la fin de l’envoi, puis cliquez sur **Commit changes** en bas de la page.

Vérification : à la racine de votre projet GitHub, vous devez voir `server.js`, `package.json`, `Procfile` et le dossier `public`.

## Étape 2 : mettre le site en ligne sur Heroku

1. Créez un compte sur **heroku.com**.
2. Cliquez sur **New** puis **Create new app**. Choisissez un nom (il apparaîtra dans l’adresse du site) et la région **Europe**, puis **Create app**.
3. **Ajoutez la base de données** (indispensable, sinon vos modifications seront effacées à chaque redémarrage) :
   onglet **Resources**, dans **Add-ons** tapez `Heroku Postgres`, choisissez la formule **Essential 0** et validez.
4. **Choisissez votre mot de passe du back-office** :
   onglet **Settings**, bouton **Reveal Config Vars**. Dans la case **KEY** tapez `ADMIN_PASSWORD`, dans la case **VALUE** tapez votre mot de passe, puis **Add**.
   Choisissez un mot de passe long, que vous n’utilisez nulle part ailleurs.
5. **Reliez GitHub** :
   onglet **Deploy**, dans **Deployment method** cliquez sur **GitHub**, connectez votre compte, cherchez votre projet et cliquez sur **Connect**.
6. Plus bas, cliquez sur **Enable Automatic Deploys** : à chaque changement sur GitHub, le site se mettra à jour tout seul.
7. Tout en bas, cliquez sur **Deploy Branch** et attendez le message de réussite (une à deux minutes).
8. En haut à droite, cliquez sur **Open app** : votre boutique est en ligne.

## Étape 3 : utiliser le back-office

Allez à l’adresse de votre site suivie de `/admin` et entrez votre mot de passe.

- **Produits** : ajouter, modifier, dupliquer ou supprimer un produit. Pour chaque produit : nom, sous-titre (ex. Flawless Base Foundation), catégorie, prix, photos, teintes, tailles ou contenances, étiquette rose (Best Seller, New!…), note en étoiles, bouton « ADD TO BAG » ou « FIND MY SHADE », et s’il est visible, nouveau ou dans les Best Sellers.
  Commencez par **Supprimer les produits de démonstration**.
  Dans la fiche d’un produit, la partie **Présent dans les catégories** permet de cocher ou décocher chaque catégorie, rayon par rayon.
  Pour modifier plusieurs produits d’un coup, cochez-les dans la liste puis cliquez sur **Modifier** dans la barre noire : catégories, prix (nouveau prix ou baisse en %), prix barré, tailles, visibilité, nouveauté, à la une.
- **Télécharger une sauvegarde** (en haut de chaque page) : télécharge **tout le site** dans un fichier `.zip` : le serveur, les pages, ce guide, et le contenu actuel de la boutique (produits, catégories, réglages, pages, photos envoyées depuis le back-office). Voir « Remettre le site en ligne à partir d’une sauvegarde » plus bas.
- **Importer / Exporter** : importer vos produits depuis Shopify, télécharger vos produits en CSV, faire une sauvegarde complète ou la restaurer.
- **Catégories** : les catégories de la barre du haut (BEST SELLERS, FACE, SKIN, LIPS, BROWS, EYES, SKIN GOALS), dans l’ordre voulu, avec leurs sous-catégories (Foundation, Concealer…). « SHOP ALL » est ajouté tout seul à la fin.
- **Apparence** : logo, nom de la boutique, petit texte sous le nom (ex. PARIS), devise (£, € ou $), bandeau qui défile, couleur des étiquettes et des prix en promotion, format des photos.
- **Réglages** : vente privée (remise sur tous les articles), frais de livraison, réseaux sociaux (les icônes du bas de page n’apparaissent que si le lien est rempli), texte du bas de page.
- **CHECKOUT** : l’adresse (URL) de votre page de paiement externe. Quand un client clique sur « Passer commande », il est envoyé vers cette adresse avec le contenu de son panier. Si le champ est vide, le client voit un message d’erreur et n’est pas redirigé.
- **En direct** : l’activité de la boutique en temps réel, actualisée toute seule toutes les 4 secondes. Vous voyez le nombre de visiteurs en ce moment, la page que chacun regarde, d’où il vient (Instagram, TikTok, Google…), son appareil et le montant de son panier. Vous voyez aussi les derniers ajouts au panier, les passages au paiement, les produits les plus vus du jour et les chiffres des jours précédents.
  Vos propres visites ne sont pas comptées quand vous êtes connecté au back-office : pour tester, utilisez une fenêtre de navigation privée ou votre téléphone. « Passage au paiement » veut dire que le client a cliqué sur « Passer commande », pas qu’il a payé.
- **Réglages → Mode maintenance** : cochez la case puis cliquez sur **Enregistrer** pour remplacer la boutique par une page « Maintenance en cours ». Vous pouvez changer le titre et le message et ajouter une image. Vous, connecté au back-office, voyez toujours la boutique, avec un bandeau rouge qui vous rappelle que la maintenance est active. Décochez la case puis enregistrez pour remettre la boutique en ligne.
- **Réglages → Limite de panier** : cochez la case, choisissez le montant maximum puis enregistrez. Un client ne peut plus ajouter d’article au-delà de ce montant (prix après remise, hors livraison).
- **Pages** : FAQs, About us, Exchanges & Returns, Contact us, Terms, Terms of Sale, Privacy. Elles s’affichent en bas de la boutique et dans le menu ; une page vide n’apparaît pas.
  Les mentions légales et les CGV sont obligatoires pour vendre en ligne en France.

Chaque modification est en ligne dès que vous cliquez sur **Enregistrer**.

## Remettre le site en ligne à partir d’une sauvegarde

Le `.zip` téléchargé avec **Télécharger une sauvegarde** contient tout. Pour repartir de zéro (nouveau compte, nouvelle app Heroku) :

1. Décompressez le `.zip`. Suivez l’**Étape 1** avec le contenu du dossier (fichiers, dossier `public` et dossier `seed-images`).
2. Suivez l’**Étape 2** : nouvelle app, **Heroku Postgres**, mot de passe `ADMIN_PASSWORD` (il n’est pas dans le `.zip`, par sécurité), liaison GitHub, **Deploy Branch**.
3. Au premier lancement, la base de données est vide : le site charge alors la boutique et les photos contenues dans le `.zip`. Tout est là, comme au moment du téléchargement.

Si la base de données contient déjà une boutique (même app Heroku qu’avant), c’est elle qui reste affichée : le `.zip` ne l’écrase pas.

GitHub accepte au plus 100 fichiers par envoi et 25 Mo par fichier. Si vous avez beaucoup de photos, envoyez le dossier `seed-images` en plusieurs fois.

## Importer vos produits depuis Shopify

1. Dans Shopify : **Produits**, bouton **Exporter**, choisissez **Tous les produits** et le format CSV.
2. Dans le back-office : **Importer / Exporter**, bouton **Choisir un fichier CSV**.
3. Vérifiez l’aperçu, choisissez le rayon à utiliser quand il n’est pas indiqué, puis cliquez sur **Importer**.

Ce qui est repris : nom, description, catégorie (le « Type » Shopify), prix, prix barré, couleurs (teintes), tailles, photos (y compris la photo de chaque teinte), produits masqués (brouillons).
Si vous importez à nouveau le même fichier, les produits déjà présents sont mis à jour au lieu d’être ajoutés en double.

Les photos restent hébergées chez Shopify. Si vous fermez votre boutique Shopify, remplacez-les en envoyant les photos depuis le back-office.

## Les polices

La boutique utilise des polices gratuites très proches de celles d’Il Makiage : Playfair Display (titres), Inter (textes), Work Sans (barre des catégories) et Oswald (nom de la boutique).

## Ce qui n’est pas encore en place

- **Les stocks et les commandes** : pas encore gérés.

## Pour les développeurs

```bash
npm install
ADMIN_PASSWORD=test node server.js
```

Sans `DATABASE_URL`, les données sont enregistrées dans le dossier `data/`. Avec `DATABASE_URL`, elles vont dans PostgreSQL. La variable `SESSION_SECRET` est facultative.
