// The rule for who buzzed first, run inside the database transaction on games/<CODE>/buzz.
// b: the current buzz state; round: the round the player pressed in; t: press time in server
// time. Returns the new buzz state, or undefined to leave it as it is.
// A press that arrives after another but was made earlier (a slower connection) still wins.
export function addPress(b, round, id, t) {
  if (!b || b.round !== round || !b.live) return undefined; // reset or locked meanwhile
  const presses = { ...(b.presses || {}) };
  if (presses[id] !== undefined) return undefined;
  presses[id] = t;
  const [first, firstT] = Object.entries(presses).sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1))[0];
  return { ...b, presses, winner: { id: first, t: firstT } };
}
