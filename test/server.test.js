'use strict';
// End-to-end tests over HTTP: secrecy, auth and concurrent duplicate requests.
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DATA_FILE = path.join(os.tmpdir(), `avalon-test-${process.pid}.json`);
const { createServer, rooms } = require('../server');

let base, server;
test.before(async () => {
  server = createServer();
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

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
  const room = rooms.get(code);
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
  const room = rooms.get(code);
  const leaderId = room.game.seats[room.game.leaderIdx];
  const leader = players.find(p => p.playerId === leaderId);
  const other = players.find(p => p !== leader);
  const team = room.game.seats.slice(0, 2);
  assert.strictEqual((await call('POST', `/api/rooms/${code}/action`, { type: 'propose', team }, other.token)).status, 403);
  assert.strictEqual((await call('POST', `/api/rooms/${code}/action`, { type: 'propose', team }, leader.token)).status, 200);

  const burst = await Promise.all(Array.from({ length: 5 }, () => call('POST', `/api/rooms/${code}/action`, { type: 'vote', approve: true }, players[0].token)));
  assert.strictEqual(burst.filter(r => r.status === 200).length, 1);
  assert.ok(burst.filter(r => r.status !== 200).every(r => r.status === 409));
  assert.strictEqual(Object.keys(room.game.votes).length, 1);

  // Clients cannot write arbitrary state.
  const bogus = await call('POST', `/api/rooms/${code}/action`, { type: 'setWinner', winner: 'good' }, players[1].token);
  assert.strictEqual(bogus.status, 400);
  assert.strictEqual(room.game.winner, null);
});

test('E: SSE stream pushes personalised state', async () => {
  const { code, players } = await makeGame();
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/rooms/${code}/events?token=${players[2].token}`, { signal: ctrl.signal });
  const reader = res.body.getReader();
  let buf = '';
  while (!buf.includes('event: state')) buf += new TextDecoder().decode((await reader.read()).value);
  const line = buf.split('\n').find(l => l.startsWith('data: {'));
  const st = JSON.parse(line.slice(6));
  assert.strictEqual(st.me.id, players[2].playerId);
  assert.ok(st.players.find(p => p.id === players[2].playerId).online);
  ctrl.abort();
});
