# Buzzer

A party game buzzer that runs in the phone browser and can be added to the home screen
(iPhone and Android). One person hosts; everyone else joins by scanning a QR code.

- **Host (master):** opens a game, shows the QR code, starts the game, resets the buzzers,
  gives and takes points, edits any player's name, color or score, removes players, ends the game.
- **Players:** scan, type a name, pick a color, and get a big buzzer in their color.
- When the buzzer is live, the first press locks everyone's buzzer, and every screen shows
  who was first (and how far behind the others were). Scores sit at the top of every screen.
- **Closed the browser by mistake?** Scan the QR code again and tap your name under
  "Coming back?". Same phone and browser: you come back on your own.

## How first press is decided

Every phone matches its clock to the server's when it joins, and again every 45 seconds.
A press is stamped with server time at the moment the finger touches the screen. The
earliest stamp wins, even if a slower connection delivers it a little later. Details:
[docs/how-it-works.md](docs/how-it-works.md).

## Run it

No build step and no Node: it is plain HTML, CSS and JavaScript modules.

- **Try it on this computer:** `python -m http.server 8765`, then open
  `http://127.0.0.1:8765/`. Until Firebase is set up the app runs in **demo mode**: open
  more tabs to play as several players.
- **Play on phones:** set up Firebase and publish the site: [docs/setup.md](docs/setup.md).
- **Tests:** open `http://127.0.0.1:8765/tests/`. The page title turns `PASS` or `FAIL n`.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | The page and its look |
| `js/app.js` | Screens and actions for host and players |
| `js/buzz.js` | The rule for who buzzed first |
| `js/store.js` | Shared data: Firebase Realtime Database, or local demo mode |
| `js/config.js` | Firebase settings (fill in for real games) |
| `database.rules.json` | Rules to paste into the Firebase console |
| `manifest.webmanifest`, `sw.js`, `icons/` | What makes it installable as a phone app |
