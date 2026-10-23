'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../src/game');

function lobby(size = 6, preset = 'basic', rejectRule = 'evil_wins') {
  const { room, player: host } = G.createRoom('ABCDE', 'P1', { size, preset, rejectRule });
  for (let i = 2; i <= size; i++) G.addPlayer(room, 'P' + i);
  return { room, host };
}
function setup(size, preset, rejectRule) {
  const { room, host } = lobby(size, preset, rejectRule);
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  G.applyAction(room, host, { type: 'start' });
  room.players.forEach(p => G.applyAction(room, p, { type: 'ack' }));
  return room;
}
const P = (room, id) => room.players.find(p => p.id === id);
const roleOf = (room, id) => room.game.roles[id];
const byRole = (room, r) => room.game.seats.filter(id => roleOf(room, id) === r);
const byTeam = (room, t) => room.game.seats.filter(id => G.ROLES[roleOf(room, id)].team === t);
const leader = room => P(room, room.game.seats[room.game.leaderIdx]);
const curSize = room => room.game.history[room.game.round].size;
const throwsCode = (fn, code) => assert.throws(fn, e => e.code === code);

function propose(room, team) {
  G.applyAction(room, leader(room), { type: 'propose', team });
}
function voteAll(room, approvals) {
  room.game.seats.forEach((id, i) => G.applyAction(room, P(room, id), { type: 'vote', approve: i < approvals }));
}
// Runs one mission; `fails` evil players on the team play a fail card.
function runMission(room, fails = 0) {
  const evil = byTeam(room, 'evil');
  const team = [...evil.slice(0, fails), ...byTeam(room, 'good')].slice(0, curSize(room));
  propose(room, team);
  voteAll(room, room.game.size);
  for (const id of team) G.applyAction(room, P(room, id), { type: 'mission', card: evil.slice(0, fails).includes(id) ? 'fail' : 'success' });
}

test('every preset matches its board: right size and good/evil split', () => {
  for (const [size, presets] of Object.entries(G.PRESETS)) {
    const board = G.BOARDS[size];
    assert.strictEqual(board.missions.length, 5);
    for (const p of presets) {
      assert.strictEqual(p.roles.length, Number(size), `${size}/${p.id}`);
      assert.strictEqual(p.roles.filter(r => G.ROLES[r].team === 'evil').length, board.evil, `${size}/${p.id}`);
      assert.strictEqual(p.roles.filter(r => r === 'merlin').length, 1);
      assert.strictEqual(p.roles.filter(r => r === 'assassin').length, 1);
    }
  }
});

test('A: room capacity follows the configured size; late join and duplicate names rejected', () => {
  const { room: r1 } = G.createRoom('ABCDE', 'Alice', { size: 5 });
  throwsCode(() => G.addPlayer(r1, 'alice'), 'name_taken');
  for (const size of [5, 6, 10]) {
    const { room } = lobby(size);
    throwsCode(() => G.addPlayer(room, 'Extra'), 'full');
  }
  const r2 = setup(6);
  r2.players.pop();
  throwsCode(() => G.addPlayer(r2, 'Late'), 'started');
});

test('A: start requires the full table, all ready, and the host', () => {
  const { room, player: host } = G.createRoom('ABCDE', 'H', { size: 5 });
  throwsCode(() => G.applyAction(room, host, { type: 'start' }), 'not_full');
  for (let i = 2; i <= 5; i++) G.addPlayer(room, 'P' + i);
  throwsCode(() => G.applyAction(room, host, { type: 'start' }), 'not_ready');
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  throwsCode(() => G.applyAction(room, room.players[1], { type: 'start' }), 'forbidden');
  G.applyAction(room, host, { type: 'start' });
  assert.strictEqual(room.status, 'playing');
  assert.strictEqual(room.game.size, 5);
});

test('A: the preset deck is dealt exactly, and randomly', () => {
  for (const [size, presets] of Object.entries(G.PRESETS)) {
    for (const p of presets) {
      const room = setup(Number(size), p.id);
      assert.deepStrictEqual(Object.values(room.game.roles).sort(), [...p.roles].sort());
    }
  }
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const room = setup(6);
    seen.add(room.game.seats.map(id => roleOf(room, id)).join());
  }
  assert.ok(seen.size > 10, 'role assignment should vary between games');
});

test('A: night vision per role (Merlin, Percival, Mordred, Oberon, evil team)', () => {
  for (const [size, preset] of [[5, 'standard'], [6, 'basic'], [7, 'oberon'], [8, 'mordred'], [10, 'standard']]) {
    const room = setup(size, preset);
    const ids = r => byRole(room, r);
    const evil = byTeam(room, 'evil');
    for (const id of room.game.seats) {
      const v = G.viewFor(room, P(room, id));
      const known = v.secret.knows.map(k => k.id).sort();
      const role = roleOf(room, id);
      const ctx = `${size}/${preset}/${role}`;
      if (role === 'merlin') assert.deepStrictEqual(known, evil.filter(x => roleOf(room, x) !== 'mordred').sort(), ctx);
      else if (role === 'percival') assert.deepStrictEqual(known, [...ids('merlin'), ...ids('morgana')].sort(), ctx);
      else if (role === 'servant' || role === 'oberon') assert.deepStrictEqual(known, [], ctx);
      else assert.deepStrictEqual(known, evil.filter(x => x !== id && roleOf(room, x) !== 'oberon').sort(), ctx);
      const json = JSON.stringify(v);
      for (const p of room.players) if (p.id !== id) assert.ok(!json.includes(p.token));
      assert.ok(!('reveal' in v));
      assert.ok(!json.includes('"roles":{'), 'full role table never leaves the server');
    }
  }
});

test('B: team size enforced per round for every player count; only leader proposes', () => {
  for (const size of [5, 6, 7, 8, 9, 10]) {
    const room = setup(size);
    const sizes = [];
    for (let r = 0; r < 4; r++) {
      const n = curSize(room);
      sizes.push(n);
      const notLeader = room.players.find(p => p.id !== leader(room).id);
      throwsCode(() => G.applyAction(room, notLeader, { type: 'propose', team: room.game.seats.slice(0, n) }), 'forbidden');
      throwsCode(() => propose(room, room.game.seats.slice(0, n - 1)), 'bad_team');
      throwsCode(() => propose(room, room.game.seats.slice(0, n + 1)), 'bad_team');
      throwsCode(() => propose(room, [room.game.seats[0], room.game.seats[0]]), 'bad_team');
      // S F S F keeps the game going; round 4 with 7+ players needs two fails.
      runMission(room, r % 2 === 1 ? room.game.history[room.game.round].failsNeeded : 0);
    }
    sizes.push(curSize(room));
    assert.deepStrictEqual(sizes, G.BOARDS[size].missions, `size ${size}`);
  }
});

test('B: a strict majority is needed to approve (6p: 4 of 6, 5p: 3 of 5)', () => {
  const room = setup(6);
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

  const r5 = setup(5);
  propose(r5, r5.game.seats.slice(0, 2));
  voteAll(r5, 2);
  assert.strictEqual(r5.game.phase, 'team');
  propose(r5, r5.game.seats.slice(0, 2));
  voteAll(r5, 3);
  assert.strictEqual(r5.game.phase, 'mission');
});

test('B: votes stay secret until everyone has voted; no double voting', () => {
  const room = setup(6);
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

test('B: five consecutive rejections give evil the win (evil_wins rule)', () => {
  const room = setup(6, 'basic', 'evil_wins');
  for (let i = 0; i < 5; i++) { propose(room, room.game.seats.slice(0, 2)); voteAll(room, 0); }
  assert.strictEqual(room.status, 'ended');
  assert.strictEqual(room.game.winner, 'evil');
  throwsCode(() => propose(room, room.game.seats.slice(0, 2)), 'bad_phase');
});

test('B: forced rule: after five rejections the next leader’s team skips the vote', () => {
  const room = setup(7, 'standard', 'forced');
  for (let i = 0; i < 5; i++) { propose(room, room.game.seats.slice(0, 2)); voteAll(room, 0); }
  assert.strictEqual(room.status, 'playing');
  assert.strictEqual(room.game.phase, 'team');
  assert.strictEqual(room.game.forced, true);
  assert.strictEqual(G.viewFor(room, room.players[0]).forced, true);
  const team = room.game.seats.slice(0, 2);
  propose(room, team);
  assert.strictEqual(room.game.phase, 'mission', 'no vote in the forced round');
  const atts = room.game.history[0].attempts;
  assert.strictEqual(atts.length, 6);
  assert.strictEqual(atts[5].forced, true);
  for (const id of team) G.applyAction(room, P(room, id), { type: 'mission', card: 'success' });
  assert.strictEqual(room.game.rejects, 0);
  assert.strictEqual(room.game.forced, false);
  assert.strictEqual(room.game.phase, 'team');
});

test('C: mission card rules', () => {
  const room = setup(6);
  const merlin = byRole(room, 'merlin')[0];
  const minion = byRole(room, 'minion')[0];
  const outsider = room.game.seats.find(id => id !== merlin && id !== minion);
  propose(room, [merlin, minion]);
  voteAll(room, 6);
  throwsCode(() => G.applyAction(room, P(room, merlin), { type: 'mission', card: 'fail' }), 'forbidden');
  throwsCode(() => G.applyAction(room, P(room, outsider), { type: 'mission', card: 'success' }), 'forbidden');
  G.applyAction(room, P(room, minion), { type: 'mission', card: 'fail' });
  throwsCode(() => G.applyAction(room, P(room, minion), { type: 'mission', card: 'success' }), 'duplicate');
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

test('C: with 7+ players round 4 needs two fail cards', () => {
  for (const size of [7, 10]) {
    const room = setup(size, 'standard');
    runMission(room, 0); runMission(room, 1); runMission(room, 1); // S F F, now round 4
    assert.strictEqual(room.game.history[3].failsNeeded, 2);
    runMission(room, 1);
    assert.strictEqual(room.game.history[3].result.success, true, 'one fail is not enough');
    assert.strictEqual(room.game.successes, 2);
    runMission(room, 1); // round 5 needs one
    assert.strictEqual(room.game.winner, 'evil');
  }
  const r6 = setup(6);
  assert.ok(r6.game.history.every(h => h.failsNeeded === 1));
});

test('C: three failures end the game for evil without assassination', () => {
  const room = setup(6);
  runMission(room, 1); runMission(room, 1); runMission(room, 1);
  assert.strictEqual(room.game.phase, 'ended');
  assert.strictEqual(room.game.winner, 'evil');
  assert.strictEqual(room.game.assassination, null);
});

test('D: three successes lead to assassination; hitting Merlin wins for evil', () => {
  const room = setup(6);
  runMission(room); runMission(room); runMission(room);
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
  const v = G.viewFor(room, P(room, byRole(room, 'servant')[0]));
  assert.strictEqual(v.reveal.length, 6);
});

test('D: missing Merlin gives good the win', () => {
  const room = setup(6);
  runMission(room); runMission(room, 1); runMission(room); runMission(room);
  const assassin = P(room, byRole(room, 'assassin')[0]);
  G.applyAction(room, assassin, { type: 'assassinate', target: byRole(room, 'servant')[0] });
  assert.strictEqual(room.game.winner, 'good');
  assert.strictEqual(room.game.assassination.hit, false);
});

test('config: host-only, lobby-only, validated, and resets ready', () => {
  const { room, host } = lobby(6);
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  throwsCode(() => G.applyAction(room, room.players[1], { type: 'config', config: { size: 7 } }), 'forbidden');
  throwsCode(() => G.applyAction(room, host, { type: 'config', config: { size: 5 } }), 'bad_config'); // 6 already joined
  throwsCode(() => G.applyAction(room, host, { type: 'config', config: { size: 11 } }), 'bad_config');
  throwsCode(() => G.applyAction(room, host, { type: 'config', config: { preset: 'nope' } }), 'bad_config');
  throwsCode(() => G.applyAction(room, host, { type: 'config', config: { rejectRule: 'x' } }), 'bad_config');
  G.applyAction(room, host, { type: 'config', config: { size: 7 } });
  assert.deepStrictEqual(room.config, { size: 7, preset: 'basic', rejectRule: 'evil_wins' });
  assert.ok(room.players.every(p => !p.ready));
  G.applyAction(room, host, { type: 'config', config: { preset: 'oberon', rejectRule: 'forced' } });
  G.applyAction(room, host, { type: 'config', config: { size: 8 } }); // 8 has no 'oberon' preset
  assert.strictEqual(room.config.preset, 'standard');
  assert.strictEqual(room.config.rejectRule, 'forced');
  G.addPlayer(room, 'Seventh');
  const view = G.viewFor(room, host);
  assert.strictEqual(view.config.size, 8);
  assert.strictEqual(view.config.roles.length, 8);
  // Locked once the game starts.
  G.addPlayer(room, 'Eighth');
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  G.applyAction(room, host, { type: 'start' });
  throwsCode(() => G.applyAction(room, host, { type: 'config', config: { size: 9 } }), 'bad_phase');
});

test('restart resets data and re-deals roles; only after end', () => {
  const room = setup(6);
  const host = P(room, room.hostId);
  throwsCode(() => G.applyAction(room, host, { type: 'restart' }), 'bad_phase');
  runMission(room, 1); runMission(room, 1); runMission(room, 1);
  G.applyAction(room, host, { type: 'restart' });
  assert.strictEqual(room.status, 'lobby');
  assert.strictEqual(room.game, null);
  assert.ok(room.players.every(p => !p.ready));
  assert.ok(!('secret' in G.viewFor(room, host)));
});

test('reveal phase: every player must confirm once', () => {
  const { room, host } = lobby(5);
  room.players.forEach(p => G.applyAction(room, p, { type: 'ready', value: true }));
  G.applyAction(room, host, { type: 'start' });
  throwsCode(() => G.applyAction(room, host, { type: 'propose', team: [] }), 'bad_phase');
  G.applyAction(room, host, { type: 'ack' });
  throwsCode(() => G.applyAction(room, host, { type: 'ack' }), 'duplicate');
  room.players.slice(1).forEach(p => G.applyAction(room, p, { type: 'ack' }));
  assert.strictEqual(room.game.phase, 'team');
});
