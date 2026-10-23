'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/game');

function setup() {
  const { room, player: host } = G.createRoom('ABCDE', 'P1');
  for (let i = 2; i <= 6; i++) G.addPlayer(room, 'P' + i);
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  G.applyAction(room, host, { type: 'start' });
  room.players.forEach(p => G.applyAction(room, p, { type: 'ack' }));
  return room;
}
const P = (room, id) => room.players.find(p => p.id === id);
const roleOf = (room, id) => room.game.roles[id];
const byRole = (room, r) => room.game.seats.filter(id => roleOf(room, id) === r);
const leader = room => P(room, room.game.seats[room.game.leaderIdx]);
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);

function propose(room, team) {
  G.applyAction(room, leader(room), { type: 'propose', team });
}
function voteAll(room, approvals) {
  room.game.seats.forEach((id, i) => G.applyAction(room, P(room, id), { type: 'vote', approve: i < approvals }));
}
function goodTeam(room) {
  const good = room.game.seats.filter(id => G.ROLES[roleOf(room, id)].team === 'good');
  return good.slice(0, G.MISSION_SIZES[room.game.round]);
}
function runMission(room, failIt) {
  const size = G.MISSION_SIZES[room.game.round];
  const evil = byRole(room, 'assassin')[0];
  const team = failIt ? [evil, ...goodTeam(room)].slice(0, size) : goodTeam(room);
  propose(room, team);
  voteAll(room, 6);
  for (const id of team) G.applyAction(room, P(room, id), { type: 'mission', card: failIt && id === evil ? 'fail' : 'success' });
}

test('A: room capacity, late join and duplicate names', () => {
  const { room } = G.createRoom('ABCDE', 'Alice');
  throwsCode(() => G.addPlayer(room, 'alice'), 'name_taken');
  for (let i = 2; i <= 6; i++) G.addPlayer(room, 'P' + i);
  throwsCode(() => G.addPlayer(room, 'Seventh'), 'full');
  const r2 = setup();
  r2.players.pop();
  throwsCode(() => G.addPlayer(r2, 'Late'), 'started');
});

test('A: start requires 6 ready players and the host', () => {
  const { room, player: host } = G.createRoom('ABCDE', 'H');
  throwsCode(() => G.applyAction(room, host, { type: 'start' }), 'not_full');
  for (let i = 2; i <= 6; i++) G.addPlayer(room, 'P' + i);
  throwsCode(() => G.applyAction(room, host, { type: 'start' }), 'not_ready');
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  throwsCode(() => G.applyAction(room, room.players[1], { type: 'start' }), 'forbidden');
  G.applyAction(room, host, { type: 'start' });
  assert.strictEqual(room.status, 'playing');
});

test('A: exactly the fixed role deck is dealt, randomly', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const room = setup();
    const roles = Object.values(room.game.roles).sort();
    assert.deepStrictEqual(roles, [...G.ROLE_DECK].sort());
    seen.add(room.game.seats.map(id => roleOf(room, id)).join());
  }
  assert.ok(seen.size > 10, 'role assignment should vary between games');
});

test('A: secret knowledge per role', () => {
  const room = setup();
  const evil = [...byRole(room, 'assassin'), ...byRole(room, 'minion')].sort();
  for (const id of room.game.seats) {
    const v = G.viewFor(room, P(room, id));
    const known = v.secret.knows.map(k => k.id).sort();
    const role = roleOf(room, id);
    if (role === 'merlin') assert.deepStrictEqual(known, evil);
    else if (role === 'servant') assert.deepStrictEqual(known, []);
    else assert.deepStrictEqual(known, evil.filter(x => x !== id));
    // No view ever contains another player's role or any token.
    const json = JSON.stringify(v);
    for (const p of room.players) if (p.id !== id) assert.ok(!json.includes(p.token));
    assert.ok(!('reveal' in v));
    assert.ok(!json.includes('"roles"'));
  }
});

test('B: team size enforced per round and only leader proposes', () => {
  const room = setup();
  const sizes = [];
  for (let r = 0; r < 4; r++) {
    const size = G.MISSION_SIZES[room.game.round];
    sizes.push(size);
    const notLeader = room.players.find(p => p.id !== leader(room).id);
    throwsCode(() => G.applyAction(room, notLeader, { type: 'propose', team: room.game.seats.slice(0, size) }), 'forbidden');
    throwsCode(() => propose(room, room.game.seats.slice(0, size - 1)), 'bad_team');
    throwsCode(() => propose(room, room.game.seats.slice(0, size + 1)), 'bad_team');
    throwsCode(() => propose(room, [room.game.seats[0], room.game.seats[0]]), 'bad_team');
    runMission(room, r % 2 === 1); // S F S F -> keeps game going
  }
  sizes.push(G.MISSION_SIZES[room.game.round]);
  assert.deepStrictEqual(sizes, [2, 3, 4, 3, 4]);
});

test('B: 4 approvals pass, 3 approvals reject and rotate leader', () => {
  const room = setup();
  const l0 = room.game.leaderIdx;
  propose(room, room.game.seats.slice(0, 2));
  voteAll(room, 3);
  assert.strictEqual(room.game.phase, 'team');
  assert.strictEqual(room.game.rejects, 1);
  assert.strictEqual(room.game.leaderIdx, (l0 + 1) % 6);
  propose(room, room.game.seats.slice(0, 2));
  voteAll(room, 4);
  assert.strictEqual(room.game.phase, 'mission');
  assert.strictEqual(room.game.fails, 0, 'rejection does not count as mission failure');
});

test('B: votes stay secret until all six have voted; no double voting', () => {
  const room = setup();
  propose(room, room.game.seats.slice(0, 2));
  const [a, b] = room.game.seats;
  G.applyAction(room, P(room, a), { type: 'vote', approve: false });
  throwsCode(() => G.applyAction(room, P(room, a), { type: 'vote', approve: true }), 'duplicate');
  const vb = G.viewFor(room, P(room, b));
  assert.deepStrictEqual(vb.votedIds, [a]);
  assert.ok(!('myVote' in vb));
  assert.ok(!JSON.stringify(vb).includes('"votes"'));
  assert.strictEqual(G.viewFor(room, P(room, a)).myVote, false);
});

test('B: five consecutive rejections give evil the win', () => {
  const room = setup();
  for (let i = 0; i < 5; i++) { propose(room, room.game.seats.slice(0, 2)); voteAll(room, 0); }
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.game.winner, 'evil');
  throwsCode(() => propose(room, room.game.seats.slice(0, 2)), 'bad_phase');
});

test('C: mission card rules', () => {
  const room = setup();
  const merlin = byRole(room, 'merlin')[0];
  const minion = byRole(room, 'minion')[0];
  const outsider = room.game.seats.find(id => id !== merlin && id !== minion);
  propose(room, [merlin, minion]);
  voteAll(room, 6);
  throwsCode(() => G.applyAction(room, P(room, merlin), { type: 'mission', card: 'fail' }), 'forbidden');
  throwsCode(() => G.applyAction(room, P(room, outsider), { type: 'mission', card: 'success' }), 'forbidden');
  G.applyAction(room, P(room, minion), { type: 'mission', card: 'fail' });
  throwsCode(() => G.applyAction(room, P(room, minion), { type: 'mission', card: 'success' }), 'duplicate');
  // Not resolved yet: nothing about the cards is public.
  const v = G.viewFor(room, P(room, outsider));
  assert.strictEqual(v.submittedCount, 1);
  assert.strictEqual(v.history[0].result, null);
  assert.ok(!JSON.stringify(v).includes('"fail"'));
  G.applyAction(room, P(room, merlin), { type: 'mission', card: 'success' });
  const res = room.game.history[0].result;
  assert.deepStrictEqual([res.successCards, res.failCards, res.success], [1, 1, false]);
  assert.strictEqual(room.game.fails, 1);
  assert.strictEqual(room.game.round, 1);
});

test('C: three failures end the game for evil without assassination', () => {
  const room = setup();
  runMission(room, true); runMission(room, true); runMission(room, true);
  assert.strictEqual(room.game.phase, 'ended');
  assert.strictEqual(room.game.winner, 'evil');
  assert.strictEqual(room.game.assassination, null);
});

test('D: three successes lead to assassination; hitting Merlin wins for evil', () => {
  const room = setup();
  runMission(room, false); runMission(room, false); runMission(room, false);
  assert.strictEqual(room.game.phase, 'assassin');
  const assassin = P(room, byRole(room, 'assassin')[0]);
  const minion = P(room, byRole(room, 'minion')[0]);
  const merlin = byRole(room, 'merlin')[0];
  throwsCode(() => G.applyAction(room, minion, { type: 'assassinate', target: merlin }), 'forbidden');
  throwsCode(() => G.applyAction(room, assassin, { type: 'assassinate', target: assassin.id }), 'bad_target');
  throwsCode(() => G.applyAction(room, assassin, { type: 'assassinate', target: 'nobody' }), 'bad_target');
  G.applyAction(room, assassin, { type: 'assassinate', target: merlin });
  assert.strictEqual(room.game.winner, 'evil');
  throwsCode(() => G.applyAction(room, assassin, { type: 'assassinate', target: byRole(room, 'servant')[0] }), 'bad_phase');
  // Roles are revealed only now.
  const v = G.viewFor(room, P(room, byRole(room, 'servant')[0]));
  assert.strictEqual(v.reveal.length, 6);
});

test('D: missing Merlin gives good the win', () => {
  const room = setup();
  runMission(room, false); runMission(room, true); runMission(room, false); runMission(room, false);
  const assassin = P(room, byRole(room, 'assassin')[0]);
  G.applyAction(room, assassin, { type: 'assassinate', target: byRole(room, 'servant')[0] });
  assert.strictEqual(room.game.winner, 'good');
  assert.strictEqual(room.game.assassination.hit, false);
});

test('restart resets data and re-deals roles; only after end', () => {
  const room = setup();
  const host = P(room, room.hostId);
  throwsCode(() => G.applyAction(room, host, { type: 'restart' }), 'bad_phase');
  runMission(room, true); runMission(room, true); runMission(room, true);
  G.applyAction(room, host, { type: 'restart' });
  assert.strictEqual(room.status, 'lobby');
  assert.strictEqual(room.game, null);
  assert.ok(room.players.every(p => !p.ready));
  assert.ok(!('secret' in G.viewFor(room, host)));
});

test('reveal phase: every player must confirm once', () => {
  const { room, player: host } = G.createRoom('ABCDE', 'H');
  for (let i = 2; i <= 6; i++) G.addPlayer(room, 'P' + i);
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  G.applyAction(room, host, { type: 'start' });
  throwsCode(() => G.applyAction(room, host, { type: 'propose', team: [] }), 'bad_phase');
  G.applyAction(room, host, { type: 'ack' });
  throwsCode(() => G.applyAction(room, host, { type: 'ack' }), 'duplicate');
  room.players.slice(1).forEach(p => G.applyAction(room, p, { type: 'ack' }));
  assert.strictEqual(room.game.phase, 'team');
});
