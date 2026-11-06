# Quorum

Quiz collaboratif : chaque élève vote depuis son appareil, et la classe donne une seule réponse selon le mode choisi.

## Pages
- `/host` : écran prof (à projeter). Choix du mode, du niveau, des catégories, du nombre de questions, de la durée du vote (15 s à 5 min) et de la durée du débat (30 s à 5 min).
- `/` : page élève. Code de la partie + pseudo (ou scan du QR code affiché au tableau).

## Les 8 modes
- **Majorité** : vote secret, la réponse la plus votée l'emporte.
- **Deux tours** : vote secret, répartition affichée, débat (durée réglable), revote.
- **Capitaine** : tout le monde vote, puis un capitaine tiré au sort (chacun son tour) voit les votes et tranche seul en 20 s.
- **Consensus** : votes visibles et modifiables ; la réponse passe dès que 70 % sont d'accord. Sinon −1 point.
- **Vote en direct** : votes visibles en temps réel, modifiables jusqu'à la fin du chrono.
- **Mise de confiance** : vote + mise de 1 à 3 ; les votes sont pondérés par la mise.
- **Réputation** : chaque bonne réponse donne +1 de poids au vote de l'élève pour la suite.
- **Imposteur** : 1 imposteur secret (2 dès 15 joueurs) voit la bonne réponse et veut faire perdre la classe. Fonctionne en deux tours, puis vote final pour le démasquer.

Égalité : tirage au sort parmi les réponses à égalité. Le prof peut clore un vote, sauter le débat ou forcer la majorité à tout moment.

## Questions
540 questions dans `questions.json`, chacune avec une explication affichée après la réponse, sur 3 niveaux (collège, lycée, adultes) et 13 thèmes : Philosophie, Langues & mots, Civilisations, Histoire, Planète & pays, Espace & Univers, Nature & animaux, Corps & cerveau, Sciences & inventions, Livres & arts, Monde d'aujourd'hui, Sport & jeux, Maths & énigmes.

Format d'une question :
```json
{"lvl":"college","cat":"Histoire","q":"Quelle bataille a eu lieu en 1515 ?","choices":["Marignan","Waterloo","Austerlitz","Verdun"],"a":0,"ex":"En 1515, François Ier remporte la bataille de Marignan en Italie."}
```
- `lvl` : `college`, `lycee` ou `adultes`
- `a` : index de la bonne réponse (0 = première). Les réponses sont mélangées automatiquement à l'affichage.
- `ex` : l'explication montrée sur le tableau et les téléphones une fois la réponse révélée.
- Une nouvelle catégorie (`cat`) apparaît toute seule dans les réglages.

## Lancer en local
```
npm install
npm start
```
Puis http://localhost:3000/host

## Déployer sur Render
1. Pousser le dossier sur un repo GitHub.
2. Render → New → Web Service → choisir le repo.
3. Build command : `npm install` — Start command : `npm start`.
4. (Optionnel) Sous-domaine : dans Render, Settings → Custom Domain (ex. `quiz.ayoubgames.com`), puis ajouter le CNAME indiqué dans Cloudflare.

Sur l'offre gratuite, le serveur s'endort après 15 min sans visite et met ~50 s à se réveiller : ouvrir `/host` avant le cours.
