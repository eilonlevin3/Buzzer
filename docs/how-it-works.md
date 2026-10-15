# How it works

## Data

All live data sits in the Firebase Realtime Database:

```
games/<CODE>/
  status     'lobby' | 'playing' | 'ended'
  buzz       { round, live, presses: { playerId: pressTime }, winner: { id, t } }
  players    { playerId: { name, color, score, joinedAt } }
  online     { host: true/false, playerId: true/false }
clock/<CODE>/<playerId>   used to match each phone's clock to the server's
```

Every screen listens to `games/<CODE>` and redraws when it changes, so the result and the
scores reach everyone at once.

## Who pressed first

Sorting presses by the time they *reach* the server is unfair: a phone on a slow
connection loses even when its player was faster. Instead:

1. **Clock matching.** When a player joins (and every 45 s, and when the app comes back to
   the screen), the phone writes the server's time to `clock/...` five times. For each
   try it notes when it sent and when the server confirmed. The server stamped the value
   somewhere in between, most likely in the middle, so
   `offset = serverTime − (sent + confirmed) / 2`. The try with the shortest round trip
   is the most exact and is kept. The error is at most half that round trip, usually a
   few milliseconds on Wi-Fi. A player's screen shows it as `clock ±N ms`.
2. **Stamping the press.** The buzzer reacts when the finger touches the screen (not when
   it lifts), and uses the touch event's own time, so a busy phone does not add delay.
   The press time is `touch time + offset`, in server time.
3. **Deciding.** Each press is added to `buzz` in one database transaction
   ([js/buzz.js](../js/buzz.js)). The transaction records the press and names as winner
   whoever has the earliest time so far. A press made earlier but delivered later
   replaces the winner. Presses from an old round or after the host locked the buzzers
   are ignored.
4. **Showing it.** All buzzers lock as soon as any press is in. The winner's name shows
   300 ms later, so an earlier press still on its way can take the win before anyone
   sees a name. The other presses are listed with how far behind they were.

## Coming back

Each browser keeps a list of the games it hosts or plays in (`localStorage`), so reopening
the link brings the host or player back as themselves. In a new browser, the join screen
lists the players under "Coming back? Tap your name".

In demo mode (no Firebase settings) the data lives in `localStorage` and each *tab* is a
separate person, so one computer can play every part.
