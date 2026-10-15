// The shared game data. Two back ends with the same small interface:
//   firebase: Firebase Realtime Database, for real games across phones.
//   local:    localStorage + BroadcastChannel, for trying the app in several tabs of one browser.
//
// Interface:
//   watch(path, cb) -> unsubscribe     cb(value or null) now and on every change
//   get(path) -> value
//   update(path, patch)                patch keys may be deep ("players/abc/score"); null deletes
//   transaction(path, fn)              fn(current) returns the new value, or undefined to leave it
//   SERVER_TIME                        placeholder written as the server's clock
//   clockOffset(path) -> { offset, rtt }   server time = Date.now() + offset
//   presence(path)                     path is true while this tab is connected, false after
import { firebaseConfig } from './config.js';

const FIREBASE = 'https://www.gstatic.com/firebasejs/10.12.2';

export async function openStore() {
  if (firebaseConfig.apiKey && firebaseConfig.apiKey !== 'REPLACE_ME') return firebaseStore();
  return localStore();
}

async function firebaseStore() {
  const { initializeApp } = await import(`${FIREBASE}/firebase-app.js`);
  const fb = await import(`${FIREBASE}/firebase-database.js`);
  const db = fb.getDatabase(initializeApp(firebaseConfig));
  const r = (path) => fb.ref(db, path);
  return {
    mode: 'firebase',
    SERVER_TIME: fb.serverTimestamp(),
    watch(path, cb) {
      return fb.onValue(r(path), (snap) => cb(snap.val()));
    },
    async get(path) {
      return (await fb.get(r(path))).val();
    },
    update(path, patch) {
      return fb.update(r(path), patch);
    },
    async transaction(path, fn) {
      const res = await fb.runTransaction(r(path), fn, { applyLocally: false });
      return { committed: res.committed, value: res.snapshot.val() };
    },
    // NTP-style: write the server's clock, time the round trip, keep the fastest sample.
    // The server stamped the value somewhere inside the round trip, most likely in the middle.
    async clockOffset(path) {
      let best = null;
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        await fb.set(r(path), fb.serverTimestamp());
        const t1 = Date.now();
        const server = (await fb.get(r(path))).val();
        const sample = { offset: server - (t0 + t1) / 2, rtt: t1 - t0 };
        if (typeof server === 'number' && (!best || sample.rtt < best.rtt)) best = sample;
      }
      return best || { offset: 0, rtt: 0 };
    },
    presence(path) {
      const off = fb.onValue(r('.info/connected'), (snap) => {
        if (!snap.val()) return;
        fb.onDisconnect(r(path)).set(false).then(() => fb.set(r(path), true));
      });
      return () => {
        off();
        fb.onDisconnect(r(path)).cancel();
        fb.set(r(path), false);
      };
    },
  };
}

// ---- Local demo mode -------------------------------------------------------------------

const KEY = 'buzzer-local-db';
const SV = { '.sv': 'timestamp' };

function localStore() {
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('buzzer-local') : null;
  const listeners = new Set();
  const load = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  };
  const save = (tree) => {
    localStorage.setItem(KEY, JSON.stringify(tree));
    if (channel) channel.postMessage('changed');
    notify();
  };
  const notify = () => listeners.forEach((l) => l());
  if (channel) channel.onmessage = notify;
  window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });

  const parts = (path) => path.split('/').filter(Boolean);
  const read = (tree, path) => parts(path).reduce((node, k) => (node && typeof node === 'object' ? node[k] : undefined), tree) ?? null;
  const resolve = (v) => {
    if (v && typeof v === 'object') {
      if (v['.sv'] === 'timestamp') return Date.now();
      const out = {};
      for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) out[k] = resolve(x);
      return Object.keys(out).length ? out : null;
    }
    return v;
  };
  const write = (tree, path, value) => {
    const ks = parts(path);
    if (!ks.length) return resolve(value) || {};
    let node = tree;
    for (const k of ks.slice(0, -1)) {
      if (!node[k] || typeof node[k] !== 'object') node[k] = {};
      node = node[k];
    }
    const v = resolve(value);
    if (v === null || v === undefined) delete node[ks[ks.length - 1]];
    else node[ks[ks.length - 1]] = v;
    return tree;
  };

  return {
    mode: 'local',
    SERVER_TIME: SV,
    watch(path, cb) {
      let last;
      const check = () => {
        const v = read(load(), path);
        const s = JSON.stringify(v);
        if (s !== last) { last = s; cb(v === null ? null : JSON.parse(s)); }
      };
      listeners.add(check);
      setTimeout(check, 0);
      return () => listeners.delete(check);
    },
    async get(path) {
      return read(load(), path);
    },
    async update(path, patch) {
      let tree = load();
      for (const [k, v] of Object.entries(patch)) tree = write(tree, `${path}/${k}`, v);
      save(tree);
    },
    async transaction(path, fn) {
      const tree = load();
      const next = fn(read(tree, path));
      if (next === undefined) return { committed: false, value: read(tree, path) };
      save(write(tree, path, next));
      return { committed: true, value: read(load(), path) };
    },
    async clockOffset() {
      return { offset: 0, rtt: 0 };
    },
    presence(path) {
      const away = () => this.update('/', { [path]: false });
      this.update('/', { [path]: true });
      window.addEventListener('pagehide', away);
      return () => {
        window.removeEventListener('pagehide', away);
        away();
      };
    },
  };
}
