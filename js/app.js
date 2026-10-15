// Buzzer: one host ("master") runs a game, players join from their phones and race to buzz.
//
// Shared data, under games/<CODE> (see docs/how-it-works.md):
//   status   'lobby' | 'playing' | 'ended'
//   buzz     { round, live, presses: { playerId: serverTime }, winner: { id, t } }
//   players  { playerId: { name, color, score, joinedAt } }
//   online   { host: bool, playerId: bool }
// Each player's clock is matched to the server's, so a press is stamped in server time the
// moment the finger lands. The earliest stamp wins, even if it reaches the server later.
import { openStore } from './store.js';
import { addPress } from './buzz.js';

const COLORS = [
  ['#e53935', 'Red'], ['#1e88e5', 'Blue'], ['#43a047', 'Green'], ['#fdd835', 'Yellow'],
  ['#8e24aa', 'Purple'], ['#fb8c00', 'Orange'], ['#00acc1', 'Teal'], ['#d81b60', 'Pink'],
  ['#6d4c41', 'Brown'], ['#3949ab', 'Indigo'], ['#7cb342', 'Lime'], ['#78909c', 'Slate'],
];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const SETTLE_MS = 300; // wait this long for a slower but earlier press before naming the winner
const RESYNC_MS = 45000;
const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

const $view = document.getElementById('view');
const $bar = document.getElementById('scorebar');
const $overlay = document.getElementById('overlay');

const S = {
  store: null,
  code: null,
  game: undefined, // undefined: loading, null: no such game
  role: null, // 'master' | 'player' | null (choosing how to join)
  me: null,
  offset: 0,
  rtt: null,
  unwatch: null,
  unpresence: null,
  ui: {},
};

// ---- Small helpers ------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const randomId = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
const colorName = (hex) => (COLORS.find(([c]) => c === hex) || [, 'Color'])[1];
// Dark text on light colors, white on the rest.
const ink = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return l > 165 ? '#1a1a1a' : '#fff';
};
const path = (rest = '') => `games/${S.code}${rest ? `/${rest}` : ''}`;

const players = (g) => Object.entries(g?.players || {})
  .filter(([, p]) => p && p.name)
  .map(([id, p]) => ({ id, ...p, score: p.score || 0 }));
const byScore = (list) => [...list].sort((a, b) => b.score - a.score || (a.joinedAt || 0) - (b.joinedAt || 0));
const isOnline = (g, id) => g?.online?.[id] !== false;

// Games this browser hosts or plays in, so a closed tab can come back as the same person.
// In demo mode each tab is a different person, so it is kept per tab.
const mine = {
  storage: () => (S.store?.mode === 'local' ? sessionStorage : localStorage),
  all() {
    try { return JSON.parse(this.storage().getItem('buzzer:mine')) || {}; } catch { return {}; }
  },
  get(code) { return this.all()[code]; },
  set(code, value) {
    const all = this.all();
    if (value) all[code] = { ...value, at: Date.now() }; else delete all[code];
    try { this.storage().setItem('buzzer:mine', JSON.stringify(all)); } catch { /* private mode */ }
  },
};

// ---- Entering and leaving a game ----------------------------------------------------------

function codeFromUrl() {
  const g = new URLSearchParams(location.search).get('g');
  return g && /^[A-Za-z]{4}$/.test(g) ? g.toUpperCase() : null;
}

function go(code) {
  history.replaceState(null, '', code ? `?g=${code}` : location.pathname);
  enter(code);
}

function leave() {
  if (S.unwatch) S.unwatch();
  if (S.unpresence) S.unpresence();
  S.unwatch = S.unpresence = null;
  clearTimeout(S.ui.settle);
  S.ui = {};
  S.role = S.me = null;
  S.game = undefined;
  closeOverlay();
}

function enter(code) {
  leave();
  S.code = code;
  if (code) {
    const m = mine.get(code);
    if (m?.role === 'master') becomeMaster();
    else if (m?.role === 'player') S.ui.claimId = m.id; // confirmed once the game data arrives
    S.unwatch = S.store.watch(path(), onGame);
  }
  render();
}

function onGame(g) {
  S.game = g;
  const list = players(g);
  if (g && S.ui.claimId && S.role !== 'player') {
    const id = S.ui.claimId;
    S.ui.claimId = null;
    if (list.some((p) => p.id === id)) becomePlayer(id);
    else mine.set(S.code, null);
  }
  if (g && S.role === 'player') {
    const here = list.some((p) => p.id === S.me);
    if (here) S.ui.seenMe = true;
    else if (S.ui.seenMe) {
      // The host removed this player.
      if (S.unpresence) S.unpresence();
      S.unpresence = null;
      mine.set(S.code, null);
      S.role = S.me = null;
      S.ui.seenMe = false;
      S.ui.note = 'The host removed you from the game. You can join again.';
    }
  }
  settleWinner(g);
  render();
}

function becomeMaster() {
  S.role = 'master';
  mine.set(S.code, { role: 'master' });
  S.unpresence = S.store.presence(path('online/host'));
  keepAwake();
}

function becomePlayer(id) {
  S.role = 'player';
  S.me = id;
  mine.set(S.code, { role: 'player', id });
  S.unpresence = S.store.presence(path(`online/${id}`));
  keepAwake();
  syncClock();
}

async function syncClock() {
  if (S.role !== 'player' || !S.code) return;
  try {
    const { offset, rtt } = await S.store.clockOffset(`clock/${S.code}/${S.me}`);
    S.offset = offset;
    S.rtt = rtt;
    render();
  } catch { /* keep the last offset */ }
}

// A winner is shown once it has stood for SETTLE_MS: a press made earlier on a slower
// connection can still arrive and take the win in that time.
function settleWinner(g) {
  const b = g?.buzz;
  const w = b?.winner;
  const key = w ? `${b.round}:${w.id}:${w.t}` : null;
  if (key === S.ui.winnerKey) return;
  S.ui.winnerKey = key;
  S.ui.winnerShown = false;
  clearTimeout(S.ui.settle);
  if (!key) return;
  S.ui.settle = setTimeout(() => {
    S.ui.winnerShown = true;
    if (S.ui.beepedRound !== b.round) {
      S.ui.beepedRound = b.round;
      beep();
    }
    render();
  }, SETTLE_MS);
}

// ---- Actions ------------------------------------------------------------------------------

async function createGame() {
  let code;
  for (let i = 0; i < 20; i++) {
    code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!(await S.store.get(`games/${code}/status`))) break;
  }
  await S.store.update(`games/${code}`, {
    createdAt: S.store.SERVER_TIME,
    status: 'lobby',
    buzz: { round: 0, live: false },
  });
  mine.set(code, { role: 'master' });
  go(code);
}

async function joinGame() {
  const g = S.game;
  const name = document.getElementById('name-in').value.trim().replace(/\s+/g, ' ').slice(0, 16);
  if (!name) return fail('Type your name first.');
  const list = players(g);
  if (list.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return fail('That name is taken. If it is you, tap it under "Coming back?".');
  }
  const taken = new Set(list.map((p) => p.color));
  const color = S.ui.joinColor && !taken.has(S.ui.joinColor) ? S.ui.joinColor : (COLORS.find(([c]) => !taken.has(c)) || COLORS[list.length % COLORS.length])[0];
  const id = randomId();
  S.ui.error = '';
  await S.store.update(path(), { [`players/${id}`]: { name, color, score: 0, joinedAt: S.store.SERVER_TIME } });
  becomePlayer(id);
  render();
}

function fail(message) {
  S.ui.error = message;
  render();
}

function claim(id) {
  S.ui.note = '';
  becomePlayer(id);
  render();
}

async function buzz(event) {
  const g = S.game;
  if (!canBuzz(g)) return;
  // Stamp the moment the finger landed, in the server's time.
  const handlerLag = event?.timeStamp ? Math.max(0, Math.min(500, performance.now() - event.timeStamp)) : 0;
  const t = Math.round(Date.now() - handlerLag + S.offset);
  const round = g.buzz.round;
  const me = S.me;
  S.ui.pressedRound = round;
  if (navigator.vibrate) navigator.vibrate(60);
  render();
  try {
    await S.store.transaction(path('buzz'), (b) => addPress(b, round, me, t));
  } catch (e) {
    console.error('Buzz failed', e);
  }
}

function canBuzz(g) {
  const b = g?.buzz;
  return !!(S.role === 'player' && g.status === 'playing' && b?.live && !b.winner
    && b.presses?.[S.me] === undefined && S.ui.pressedRound !== b.round
    && players(g).some((p) => p.id === S.me));
}

const openBuzzer = (round) => S.store.update(path(), { buzz: { round, live: true, presses: null, winner: null } });

function addPoints(id, d) {
  return S.store.transaction(path(`players/${id}/score`), (s) => (s || 0) + d);
}

// Dangerous buttons need a second tap within 3 seconds.
function armed(key) {
  if (S.ui.armed === key) {
    S.ui.armed = null;
    return true;
  }
  S.ui.armed = key;
  clearTimeout(S.ui.armTimer);
  S.ui.armTimer = setTimeout(() => { S.ui.armed = null; render(); }, 3000);
  render();
  return false;
}

const actions = {
  host: () => createGame(),
  'join-code': () => {
    const code = document.getElementById('code-in').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) return fail('A game code is 4 letters.');
    S.ui.error = '';
    go(code);
  },
  open: (el) => go(el.dataset.code),
  forget: (el) => { mine.set(el.dataset.code, null); render(); },
  home: () => go(null),
  'pick-color': (el) => { S.ui.joinColor = el.dataset.color; render(); },
  join: () => joinGame(),
  claim: (el) => claim(el.dataset.id),
  'not-me': () => {
    if (S.unpresence) S.unpresence();
    S.unpresence = null;
    mine.set(S.code, null);
    S.role = S.me = null;
    S.ui.seenMe = false;
    render();
  },
  qr: () => showQR(),
  'close-qr': () => closeOverlay(),
  start: () => S.store.update(path(), { status: 'playing', buzz: { round: (S.game.buzz?.round || 0) + 1, live: true } }),
  reset: () => openBuzzer((S.game.buzz?.round || 0) + 1),
  lock: () => S.store.update(path('buzz'), { live: false }),
  end: () => armed('end') && S.store.update(path(), { status: 'ended', 'buzz/live': false }),
  continue: () => S.store.update(path(), { status: 'playing' }),
  edit: (el) => { S.ui.editing = S.ui.editing === el.dataset.id ? null : el.dataset.id; render(); },
  points: (el) => addPoints(el.dataset.id, Number(el.dataset.d)),
  'set-color': (el) => S.store.update(path(`players/${el.dataset.id}`), { color: el.dataset.color }),
  remove: (el) => armed(`remove:${el.dataset.id}`) && S.store.update(path('players'), { [el.dataset.id]: null }),
};

const changes = {
  rename: (el) => {
    const name = el.value.trim().replace(/\s+/g, ' ').slice(0, 16);
    if (name) S.store.update(path(`players/${el.dataset.id}`), { name });
  },
  'set-score': (el) => {
    const n = Math.round(Number(el.value));
    if (Number.isFinite(n)) S.store.update(path(`players/${el.dataset.id}`), { score: n });
  },
};

// ---- Views --------------------------------------------------------------------------------

function render() {
  renderScorebar();
  const g = S.game;
  let html;
  if (!S.code) html = homeView();
  else if (g === undefined) html = '<p class="muted center">Connecting…</p>';
  else if (g === null) html = missingView();
  else if (S.role === 'master') html = masterView(g);
  else if (g.status === 'ended') html = endedView(g);
  else if (S.role === 'player') html = playerView(g);
  else html = joinView(g);
  patch($view, html);
}

function renderScorebar() {
  const g = S.game;
  const list = byScore(players(g));
  const show = !!(S.code && g && list.length && (S.role || g.status === 'ended'));
  $bar.hidden = !show;
  if (!show) return;
  patch($bar, list.map((p) => `
    <span class="chip${p.id === S.me ? ' me' : ''}${isOnline(g, p.id) ? '' : ' away'}" title="${esc(colorName(p.color))}">
      <span class="dot" style="background:${p.color}"></span>${esc(p.name)} <b>${p.score}</b>
    </span>`).join(''));
}

// Replaces an element's content only when it changed, keeping what the user is typing.
function patch(el, html) {
  if (el.__html === html) return;
  const active = document.activeElement;
  const keep = {};
  el.querySelectorAll('input[id]').forEach((i) => { keep[i.id] = i.value; });
  const focusId = active && el.contains(active) && active.id;
  const sel = focusId && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
  el.innerHTML = html;
  el.__html = html;
  el.querySelectorAll('input[id][data-keep]').forEach((i) => { if (keep[i.id] !== undefined) i.value = keep[i.id]; });
  if (focusId) {
    const again = document.getElementById(focusId);
    if (again) {
      again.focus();
      try { if (sel) again.setSelectionRange(sel[0], sel[1]); } catch { /* number inputs */ }
    }
  }
}

function homeView() {
  const games = Object.entries(mine.all()).sort((a, b) => b[1].at - a[1].at).slice(0, 6);
  return `
    <div class="stack">
      <div class="center">
        <div class="logo">Buzz<span>er</span></div>
        <p class="muted">The host opens a game. Players join from their phones. First to buzz wins.</p>
      </div>
      <button class="btn primary big block" data-act="host">Host a new game</button>
      <div class="panel stack">
        <h2>Join a game</h2>
        <input id="code-in" data-keep class="code" type="text" maxlength="4" placeholder="CODE" autocomplete="off" autocapitalize="characters" enterkeyhint="go">
        <button class="btn block" data-act="join-code">Join</button>
        <p class="error">${esc(S.ui.error)}</p>
      </div>
      ${games.length ? `
      <div class="panel">
        <h3>Your games</h3>
        <ul class="list">
          ${games.map(([code, m]) => `
            <li>
              <span class="name"><b>${code}</b> <span class="muted small">${m.role === 'master' ? 'host' : 'player'}</span></span>
              <button class="btn" data-act="open" data-code="${code}">Open</button>
              <button class="btn icon" data-act="forget" data-code="${code}" aria-label="Forget ${code}">✕</button>
            </li>`).join('')}
        </ul>
      </div>` : ''}
      ${S.store.mode === 'local' ? '<p class="banner">Demo mode: games only reach other tabs of this browser. To play across phones, set up Firebase (docs/setup.md).</p>' : ''}
    </div>`;
}

function missingView() {
  return `
    <div class="stack center">
      <h2>No game ${esc(S.code)}</h2>
      <p class="muted">Check the code, or ask the host for the QR code.</p>
      <button class="btn block" data-act="home">Back</button>
    </div>`;
}

function joinView(g) {
  const list = players(g);
  const taken = new Set(list.map((p) => p.color));
  if (!S.ui.joinColor || taken.has(S.ui.joinColor)) S.ui.joinColor = (COLORS.find(([c]) => !taken.has(c)) || COLORS[0])[0];
  return `
    <div class="stack">
      <h1>Join game ${esc(S.code)}</h1>
      ${S.ui.note ? `<p class="banner">${esc(S.ui.note)}</p>` : ''}
      <div class="panel stack">
        <label for="name-in"><h3>Your name</h3></label>
        <input id="name-in" data-keep type="text" maxlength="16" placeholder="Name" autocomplete="nickname" enterkeyhint="done">
        <h3>Your color</h3>
        <div class="swatches">
          ${COLORS.map(([c, n]) => `<button class="swatch${c === S.ui.joinColor ? ' on' : ''}" style="background:${c}" data-act="pick-color" data-color="${c}" aria-label="${n}" ${taken.has(c) ? 'disabled' : ''}></button>`).join('')}
        </div>
        <button class="btn primary big block" data-act="join">Join</button>
        <p class="error">${esc(S.ui.error)}</p>
      </div>
      ${list.length ? `
      <div class="panel">
        <h3>Coming back? Tap your name</h3>
        <ul class="list">
          ${list.map((p) => `
            <li>
              <span class="dot" style="background:${p.color}"></span>
              <span class="name">${esc(p.name)}</span>
              ${isOnline(g, p.id) ? '<span class="tag">connected</span>' : '<span class="tag">away</span>'}
              <button class="btn" data-act="claim" data-id="${p.id}">That's me</button>
            </li>`).join('')}
        </ul>
      </div>` : ''}
    </div>`;
}

function winnerCard(g, forMe) {
  const b = g.buzz || {};
  if (!b.winner) return '';
  if (!S.ui.winnerShown) return '<div class="winner pending"><div class="label">Buzzed!</div><div class="who">…</div></div>';
  const p = players(g).find((x) => x.id === b.winner.id) || { name: 'Someone', color: '#555' };
  const order = Object.entries(b.presses || {}).sort((x, y) => x[1] - y[1]);
  const first = order.length ? order[0][1] : 0;
  const rest = order.slice(1).map(([id, t]) => {
    const q = players(g).find((x) => x.id === id);
    return q ? `<span><span class="dot" style="background:${q.color};display:inline-block;width:10px;height:10px"></span> ${esc(q.name)} +${((t - first) / 1000).toFixed(3)}s</span>` : '';
  }).join('');
  return `
    <div class="winner" style="background:${p.color};color:${ink(p.color)}">
      <div class="label">First to buzz</div>
      <div class="who">${esc(p.name)}</div>
      ${forMe && b.winner.id === S.me ? '<div class="label">That\'s you!</div>' : ''}
    </div>
    ${rest ? `<div class="order">Then: ${rest}</div>` : ''}`;
}

function playerView(g) {
  const me = players(g).find((p) => p.id === S.me);
  if (!me) return '<p class="muted center">Joining…</p>';
  const b = g.buzz || {};
  const can = canBuzz(g);
  const pressed = S.ui.pressedRound === b.round || b.presses?.[S.me] !== undefined;
  let status = '';
  let label = 'WAIT';
  if (g.status === 'lobby') status = 'Waiting for the host to start…';
  else if (can) { status = 'Buzzer is live!'; label = 'BUZZ!'; }
  else if (b.winner) { status = ''; label = 'LOCKED'; }
  else if (pressed) { status = 'Buzzed…'; label = '…'; }
  else status = 'Buzzer is locked. Wait for the host.';
  return `
    <div class="stack">
      ${g.online?.host === false ? '<p class="banner">The host is away. The game goes on when they are back.</p>' : ''}
      ${winnerCard(g, true)}
      <p class="status${can ? ' live' : ''}">${esc(status)}</p>
      <div class="buzz-wrap">
        <button class="buzzer${pressed && !b.winner ? ' pressed' : ''}" style="--c:${me.color}" ${can ? '' : 'disabled'} aria-label="Buzz">${label}</button>
      </div>
      <footer class="meta">
        Game ${esc(S.code)} · you are <b>${esc(me.name)}</b>${S.rtt != null && S.store.mode === 'firebase' ? ` · clock ±${Math.max(1, Math.round(S.rtt / 2))} ms` : ''}<br>
        <button class="btn icon small" data-act="not-me" style="margin-top:8px">Not ${esc(me.name)}?</button>
        <button class="btn icon small" data-act="home" style="margin-top:8px">Leave</button>
      </footer>
    </div>`;
}

function endedView(g) {
  const list = byScore(players(g));
  const top = list.length ? list[0].score : 0;
  const champs = list.filter((p) => p.score === top && list.length);
  return `
    <div class="stack">
      <h1 class="center">Game over</h1>
      ${champs.length ? `
      <div class="winner" style="background:${champs[0].color};color:${ink(champs[0].color)}">
        <div class="label">${champs.length > 1 ? 'Tied for the win' : 'Winner'}</div>
        <div class="who">${champs.map((p) => esc(p.name)).join(' & ')}</div>
        <div class="label">${top} point${top === 1 ? '' : 's'}</div>
      </div>` : ''}
      <div class="panel">
        <ul class="list standings">
          ${list.map((p, i) => `
            <li><span class="rank">${i + 1}</span><span class="dot" style="background:${p.color}"></span><span class="name">${esc(p.name)}</span><b>${p.score}</b></li>`).join('')}
        </ul>
      </div>
      ${S.role === 'master' ? `
        <button class="btn block" data-act="continue">Continue this game</button>
        <button class="btn primary block" data-act="home">New game</button>` : '<button class="btn block" data-act="home">Done</button>'}
    </div>`;
}

function masterView(g) {
  if (g.status === 'ended') return endedView(g);
  const list = byScore(players(g));
  const b = g.buzz || {};
  const winner = b.winner && list.find((p) => p.id === b.winner.id);
  let card;
  if (g.status === 'lobby') card = `<div class="idlecard">${list.length ? `${list.length} player${list.length === 1 ? '' : 's'} in` : 'Waiting for players…'}</div>`;
  else if (b.winner) card = winnerCard(g, false);
  else if (b.live) card = '<div class="livecard">BUZZER LIVE</div>';
  else card = '<div class="idlecard">Buzzer locked</div>';

  const usedColors = (id) => new Set(list.filter((p) => p.id !== id).map((p) => p.color));
  const rows = list.map((p) => `
    <li>
      <span class="dot" style="background:${p.color}"></span>
      <span class="name">${esc(p.name)} ${isOnline(g, p.id) ? '' : '<span class="tag">away</span>'}</span>
      <span class="score-ctl">
        <button class="btn icon" data-act="points" data-id="${p.id}" data-d="-1" aria-label="Minus one">−</button>
        <b>${p.score}</b>
        <button class="btn icon" data-act="points" data-id="${p.id}" data-d="1" aria-label="Plus one">+</button>
      </span>
      <button class="btn icon" data-act="edit" data-id="${p.id}" aria-label="Edit ${esc(p.name)}">${S.ui.editing === p.id ? '✓' : '✎'}</button>
    </li>
    ${S.ui.editing === p.id ? `
    <li class="editor">
      <input id="rename-${p.id}" data-keep type="text" maxlength="16" value="${esc(p.name)}" data-change="rename" data-id="${p.id}" aria-label="Name">
      <div class="swatches">
        ${COLORS.map(([c, n]) => `<button class="swatch${c === p.color ? ' on' : ''}" style="background:${c}" data-act="set-color" data-id="${p.id}" data-color="${c}" aria-label="${n}" ${usedColors(p.id).has(c) ? 'disabled' : ''}></button>`).join('')}
      </div>
      <div class="row">
        <label class="muted" for="score-${p.id}">Score</label>
        <input id="score-${p.id}" data-keep class="grow" type="number" inputmode="numeric" value="${p.score}" data-change="set-score" data-id="${p.id}" style="width:auto">
      </div>
      <button class="btn ${S.ui.armed === `remove:${p.id}` ? 'armed' : 'danger'} block" data-act="remove" data-id="${p.id}">${S.ui.armed === `remove:${p.id}` ? 'Tap again to remove' : `Remove ${esc(p.name)}`}</button>
    </li>` : ''}`).join('');

  return `
    <div class="stack">
      <div class="row">
        <h2 class="grow" style="margin:0">Game <span style="letter-spacing:.12em">${esc(S.code)}</span></h2>
        <button class="btn" data-act="qr">QR code</button>
        <button class="btn icon" data-act="home" aria-label="Home">⌂</button>
      </div>
      ${card}
      ${g.status === 'lobby'
        ? `<p class="muted center">Players scan the QR code (or open this site and type <b>${esc(S.code)}</b>) to join.</p>
           <button class="btn primary big block" data-act="start" ${list.length ? '' : 'disabled'}>Start game</button>`
        : `<button class="btn ${b.live && !b.winner ? '' : 'primary'} big block" data-act="reset">Reset buzzers</button>
           <div class="row">
             ${winner && S.ui.winnerShown ? `<button class="btn live grow" data-act="points" data-id="${winner.id}" data-d="1">+1 to ${esc(winner.name)}</button>
                                            <button class="btn grow" data-act="points" data-id="${winner.id}" data-d="-1">−1</button>` : ''}
             ${b.live && !b.winner ? '<button class="btn grow" data-act="lock">Lock buzzers</button>' : ''}
           </div>`}
      <div class="panel">
        <h3>Players</h3>
        ${list.length ? `<ul class="list">${rows}</ul>` : '<p class="muted">No one yet. Show the QR code.</p>'}
      </div>
      ${g.status === 'playing' ? `<button class="btn ${S.ui.armed === 'end' ? 'armed' : 'danger'} block" data-act="end">${S.ui.armed === 'end' ? 'Tap again to end the game' : 'End game'}</button>` : ''}
      ${S.store.mode === 'local' ? '<p class="banner">Demo mode: open this site in another tab and join with the code.</p>' : ''}
    </div>`;
}

// ---- QR code ------------------------------------------------------------------------------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function showQR() {
  const url = `${location.origin}${location.pathname}?g=${S.code}`;
  let svg = '';
  try {
    await loadScript(QR_LIB);
    const qr = window.qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    svg = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  } catch {
    svg = '<p>Could not draw the QR code. Players can type the code instead.</p>';
  }
  $overlay.innerHTML = `
    <div class="qr-card">
      <p style="margin:0 0 8px;font-weight:700">Scan to join</p>
      ${svg}
      <p class="bigcode">${esc(S.code)}</p>
      <p class="url">${esc(url)}</p>
      <button class="btn block" data-act="close-qr">Close</button>
    </div>`;
  $overlay.hidden = false;
}

function closeOverlay() {
  $overlay.hidden = true;
  $overlay.innerHTML = '';
}

// ---- Sound, screen, events ----------------------------------------------------------------

let audio = null;
function unlockAudio() {
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state !== 'running') audio.resume();
  } catch { /* no sound */ }
}
function beep() {
  if (!audio || audio.state !== 'running') return;
  const o = audio.createOscillator();
  const gain = audio.createGain();
  o.type = 'square';
  o.frequency.value = 880;
  gain.gain.setValueAtTime(0.12, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.35);
  o.connect(gain).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + 0.35);
}

let wake = null;
async function keepAwake() {
  try {
    if (S.code && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch { /* not allowed now */ }
}

function listen() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const act = actions[el.dataset.act];
    if (act) Promise.resolve(act(el)).catch((err) => fail(`Something went wrong: ${err.message}`));
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-change]');
    if (el && changes[el.dataset.change]) changes[el.dataset.change](el);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'code-in') actions['join-code']();
    if (e.target.id === 'name-in') joinGame();
    if (e.target.dataset?.change) e.target.blur();
  });
  // The buzzer reacts on touch-down, not on release, for the fairest time.
  $view.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.buzzer')) {
      e.preventDefault();
      buzz(e);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && S.role === 'player' && e.target === document.body) {
      e.preventDefault();
      buzz(e);
    }
  });
  $view.addEventListener('contextmenu', (e) => { if (e.target.closest('.buzzer')) e.preventDefault(); });
  document.addEventListener('pointerdown', unlockAudio, { capture: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      keepAwake();
      syncClock();
    }
  });
  setInterval(syncClock, RESYNC_MS);
}

async function main() {
  try {
    S.store = await openStore();
  } catch (e) {
    $view.innerHTML = `<p class="error center">Could not connect: ${esc(e.message)}</p>`;
    return;
  }
  listen();
  enter(codeFromUrl());
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

main();
