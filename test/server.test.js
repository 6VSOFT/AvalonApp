'use strict';
// End-to-end tests over HTTP (local server) plus direct tests of the shared API's
// compare-and-set behaviour: secrecy, auth, polling and concurrent requests.
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('../server');
const { createApi, memoryStore } = require('../src/api');
const game = require('../src/game');

let base, server;
test.before(async () => {
  server = createServer(memoryStore());
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const roomOf = async code => (await server.store.get(code)).room;

let ipCounter = 0;
async function call(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${++ipCounter % 250}`, ...(token ? { 'X-Player-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function makeGame() {
  const c = await call('POST', '/api/rooms', { name: 'Host' });
  const code = c.data.code;
  const players = [c.data];
  for (let i = 2; i <= 6; i++) players.push((await call('POST', `/api/rooms/${code}/join`, { name: 'P' + i })).data);
  const seventh = await call('POST', `/api/rooms/${code}/join`, { name: 'P7' });
  assert.strictEqual(seventh.status, 409);
  for (const p of players) await call('POST', `/api/rooms/${code}/action`, { type: 'ready', value: true }, p.token);
  const start = await call('POST', `/api/rooms/${code}/action`, { type: 'start' }, players[0].token);
  assert.strictEqual(start.status, 200);
  for (const p of players) await call('POST', `/api/rooms/${code}/action`, { type: 'ack' }, p.token);
  return { code, players };
}

test('E: a player only ever receives their own secret', async () => {
  const { code, players } = await makeGame();
  const room = await roomOf(code);
  for (const p of players) {
    const { data } = await call('GET', `/api/rooms/${code}/state`, null, p.token);
    assert.strictEqual(data.me.id, p.playerId);
    assert.strictEqual(data.secret.role, room.game.roles[p.playerId]);
    const json = JSON.stringify(data);
    for (const o of players) if (o !== p) assert.ok(!json.includes(o.token));
    assert.ok(!json.includes('"roles":{'), 'the per-player role table never leaves the server');
  }
  // Without or with a forged token: rejected.
  assert.strictEqual((await call('GET', `/api/rooms/${code}/state`)).status, 401);
  assert.strictEqual((await call('GET', `/api/rooms/${code}/state?token=${players[0].playerId}`)).status, 401);
  assert.strictEqual((await call('GET', `/api/rooms/zz/state`, null, players[0].token)).status, 404);
  // Public room peek reveals nothing secret.
  const peek = await call('GET', `/api/rooms/${code}`);
  assert.deepStrictEqual(Object.keys(peek.data).sort(), ['code', 'count', 'size', 'status']);
});

test('E: concurrent duplicate votes count once; non-leader cannot force results', async () => {
  const { code, players } = await makeGame();
  const room = await roomOf(code);
  const leaderId = room.game.seats[room.game.leaderIdx];
  const leader = players.find(p => p.playerId === leaderId);
  const other = players.find(p => p !== leader);
  const team = room.game.seats.slice(0, 2);
  assert.strictEqual((await call('POST', `/api/rooms/${code}/action`, { type: 'propose', team }, other.token)).status, 403);
  assert.strictEqual((await call('POST', `/api/rooms/${code}/action`, { type: 'propose', team }, leader.token)).status, 200);

  const burst = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/api/rooms/${code}/action`, { type: 'vote', approve: true }, players[0].token)));
  assert.strictEqual(burst.filter(r => r.status === 200).length, 1);
  assert.ok(burst.filter(r => r.status !== 200).every(r => r.status === 409));
  assert.strictEqual(Object.keys((await roomOf(code)).game.votes).length, 1);

  // Different players voting at the same moment all count.
  const rest = players.slice(1, 5);
  const results = await Promise.all(rest.map(p => call('POST', `/api/rooms/${code}/action`, { type: 'vote', approve: false }, p.token)));
  assert.ok(results.every(r => r.status === 200));
  assert.strictEqual(Object.keys((await roomOf(code)).game.votes).length, 5);

  // Clients cannot write arbitrary state.
  const bogus = await call('POST', `/api/rooms/${code}/action`, { type: 'setWinner', winner: 'good' }, players[1].token);
  assert.strictEqual(bogus.status, 400);
  assert.strictEqual((await roomOf(code)).game.winner, null);
});

test('E: polling returns the personalised view and marks the player online', async () => {
  const { code, players } = await makeGame();
  const { data } = await call('GET', `/api/rooms/${code}/state`, null, players[2].token);
  assert.strictEqual(data.me.id, players[2].playerId);
  assert.ok(data.players.find(p => p.id === players[2].playerId).online);
  // An action response carries the actor's fresh state.
  const room = await roomOf(code);
  const leader = players.find(p => p.playerId === room.game.seats[room.game.leaderIdx]);
  const r = await call('POST', `/api/rooms/${code}/action`, { type: 'propose', team: room.game.seats.slice(0, 2) }, leader.token);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.state.phase, 'vote');
  assert.strictEqual(r.data.state.me.id, leader.playerId);
});

test('a write that loses a race is retried on fresh state, never overwriting the other write', async () => {
  const store = memoryStore();
  const api = createApi(store);
  const req = (method, p, body, token) => api(new Request('http://x' + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Player-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), 'test-ip');

  const host = await (await req('POST', '/api/rooms', { name: 'H', config: { size: 5 } })).json();
  const ps = [host];
  for (let i = 2; i <= 5; i++) ps.push(await (await req('POST', `/api/rooms/${host.code}/join`, { name: 'P' + i })).json());
  for (const p of ps) await req('POST', `/api/rooms/${host.code}/action`, { type: 'ready', value: true }, p.token);
  await req('POST', `/api/rooms/${host.code}/action`, { type: 'start' }, host.token);
  for (const p of ps) await req('POST', `/api/rooms/${host.code}/action`, { type: 'ack' }, p.token);
  let room = (await store.get(host.code)).room;
  const leader = ps.find(p => p.playerId === room.game.seats[room.game.leaderIdx]);
  await req('POST', `/api/rooms/${host.code}/action`, { type: 'propose', team: room.game.seats.slice(0, 2) }, leader.token);

  // Make the next put lose a race: another player's vote lands between our read and our write.
  const realPut = store.put;
  let injected = false;
  store.put = async (code, r, etag) => {
    if (!injected) {
      injected = true;
      const { room: fresh, etag: e } = await store.get(code);
      game.applyAction(fresh, fresh.players.find(p => p.id === ps[1].playerId), { type: 'vote', approve: false });
      await realPut(code, fresh, e);
    }
    return realPut(code, r, etag);
  };
  const res = await req('POST', `/api/rooms/${host.code}/action`, { type: 'vote', approve: true }, ps[0].token);
  assert.strictEqual(res.status, 200);
  room = (await store.get(host.code)).room;
  assert.deepStrictEqual(room.game.votes, { [ps[1].playerId]: false, [ps[0].playerId]: true });
});
