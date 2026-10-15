# Setup: playing across phones

Two things, both free: a Firebase Realtime Database (the live game data) and a public web
address (GitHub Pages). Do them once.

## 1. Firebase

1. Go to `https://console.firebase.google.com` → **Create a project** → name it `buzzer`.
   Google Analytics is not needed.
2. **Build → Realtime Database → Create database.** Pick the location closest to the
   players (for Israel: `europe-west1`). Start in **locked mode**.
3. On the database's **Rules** tab, delete everything, paste the whole of
   [database.rules.json](../database.rules.json), and **Publish**.
4. **Project settings** (gear icon) → **Your apps** → the web icon `</>` → name it `buzzer`
   → **Register app** (no Firebase Hosting). It shows a `firebaseConfig` block.
5. Copy `apiKey`, `authDomain`, `databaseURL`, `projectId` and `appId` from it into
   [js/config.js](../js/config.js). If `databaseURL` is missing there, copy it from the top
   of the Realtime Database page (it looks like
   `https://buzzer-xxxxx-default-rtdb.europe-west1.firebasedatabase.app`).

These values are not secret: every web app that uses Firebase puts them in its page.

## 2. Publish (GitHub Pages)

1. Push this repository to GitHub.
2. Repository **Settings → Pages → Source: Deploy from a branch → `main`, `/ (root)`** → Save.
3. After a minute the app is at `https://<your user>.github.io/Buzzer/`.

## 3. Put it on the home screen

- **iPhone (Safari):** open the address → Share button → **Add to Home Screen**.
- **Android (Chrome):** open the address → ⋮ menu → **Add to Home screen** / **Install app**.

Players do not need to install anything: scanning the host's QR code opens the game in the
phone's browser.

## Notes

- Games are open to anyone who knows the 4-letter code. That suits a party game; it is not
  meant to keep secrets.
- Old games stay in the database. On the free plan that is fine for a very long time; to
  clean up, delete the `games` and `clock` entries in the Realtime Database page.
