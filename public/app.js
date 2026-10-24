'use strict';
// Avalon client. It holds no game logic that matters for fairness: every action
// is sent to the server, which validates it and pushes back this player's view.

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');
const $net = document.getElementById('net');
const SESSION_KEY = 'avalon.session';

const ui = {
  screen: 'home', // home | create | join | game | rules
  rulesTab: 'rules',
  joinCode: '',
  state: null,
  selection: [],
  target: null,
  showSecret: false,
  busy: false,
  connected: false,
  pollTimer: null,
  pollSeq: 0,
  lastRaw: null, // last state JSON from the server, to skip identical re-renders
  lastGameNo: null,
  installPrompt: null,
  options: null, // board/preset tables from the server
  createConfig: null,
  createName: '',
};
try { ui.createName = (JSON.parse(localStorage.getItem('avalon.profile')) || {}).name || ''; } catch {}

// ---------- utils ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function loadSession() { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } }
function saveSession(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} }

let toastTimer;
function toast(msg, kind = 'error') {
  $toast.textContent = msg;
  $toast.className = 'toast' + (kind === 'info' ? ' info' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.add('hidden'), 3200);
}

async function api(method, path, body, token) {
  if (!navigator.onLine) throw new Error('网络已断开，操作未提交');
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Player-Token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new Error('网络错误，操作未提交，请重试');
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const e = new Error(data.message || '请求失败（' + res.status + '）');
    e.status = res.status;
    e.code = data.error;
    throw e;
  }
  return data;
}

async function act(type, extra = {}) {
  const s = loadSession();
  if (!s || ui.busy) return;
  ui.busy = true;
  render();
  try {
    const r = await api('POST', `/api/rooms/${s.code}/action`, { type, ...extra }, s.token);
    if (type === 'leave' || type === 'dissolve') { leaveToHome(); return; }
    if (r.state) applyState(r.state);
  } catch (e) {
    toast(e.message);
    if (e.status === 401 || e.status === 404 || e.status === 410) { leaveToHome(); return; }
  } finally {
    ui.busy = false;
    render();
  }
}

// ---------- sync with the server (polling; the server is stateless on Netlify) ----------
const POLL_VISIBLE_MS = 1500;
const POLL_HIDDEN_MS = 8000;
function stopPolling() {
  clearTimeout(ui.pollTimer);
  ui.pollSeq = (ui.pollSeq || 0) + 1; // invalidates any request still in flight
}
function connect() {
  stopPolling();
  poll();
}
async function poll() {
  const s = loadSession();
  if (!s || ui.screen !== 'game') return;
  const seq = ui.pollSeq;
  try {
    const st = await api('GET', `/api/rooms/${s.code}/state`, null, s.token);
    if (seq !== ui.pollSeq) return;
    ui.connected = true;
    const raw = JSON.stringify(st);
    if (raw !== ui.lastRaw) { // re-render only on change so polling never disturbs the screen
      ui.lastRaw = raw;
      applyState(st);
      render();
    } else {
      updateNet();
    }
  } catch (e) {
    if (seq !== ui.pollSeq) return;
    if (e.status === 410) { toast(e.message); leaveToHome(); return; } // the host dissolved the room
    if (e.status === 401 || e.status === 404) { toast('房间已失效，或你已不在该房间'); leaveToHome(); return; }
    ui.connected = false;
    updateNet();
  }
  if (seq === ui.pollSeq && ui.screen === 'game') {
    ui.pollTimer = setTimeout(poll, document.visibilityState === 'visible' ? POLL_VISIBLE_MS : POLL_HIDDEN_MS);
  }
}
function updateNet() {
  const offline = !navigator.onLine || (ui.screen === 'game' && !ui.connected);
  $net.textContent = !navigator.onLine ? '⚠ 网络已断开 — 操作不会被提交' : '⚠ 与服务器断开，正在重新连接…';
  $net.classList.toggle('hidden', !offline);
}
window.addEventListener('online', () => { updateNet(); if (ui.screen === 'game') connect(); });
window.addEventListener('offline', updateNet);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.screen === 'game') connect(); // refresh at once when the phone wakes
});

function applyState(st) {
  const prev = ui.state;
  if (prev && (prev.phase !== st.phase || prev.round !== st.round || prev.gameNo !== st.gameNo)) {
    ui.selection = [];
    ui.target = null;
  }
  if (st.gameNo !== ui.lastGameNo) { ui.showSecret = false; ui.lastGameNo = st.gameNo; }
  // Show each room notice once; one that was already there when we arrived is old news.
  const noticeId = st.notice ? st.notice.id : null;
  if (prev && noticeId && noticeId !== ui.lastNoticeId) toast(st.notice.text, 'info');
  ui.lastNoticeId = noticeId;
  ui.state = st;
}

function enterGame(session) {
  saveSession(session);
  ui.screen = 'game';
  ui.state = null;
  history.replaceState(null, '', '/');
  connect();
  render();
}
function leaveToHome() {
  stopPolling();
  ui.lastRaw = null;
  clearSession();
  ui.state = null;
  ui.screen = 'home';
  ui.connected = false;
  updateNet();
  render();
}

// ---------- views ----------
function render() {
  $app.innerHTML = ({ home: viewHome, create: viewCreate, join: viewJoin, game: viewGame, rules: viewRules })[ui.screen]();
  updateNet();
}

function viewHome() {
  const s = loadSession();
  const name = loadProfile().name;
  return `
    <h1>AVALON</h1>
    <p class="center muted" style="margin-bottom:20px">阿瓦隆 · 5–10 人 · 线下聚会的全流程主持助手</p>
    <div class="card profile" data-a="profile">
      <span class="avatar">${name ? esc([...name][0]) : '?'}</span>
      <div><b>${name ? esc(name) : '设置你的昵称'}</b><p class="muted" style="margin:2px 0 0">点击头像或名字可进行修改。</p></div>
    </div>
    ${s ? `<div class="card gold stack"><p>你在房间 <b>${esc(s.code)}</b> 有一个进行中的会话。</p>
      <button data-a="resume">返回房间</button><button class="ghost" data-a="forget">放弃该会话</button></div>` : ''}
    <div class="stack">
      <button data-a="go-create" ${s ? 'disabled' : ''}>创建房间</button>
      <button class="secondary" data-a="go-join" ${s ? 'disabled' : ''}>加入房间</button>
      <button class="ghost" data-a="rules">规则说明</button>
    </div>
    ${s ? '<p class="muted center" style="margin-top:10px">一台设备只能控制一名玩家。</p>' : ''}
    ${installHint()}`;
}

function installHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<div class="card install" style="margin-top:22px">
    <b>📲 安装到主屏幕</b>
    <p class="muted" style="margin-top:6px">${ios ? '在 Safari 中点击「分享」→「添加到主屏幕」。' : '在浏览器菜单中选择「安装应用」或「添加到主屏幕」。'}</p>
    ${ui.installPrompt ? '<button class="small secondary" data-a="install">立即安装</button>' : ''}
  </div>`;
}

function viewCreate() {
  if (!ui.options) return `<p class="center muted" style="margin-top:40px">正在加载…</p>`;
  const cfg = ui.createConfig;
  return `
    <div class="topbar"><button class="small ghost" data-a="home">← 返回</button></div>
    <h2>创建房间</h2>
    <p class="muted">先选择人数，再确认阵营角色与规则。进入大厅后房主仍可修改。</p>
    <div class="card">${configEditor(cfg, true, 1)}</div>
    <form class="card stack" data-form="create">
      <div><label>你的昵称</label><input name="name" maxlength="12" autocomplete="nickname" value="${esc(ui.createName)}" required></div>
      <button type="submit" ${ui.busy ? 'disabled' : ''}>创建 ${cfg.size} 人房间</button>
    </form>
    <p class="muted">创建者也是玩家之一，只负责建房和开始游戏，不是法官，无法看到他人身份。</p>`;
}

// Size picker, role preview, preset and 5-rejection rule. Shared by the create screen and the lobby.
function configEditor(cfg, editable, minSize) {
  const o = ui.options;
  const board = o.boards[cfg.size];
  const presets = o.presets[cfg.size];
  const preset = presets.find(p => p.id === cfg.preset) || presets[0];
  const chips = team => {
    const counts = {};
    preset.roles.filter(r => o.roles[r].team === team).forEach(r => { counts[r] = (counts[r] || 0) + 1; });
    return Object.entries(counts).map(([r, n]) => `<span class="chip ${team}"><img class="role-chip" src="${roleArt(r)}" alt="${esc(o.roles[r].name)}" width="22" height="22"><span>${esc(o.roles[r].short)}${n > 1 ? ' x' + n : ''}</span></span>`).join('');
  };
  const sizes = o.sizes.map(s => `<button type="button" class="size ${s === cfg.size ? 'on' : ''}" data-a="cfg-size" data-v="${s}"
    ${editable && s >= minSize ? '' : 'disabled'}>${s}</button>`).join('');
  const fails2 = cfg.size >= 7;
  return `
    <label>选择人数</label>
    <div class="sizes">${sizes}</div>
    <p class="muted">任务人数：${board.missions.map((m, i) => (fails2 && i === 3 ? `${m}*` : m)).join(' / ')}${fails2 ? '　* 第 4 轮需 2 张失败牌' : ''}</p>
    <label style="margin-top:12px">角色预览</label>
    <div class="camp good">蓝方阵营（${board.good}人）</div><div class="chips">${chips('good')}</div>
    <div class="camp evil">红方阵营（${board.evil}人）</div><div class="chips">${chips('evil')}</div>
    <div class="cfgrow"><span>角色预设</span><b>${esc(preset.name)}</b>
      ${editable ? `<button type="button" class="small" data-a="cfg-preset" ${presets.length > 1 ? '' : 'disabled'}>切换预设</button>` : ''}</div>
    <div class="cfgrow"><span>5连流局</span><b>${esc(o.rejectRules[cfg.rejectRule])}</b>
      ${editable ? '<button type="button" class="small" data-a="cfg-rule">切换规则</button>' : ''}</div>
    <p class="muted" style="margin-top:6px">${cfg.rejectRule === 'forced'
      ? '连续 5 次组队被否决后，队长顺延，下一位队长组队后跳过投票直接执行任务。'
      : '同一轮连续 5 次组队被否决，坏人直接获胜。'}</p>
    <div class="cfgrow"><span>湖中女神</span><b>${cfg.size < o.ladyMinSize ? `${o.ladyMinSize} 人及以上可用` : cfg.lady ? '开启' : '关闭'}</b>
      ${editable && cfg.size >= o.ladyMinSize ? `<button type="button" class="small" data-a="cfg-lady">${cfg.lady ? '关闭' : '开启'}</button>` : ''}</div>
    ${cfg.lady ? '<p class="muted" style="margin-top:6px">第 2、3、4 轮任务后，持有者可以秘密查验一名玩家的阵营，然后把湖中女神交给对方。</p>' : ''}`;
}

// Applies a config change: locally on the create screen, through the server in the lobby.
function changeConfig(kind, value) {
  const cur = ui.screen === 'create' ? ui.createConfig : ui.state.config;
  const presets = ui.options.presets[cur.size];
  let patch;
  if (kind === 'size') patch = { size: Number(value) };
  else if (kind === 'preset') {
    const i = presets.findIndex(p => p.id === cur.preset);
    patch = { preset: presets[(i + 1) % presets.length].id };
  } else if (kind === 'lady') {
    patch = { lady: !cur.lady };
  } else {
    const rules = Object.keys(ui.options.rejectRules);
    patch = { rejectRule: rules[(rules.indexOf(cur.rejectRule) + 1) % rules.length] };
  }
  if (ui.screen === 'create') {
    const next = { ...cur, ...patch };
    if (patch.size && !ui.options.presets[next.size].some(p => p.id === next.preset)) next.preset = ui.options.presets[next.size][0].id;
    if (next.size < ui.options.ladyMinSize) next.lady = false;
    ui.createConfig = next;
    render();
  } else {
    act('config', { config: patch });
  }
}

function viewJoin() {
  return `
    <div class="topbar"><button class="small ghost" data-a="home">← 返回</button></div>
    <h2>加入房间</h2>
    <form class="card stack" data-form="join">
      <div><label>房间代码</label><input class="code" name="code" maxlength="5" value="${esc(ui.joinCode)}" autocomplete="off" autocapitalize="characters" required></div>
      <div><label>你的昵称</label><input name="name" maxlength="12" autocomplete="nickname" value="${esc(loadProfile().name || '')}" required ${ui.joinCode ? 'autofocus' : ''}></div>
      <button type="submit" ${ui.busy ? 'disabled' : ''}>加入</button>
    </form>`;
}

function viewGame() {
  const st = ui.state;
  if (!st) return `<p class="center muted" style="margin-top:40px">正在连接房间…</p>`;
  const top = `<div class="topbar">
      <span>房间 <span class="code-tag">${esc(st.code)}</span></span>
      <span class="row"><span class="dot ${ui.connected ? 'on' : ''}"></span><b>${esc(st.me.name)}</b>
      ${st.secret ? '<button class="small secondary" data-a="secret">我的身份</button>' : ''}</span>
    </div>`;
  if (st.status === 'lobby') return top + viewLobby(st) + roomExit(st);
  if (st.status === 'ended') return top + viewEnded(st) + roomExit(st);
  return top + viewBoard(st) + viewPhase(st) + viewHistory(st) + roomExit(st);
}

const nameOf = (st, id) => (st.players.find(p => p.id === id) || {}).name || '?';
// Seat numbers are public (the lobby seating), so the client shows them next to names.
// Role art URL. Bump ROLE_ART_VERSION whenever the art changes: a new URL makes browsers that
// cached the old images (they used to be cached for a day) fetch the new ones.
const ROLE_ART_VERSION = 2;
const roleArt = role => `/roles/${encodeURIComponent(role)}.svg?v=${ROLE_ART_VERSION}`;
const seatNo = (st, id) => st.players.findIndex(p => p.id === id) + 1;
// "6号 Ahmad": how a player is named anywhere outside the seat list itself (not HTML-escaped).
const seatName = (st, id) => `${seatNo(st, id)}号 ${nameOf(st, id)}`;
// "赞成 4【1号、2号、3号、4号】· 反对 1【5号】" (attempts saved before votes were recorded show counts only).
function voteBreakdown(st, att) {
  const seats = ids => (ids ? `【${ids.map(id => seatNo(st, id) + '号').join('、') || '无'}】` : '');
  return `赞成 ${att.approve}${seats(att.approvers)} · 反对 ${att.reject}${seats(att.rejecters)}`;
}

function viewLobby(st) {
  const me = st.players.find(p => p.id === st.me.id);
  const size = st.config.size;
  const full = st.players.length === size;
  const allReady = full && st.players.every(p => p.ready);
  const link = `${location.origin}/r/${st.code}`;
  // The list is the seating: one row per seat. Tap an empty seat to sit there, or another
  // player's seat to ask them to swap.
  const myRequest = st.swaps.find(s => s.from === me.id);
  const incoming = st.swaps.filter(s => s.to === me.id);
  const rows = Array.from({ length: size }, (_, seat) => {
    const p = st.players.find(x => x.seat === seat);
    const num = `<span class="seat">${seat + 1}</span>`;
    if (!p) {
      return `<li class="selectable" data-a="seat" data-v="${seat}">${num}<span class="name muted">空座位 · 点击坐这里</span></li>`;
    }
    const mine = p.id === me.id;
    const asked = myRequest && myRequest.to === p.id;
    return `<li class="${mine ? 'selected' : 'selectable'}" ${mine ? '' : `data-a="seat" data-v="${seat}"`}>${num}
      <span class="dot ${p.online ? 'on' : ''}"></span>
      <span class="name">${esc(p.name)}${mine ? '（你）' : ''}</span>
      ${asked ? '<span class="badge">等待回应</span>' : ''}
      ${p.id === st.hostId ? '<span class="badge gold">房主</span>' : ''}
      <span class="badge ${p.ready ? 'ok' : ''}">${p.ready ? '已准备' : '未准备'}</span></li>`;
  }).join('');
  const requests = incoming.map(s => {
    const from = st.players.find(p => p.id === s.from);
    return from ? `<div class="notice">${esc(from.name)}（${from.seat + 1} 号）想和你（${me.seat + 1} 号）换座位
      <div class="grid2" style="margin-top:8px"><button class="small ok" data-a="swap-yes" data-v="${esc(from.id)}" ${ui.busy ? 'disabled' : ''}>同意</button>
      <button class="small ghost" data-a="swap-no" data-v="${esc(from.id)}" ${ui.busy ? 'disabled' : ''}>拒绝</button></div></div>` : '';
  }).join('');
  const pending = myRequest ? `<div class="notice">已请求和 ${esc((st.players.find(p => p.id === myRequest.to) || {}).name || '?')} 换座位，等待对方同意
    <button class="small ghost" style="margin-top:8px" data-a="swap-cancel">取消请求</button></div>` : '';
  return `
    <div class="card center">
      <div class="muted">房间代码</div>
      <div class="bigcode">${esc(st.code)}</div>
      <img class="qr" alt="加入二维码" src="/api/rooms/${esc(st.code)}/qr.svg?origin=${encodeURIComponent(location.origin)}">
      <p class="muted" style="word-break:break-all">${esc(link)}</p>
      <button class="small ghost" data-a="share">复制/分享链接</button>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:6px"><h3 class="grow" style="margin:0">座位</h3><b>${st.players.length}/${size}</b></div>
      <p class="muted" style="margin:0 0 10px">按座位顺序轮流当队长。点空座位直接换过去，点别人的座位可以请求互换。</p>
      ${requests}${pending}
      <ul class="players">${rows}</ul>
    </div>
    <div class="card">
      <h3>房间配置</h3>
      ${ui.options ? configEditor(st.config, st.me.isHost && !ui.busy, Math.max(st.players.length, 1)) : ''}
      ${st.me.isHost ? '<p class="muted">修改配置后所有玩家需要重新准备。</p>' : ''}
    </div>
    <div class="stack">
      <button class="${me.ready ? 'ghost' : 'ok'}" data-a="ready" ${ui.busy ? 'disabled' : ''}>${me.ready ? '取消准备' : '我准备好了'}</button>
      ${st.me.isHost ? `<button data-a="start" ${allReady && !ui.busy ? '' : 'disabled'}>开始游戏</button>
        <p class="muted center">${!full ? `需要 ${size} 名玩家才能开始` : allReady ? '所有人已准备' : '等待所有玩家准备'}</p>`
        : '<p class="muted center">等待房主开始游戏</p>'}
    </div>`;
}

// Leave / dissolve, kept at the bottom and away from game actions; both ask for confirmation.
function roomExit(st) {
  return `<div class="room-exit">
    <button class="danger-outline" data-a="leave" ${ui.busy ? 'disabled' : ''}>离开房间</button>
    ${st.me.isHost ? `<button class="danger-outline" data-a="dissolve" ${ui.busy ? 'disabled' : ''}>解散房间</button>` : ''}
  </div>`;
}

// In-app confirmation dialog. Native confirm() is blocked by some in-app browsers (and then
// returns false), so the app never uses it. Resolves true only on the confirm button.
// tone: 'danger' (red), 'ok' (green) or 'primary' (blue).
function confirmDialog(title, body, okLabel, tone = 'danger') {
  if (ui.confirmResolve) ui.confirmResolve(false); // a newer dialog replaces an unanswered one
  return new Promise(resolve => {
    ui.confirmResolve = resolve;
    const btn = { danger: 'bad', ok: 'ok', primary: '' }[tone];
    $modal.innerHTML = `<div class="card stack confirm-dialog ${tone === 'danger' ? 'confirm-danger' : ''}">
      <h3>${esc(title)}</h3><p>${esc(body)}</p>
      <div class="grid2"><button class="ghost" data-a="confirm-no">取消</button><button class="${btn}" data-a="confirm-yes">${esc(okLabel)}</button></div>
    </div>`;
    $modal.classList.remove('hidden');
  });
}
function closeConfirm(answer) {
  $modal.classList.add('hidden');
  const resolve = ui.confirmResolve;
  ui.confirmResolve = null;
  if (resolve) resolve(answer);
}

function viewBoard(st) {
  const missions = st.history.map((h, i) => {
    const r = h.result;
    const cls = r ? (r.success ? 'ok' : 'bad') : (i + 1 === st.round && st.phase !== 'assassin' ? 'current' : '');
    return `<div class="mission ${cls}" title="第 ${i + 1} 轮${h.failsNeeded > 1 ? '，需 2 张失败牌' : ''}">${r ? (r.success ? '✓' : '✗') : h.size + (h.failsNeeded > 1 ? '*' : '')}</div>`;
  }).join('');
  const rejects = Array.from({ length: 5 }, (_, i) => `<span class="r ${i < st.rejects ? 'on' : ''}"></span>`).join('');
  return `<div class="card">
    <div class="score"><div class="g"><b>${st.successes}</b>任务成功</div><div><b>${st.round}</b>当前轮次</div><div class="e"><b>${st.fails}</b>任务失败</div></div>
    <div class="track">${missions}</div>
    <div class="rejects">连续否决 ${rejects} <span>${st.rejects}/5</span></div>
    <p class="muted" style="margin:8px 0 0">${st.size}人 · ${esc(st.config.presetName)} · 5连流局${esc(st.config.rejectRuleName)}${st.lady ? ' · 湖中女神' : ''}</p>
  </div>`;
}

function secretCard(st) {
  const s = st.secret;
  if (!ui.showSecret) {
    return `<div class="cover" data-a="toggle-secret"><div style="font-size:40px">🂠</div><b>点击查看你的身份</b><p class="muted">请确认旁人看不到你的屏幕</p></div>`;
  }
  return `<div class="card secret ${s.team}" data-a="toggle-secret">
    <div class="badge ${s.team}">${s.team === 'good' ? '好人阵营' : '坏人阵营'}</div>
    <p class="secret-me">你是 <b>${esc(st.me.name)}</b></p>
    <img class="role-art" src="${roleArt(s.role)}" alt="${esc(s.roleName)}" width="140" height="140">
    <div class="role">${esc(s.roleName)}</div>
    <p>${esc(s.desc)}</p>
    ${s.knowsLabel ? `<p class="muted" style="margin-top:10px">${esc(s.knowsLabel)}：</p><ul class="${s.role === 'percival' ? 'unknown' : ''}">${s.knows.map(k => `<li><span class="seat-no">${seatNo(st, k.id)}号</span>${esc(k.name)}</li>`).join('')}</ul>` : '<p class="muted">你不知道任何人的身份。</p>'}
    ${s.note ? `<p class="muted" style="margin-top:8px">${esc(s.note)}</p>` : ''}
    ${ladyResults(st)}
    <p class="muted" style="margin-top:12px">点击隐藏</p>
  </div>`;
}

function playerList(st, opts = {}) {
  return `<ul class="players">${st.players.map((p, i) => {
    const sel = opts.selectable && opts.selected.includes(p.id);
    const badges = [];
    if (p.id === st.leaderId) badges.push('<span class="badge gold">👑 队长</span>');
    if (st.lady && p.id === st.lady.holder) badges.push('<span class="badge lady">🌊 湖中女神</span>');
    if (opts.showTeam && st.team.includes(p.id)) badges.push('<span class="badge good">队员</span>');
    if (opts.voted) badges.push(opts.voted.includes(p.id) ? '<span class="badge ok">已投票</span>' : '<span class="badge">未投票</span>');
    if (opts.acked) badges.push(opts.acked.includes(p.id) ? '<span class="badge ok">已确认</span>' : '<span class="badge">查看中</span>');
    const disabled = opts.disabledId === p.id || (opts.disabledIds || []).includes(p.id);
    return `<li class="${opts.selectable && !disabled ? 'selectable' : ''} ${sel ? 'selected' : ''}" ${opts.selectable && !disabled ? `data-a="${opts.action}" data-id="${esc(p.id)}"` : ''} style="${disabled ? 'opacity:.4' : ''}">
      <span class="seat">${i + 1}</span><span class="dot ${p.online ? 'on' : ''}"></span>
      <span class="name">${esc(p.name)}${p.id === st.me.id ? '（你）' : ''}</span>${badges.join('')}</li>`;
  }).join('')}</ul>`;
}

// The Lady of the Lake results this player saw (the server only sends results to the checker).
function myLadyChecks(st) {
  return st.lady ? st.lady.checks.filter(c => c.from === st.me.id && c.team) : [];
}
function ladyResults(st) {
  const mine = myLadyChecks(st);
  if (!mine.length) return '';
  return `<p class="muted" style="margin-top:12px">湖中女神查验结果（只有你知道）：</p><ul class="lady-results">${mine.map(c =>
    `<li class="${c.team}">第${c.round}轮后 · ${seatNo(st, c.target)}号 ${esc(nameOf(st, c.target))}：${c.team === 'good' ? '好人阵营' : '坏人阵营'}</li>`).join('')}</ul>`;
}

// Latest public announcement (vote or mission result), shown at the top of the phase panel.
function lastNotice(st) {
  const ladyNote = ladyNotice(st);
  return ladyNote + missionNotice(st);
}
function ladyNotice(st) {
  if (!st.lady || st.phase !== 'team') return '';
  const last = st.lady.checks[st.lady.checks.length - 1];
  if (!last || last.round !== st.round - 1 || st.history[st.round - 1].attempts.length) return '';
  const who = `${seatNo(st, last.target)}号 ${esc(nameOf(st, last.target))}`;
  return last.team
    ? `<div class="notice ${last.team === 'good' ? 'ok' : 'bad'}">🌊 湖中女神结果（只有你能看到）：${who} 是<b>${last.team === 'good' ? '好人阵营' : '坏人阵营'}</b></div>`
    : `<div class="notice">🌊 ${seatNo(st, last.from)}号 ${esc(nameOf(st, last.from))} 使用湖中女神查验了 ${who}</div>`;
}
function missionNotice(st) {
  const cur = st.history[st.round - 1];
  const att = cur.attempts[cur.attempts.length - 1];
  if (st.phase === 'mission' && att) {
    return att.forced ? '<div class="notice">强制轮：跳过投票，队伍直接执行任务</div>'
      : `<div class="notice ok">组队通过：${voteBreakdown(st, att)}</div>`;
  }
  if (st.phase === 'team' && att && !att.passed) {
    return `<div class="notice bad">上次组队被否决：${voteBreakdown(st, att)}<br>队长移交给 <b>${esc(seatName(st, st.leaderId))}</b>
      ${st.forced ? '<br><b>已连续 5 次否决，进入强制轮：本次组队不投票，直接执行任务。</b>' : ''}</div>`;
  }
  const prev = st.phase === 'assassin' ? cur : (st.round > 1 && cur.attempts.length === 0 ? st.history[st.round - 2] : null);
  if (prev && prev.result) {
    const r = prev.result;
    return `<div class="notice ${r.success ? 'ok' : 'bad'}">
      <b>第 ${prev.round} 轮任务${r.success ? '成功' : '失败'}</b><br>
      队员：${r.team.map(id => esc(seatName(st, id))).join('、')}<br>
      成功牌 ${r.successCards} · 失败牌 ${r.failCards}<br>
      当前比分：成功 ${st.successes} · 失败 ${st.fails}<br>
      ${st.phase === 'assassin' ? '好人已完成三次任务，进入刺杀阶段。' : `下一位队长：<b>${esc(seatName(st, st.leaderId))}</b>`}
    </div>`;
  }
  return '';
}

function viewPhase(st) {
  const me = st.me.id;
  const leader = seatName(st, st.leaderId);
  const busy = ui.busy ? 'disabled' : '';
  let body = '';
  switch (st.phase) {
    case 'reveal': {
      const done = st.acked.includes(me);
      body = `<div class="phase">身份确认</div><h2>查看你的秘密身份</h2>
        ${secretCard(st)}
        ${done ? '<p class="center">✓ 你已确认，等待其他玩家…</p>' : `<button data-a="ack" ${busy}>我已记住身份</button>`}
        <p class="muted center" style="margin-top:8px">已确认 ${st.acked.length}/${st.size}</p>
        ${playerList(st, { acked: st.acked })}`;
      break;
    }
    case 'team': {
      if (st.leaderId === me) {
        const n = ui.selection.length;
        body = `<div class="phase">第 ${st.round} 轮 · ${st.forced ? '强制轮' : '组队'}</div><h2>你是队长：选择 ${st.teamSize} 名队员</h2>
          <p class="muted">可以选择自己。已选 ${n}/${st.teamSize}${st.forced ? '。强制轮：提交后不投票，直接执行任务。' : ''}</p>
          ${playerList(st, { selectable: true, selected: ui.selection, action: 'pick' })}
          <button data-a="propose" ${n === st.teamSize && !ui.busy ? '' : 'disabled'}>${n === st.teamSize ? '提交队伍' : `请选择 ${st.teamSize} 人`}</button>`;
      } else {
        body = `<div class="phase">第 ${st.round} 轮 · 组队</div><h2>等待队长 ${esc(leader)} 提名 ${st.teamSize} 名队员</h2>
          <p class="muted">现在可以面对面讨论。</p>${playerList(st)}`;
      }
      break;
    }
    case 'vote': {
      const voted = 'myVote' in st;
      body = `<div class="phase">第 ${st.round} 轮 · 投票</div><h2>是否同意这支队伍？</h2>
        <p>队长 <b>${esc(leader)}</b> 提名：${st.team.map(id => `<span class="badge good">${esc(seatName(st, id))}</span>`).join(' ')}</p>
        <p class="muted">需要至少 ${st.approvalsNeeded} 票赞成才能通过。投票在全员投完前保密。</p>
        ${voted ? `<div class="notice">你已投票：<b>${st.myVote ? '赞成 ✓' : '反对 ✗'}</b>，等待其他玩家…</div>`
          : `<div class="grid2"><button class="ok" data-a="vote" data-v="1" ${busy}>赞成</button><button class="bad" data-a="vote" data-v="0" ${busy}>反对</button></div>`}
        <p class="muted center" style="margin-top:8px">已投票 ${st.votedIds.length}/${st.size}</p>
        ${playerList(st, { showTeam: true, voted: st.votedIds })}`;
      break;
    }
    case 'mission': {
      const onTeam = st.team.includes(me);
      let action;
      if (!onTeam) action = '<p class="muted">你不在本轮队伍中，等待队员执行任务。</p>';
      else if (st.mySubmitted) action = '<div class="notice">✓ 你已提交任务牌，等待其他队员…</div>';
      else if (st.secret.team === 'good') action = `<p class="muted">好人只能提交成功牌。</p><button class="ok" data-a="card" data-v="success" ${busy}>提交 成功</button>`;
      else action = `<p class="muted">你可以选择成功或失败。只有数量会被公布。</p>
        <div class="grid2"><button class="ok" data-a="card" data-v="success" ${busy}>成功</button><button class="bad" data-a="card" data-v="fail" ${busy}>失败</button></div>`;
      body = `<div class="phase">第 ${st.round} 轮 · 执行任务</div><h2>任务进行中</h2>
        <p>队员：${st.team.map(id => `<span class="badge good">${esc(seatName(st, id))}</span>`).join(' ')}</p>
        ${st.failsNeeded > 1 ? `<div class="notice">本轮需要至少 ${st.failsNeeded} 张失败牌，任务才会失败。</div>` : ''}
        ${action}
        <p class="muted center" style="margin-top:8px">已提交 ${st.submittedCount}/${st.team.length}</p>`;
      break;
    }
    case 'lady': {
      const holder = st.lady.holder;
      if (holder === me) {
        body = `<div class="phase">湖中女神</div><h2>选择一名玩家查验阵营</h2>
          <p class="muted">只有你会看到结果（好人或坏人阵营，看不到具体角色）。不能查验自己和曾经持有湖中女神的玩家。查验后湖中女神交给对方。</p>
          ${playerList(st, { selectable: true, selected: ui.target ? [ui.target] : [], action: 'target', disabledIds: st.lady.holders })}
          <button data-a="lady" ${ui.target && !ui.busy ? '' : 'disabled'}>${ui.target ? `查验 ${seatNo(st, ui.target)}号 ${esc(nameOf(st, ui.target))}` : '请选择要查验的玩家'}</button>`;
      } else {
        body = `<div class="phase">湖中女神</div><h2>等待 ${seatNo(st, holder)}号 ${esc(nameOf(st, holder))} 使用湖中女神…</h2>
          <p class="muted">持有者会秘密查验一名玩家的阵营，结果只有持有者知道。</p>${playerList(st)}`;
      }
      break;
    }
    case 'assassin': {
      if (st.secret.role === 'assassin') {
        body = `<div class="phase">刺杀阶段</div><h2>选择你认为是梅林的玩家</h2>
          <p class="muted">确认后不可撤销。猜中梅林则坏人获胜。</p>
          ${playerList(st, { selectable: true, selected: ui.target ? [ui.target] : [], action: 'target', disabledId: me })}
          <button class="bad" data-a="assassinate" ${ui.target && !ui.busy ? '' : 'disabled'}>${ui.target ? `刺杀 ${esc(seatName(st, ui.target))}` : '请选择目标'}</button>`;
      } else {
        body = `<div class="phase">刺杀阶段</div><h2>刺客正在选择刺杀目标…</h2>
          <p class="muted">坏人可以公开讨论谁是梅林，但只有刺客能做出最终选择。</p>${playerList(st)}`;
      }
      break;
    }
  }
  return `<div class="card gold">${lastNotice(st)}${body}</div>`;
}

function historyRows(st) {
  return st.history.filter(h => h.attempts.length || h.result).map(h => {
    const atts = h.attempts.map((a, i) => `<div>#${i + 1} ${esc(seatName(st, a.leader))}：${a.team.map(id => esc(seatName(st, id))).join('、')}
      <span class="badge ${a.passed ? 'ok' : 'bad'}">${a.forced ? '强制' : `${a.approve}:${a.reject}`}</span>
      ${a.forced ? '' : `<div class="muted vote-seats">${voteBreakdown(st, a)}</div>`}</div>`).join('');
    const res = h.result ? `<span class="badge ${h.result.success ? 'ok' : 'bad'}">${h.result.success ? '成功' : '失败'} ${h.result.successCards}✓ ${h.result.failCards}✗</span>` : '<span class="badge">进行中</span>';
    const lady = st.lady ? st.lady.checks.filter(c => c.round === h.round).map(c => `<div class="muted vote-seats">🌊 ${seatNo(st, c.from)}号 查验 ${seatNo(st, c.target)}号</div>`).join('') : '';
    return `<tr><td>第${h.round}轮<br><span class="muted">${h.size}人${h.failsNeeded > 1 ? ' · 2败' : ''}</span></td><td>${atts}${lady}</td><td>${res}</td></tr>`;
  }).join('');
}
function viewHistory(st) {
  const rows = historyRows(st);
  if (!rows) return '';
  return `<div class="card"><h3>任务历史</h3><table class="history"><tr><th>轮次</th><th>提名与投票</th><th>结果</th></tr>${rows}</table></div>`;
}

function viewEnded(st) {
  const good = st.winner === 'good';
  const a = st.assassination;
  return `
    <div class="banner ${good ? 'good' : 'evil'}"><h2>${good ? '好人阵营胜利' : '坏人阵营胜利'}</h2><p>${esc(st.reason)}</p></div>
    ${a ? `<div class="card"><h3>刺杀结果</h3><p>刺客选择了 <b>${esc(seatName(st, a.target))}</b> —— ${a.hit ? '正是梅林！' : '不是梅林。'}</p></div>` : ''}
    <div class="card"><div class="card-head"><h3>身份揭晓</h3><button class="small ghost" data-a="copy" data-v="reveal">复制</button></div><ul class="players reveal">${st.reveal.map((r, i) => `<li><span class="seat">${i + 1}</span><img class="role-reveal" src="${roleArt(r.role)}" alt="${esc(r.roleName)}" width="36" height="36"><span class="name">${esc(r.name)}${r.id === st.me.id ? '（你）' : ''}</span>
      <span class="badge ${r.team}">${esc(r.roleName)}</span></li>`).join('')}</ul></div>
    <div class="card"><div class="card-head"><h3>任务记录</h3><button class="small ghost" data-a="copy" data-v="history">复制</button></div>
      <div class="score"><div class="g"><b>${st.successes}</b>成功任务</div><div class="e"><b>${st.fails}</b>失败任务</div></div>
      <table class="history"><tr><th>轮次</th><th>提名与投票</th><th>结果</th></tr>${historyRows(st)}</table></div>
    <div class="stack">
      ${st.me.isHost ? `<button data-a="restart" ${ui.busy ? 'disabled' : ''}>重新开始（重新分配身份）</button>` : '<p class="muted center">等待房主重新开始</p>'}
    </div>`;
}

// Plain-text summaries of a finished game for the copy buttons (to paste into a chat).
function gameTitle(st) {
  const result = st.winner === 'good' ? '好人阵营胜利' : '坏人阵营胜利';
  return `阿瓦隆 · 房间 ${st.code} · ${st.size}人 · ${st.config.presetName}\n${result}：${st.reason}`;
}
function revealText(st) {
  const lines = st.reveal.map((r, i) => `${i + 1}号 ${r.name}：${r.roleName.split(' ')[0]}（${r.team === 'good' ? '好人' : '坏人'}）`);
  return `${gameTitle(st)}\n\n身份揭晓：\n${lines.join('\n')}`;
}
function historyText(st) {
  const who = id => `${seatNo(st, id)}号 ${nameOf(st, id)}`;
  const seats = ids => (ids && ids.length ? ids.map(id => seatNo(st, id)).join('、') : '无');
  const lines = [`任务结果：成功 ${st.successes} · 失败 ${st.fails}`];
  for (const h of st.history) {
    if (!h.attempts.length && !h.result) continue;
    const r = h.result;
    const outcome = r ? `${r.success ? '成功' : '失败'}（成功牌 ${r.successCards} · 失败牌 ${r.failCards}）` : '未完成';
    lines.push('', `第${h.round}轮（${h.size}人${h.failsNeeded > 1 ? '，需2张失败' : ''}）：${outcome}`);
    h.attempts.forEach((a, i) => {
      const head = `  #${i + 1} 队长 ${who(a.leader)} 提名 ${a.team.map(id => seatNo(st, id) + '号').join('、')}`;
      if (a.forced) { lines.push(`${head} — 强制轮，未投票`); return; }
      lines.push(`${head} — ${a.passed ? '通过' : '否决'} ${a.approve}:${a.reject}`);
      if (a.approvers) lines.push(`     赞成【${seats(a.approvers)}】 反对【${seats(a.rejecters)}】`);
    });
    if (st.lady) st.lady.checks.filter(c => c.round === h.round).forEach(c => lines.push(`  湖中女神：${who(c.from)} 查验 ${who(c.target)}`));
  }
  const a = st.assassination;
  if (a) lines.push('', `刺杀：刺客选择了 ${who(a.target)}，${a.hit ? '正是梅林' : '不是梅林'}`);
  return `${gameTitle(st)}\n\n${lines.join('\n')}`;
}
// navigator.clipboard needs a secure context (https or localhost); fall back to execCommand
// for plain-http LAN addresses.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
}

const RULE_TABS = [['rules', '游戏规则'], ['roles', '角色介绍'], ['faq', '常见问答']];

// Rules screen with three tabs. Board, preset and role data come from /api/options.
function viewRules() {
  const o = ui.options;
  const tabs = RULE_TABS.map(([id, label]) => `<button class="tab ${ui.rulesTab === id ? 'on' : ''}" data-a="rules-tab" data-v="${id}">${label}</button>`).join('');
  let body = '<p class="center muted">正在加载…</p>';
  if (o && ui.rulesTab === 'rules') body = rulesTab(o);
  if (o && ui.rulesTab === 'roles') body = rolesTab(o);
  if (ui.rulesTab === 'faq') body = faqTab();
  return `
    <div class="topbar"><button class="small ghost" data-a="home">← 返回</button><h2 style="margin:0">规则说明</h2><span style="width:64px"></span></div>
    <div class="tabs">${tabs}</div>
    <div class="rules">${body}</div>`;
}

function lineup(o, roles) {
  const counts = {};
  roles.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  return Object.entries(counts).map(([r, n]) => o.roles[r].short + (n > 1 ? `×${n}` : '')).join('、');
}

function rulesTab(o) {
  const boards = o.sizes.map(n => `<tr><td>${n}人</td><td>${o.boards[n].good} / ${o.boards[n].evil}</td>
    <td>${o.boards[n].missions.map((m, i) => (n >= 7 && i === 3 ? `${m}*` : m)).join(' · ')}</td></tr>`).join('');
  const presets = o.sizes.map(n => `<p><b>${n}人局：</b>${esc(lineup(o, o.presets[n][0].roles))}</p>`).join('');
  return `
    <div class="card"><h3>阵营胜利条件</h3>
      <p><span class="badge good">蓝方</span> 5 次任务中，达成 3 次任务成功，且刺客没有刺中梅林。</p>
      <p><span class="badge evil">红方</span> 5 次任务中，造成 3 次任务失败；或在蓝方 3 次成功后的刺杀阶段刺中梅林。</p></div>
    <div class="card"><h3>游戏流程</h3><ol>
      <li>查看身份：每人在自己手机上私下查看角色和夜间信息。</li>
      <li>队长选择执行任务的队伍（可以选自己）。</li>
      <li>全员投票决定是否通过该队伍，超过半数赞成才通过。</li>
      <li>队员秘密出成功 / 失败牌，好人只能出成功。</li>
      <li>公开任务结果（只公布牌数），进入下一轮，队长顺延。</li></ol></div>
    <div class="card"><h3>任务人数</h3>
      <table class="history"><tr><th>人数</th><th>蓝 / 红</th><th>第 1–5 轮出任务人数</th></tr>${boards}</table>
      <p class="muted" style="margin-top:8px">* 7 人及以上第 4 轮需要 2 张失败牌任务才失败，其余每轮 1 张即失败。</p></div>
    <div class="card"><h3>阵容表（标准局）</h3>${presets}
      <p class="muted">创建房间时可以切换其他预设。</p></div>
    <div class="card"><h3>可选规则：湖中女神（${o.ladyMinSize}–10 人）</h3><ul>
      <li>房主在房间配置里开启。初始持有者是第一任队长右边的玩家。</li>
      <li>第 2、3、4 轮任务结算后（成功或失败都可以），持有者选择一名玩家，秘密查看他是好人还是坏人阵营，看不到具体角色。</li>
      <li>不能查验自己，也不能查验曾经持有湖中女神的玩家。查验后湖中女神交给被查验的人。</li>
      <li>所有人都能看到谁查验了谁，结果只有持有者知道。持有者可以如实说，也可以说谎。</li></ul></div>
    <div class="card"><h3>特殊规则</h3><ul>
      <li>7 人及以上第 4 次任务需要 2 张失败才算失败。</li>
      <li>5 连流局：连续 5 次组队投票未通过时，可选「红方直接获胜」或「进入强制轮」。</li></ul></div>`;
}

function rolesTab(o) {
  const card = r => {
    const role = o.roles[r];
    return `<div class="role-card ${role.team}">
      <img src="${roleArt(r)}" alt="${esc(role.name)}" width="72" height="72">
      <div><h3>${esc(role.short)}</h3>
        <p><span class="muted">阵营：</span><b class="team-${role.team}">${role.team === 'good' ? '蓝方' : '红方'}</b></p>
        <p><span class="muted">能力：</span>${esc(role.ability)}</p>
        <p><span class="muted">打法：</span>${esc(role.tip)}</p></div></div>`;
  };
  const ids = Object.keys(o.roles);
  return `<h3 class="camp good">蓝方阵营</h3>${ids.filter(r => o.roles[r].team === 'good').map(card).join('')}
    <h3 class="camp evil">红方阵营</h3>${ids.filter(r => o.roles[r].team === 'evil').map(card).join('')}`;
}

function faqTab() {
  const qa = [
    ['如何选择人数？', '创建房间时点击数字选择 5–10 人，房主在大厅也可以调整。'],
    ['角色预设是什么？', '针对不同人数预设好的角色组合，也可以切换其他预设。'],
    ['5 连流局规则是什么？', '连续 5 次组队提案未通过时的处理方式：进入强制轮（默认），或红方直接获胜。'],
    ['什么是强制轮？', '触发 5 连流局后，队长顺延给下一位玩家，由他重新选择队伍并直接执行任务，跳过投票阶段。'],
    ['任务结果会公开谁出的失败吗？', '不会，只公开成功 / 失败和失败牌数量，保护红方身份。'],
    ['需要法官吗？', '不需要。每人用自己的手机查看身份、投票和出任务牌，系统自动结算。'],
    ['刷新页面或断线会怎样？', '重新打开即可回到房间，身份和已提交的操作都会保留。'],
    ['湖中女神能看到梅林吗？', '不能，只能看到对方属于好人阵营还是坏人阵营。'],
    ['湖中女神能查莫德雷德吗？', '可以，会显示为坏人阵营。'],
    ['湖中女神每局能用几次？', '最多 3 次：第 2、3、4 轮任务后各一次。如果好人已经三次任务成功、进入刺杀阶段，就不再使用。'],
  ];
  return `<div class="card"><h3>房间可改配置</h3><p>创建房间后，房主可以在大厅调整：</p>
      <ul><li>房间人数（5–10 人）</li><li>角色预设（多种阵容选择）</li><li>5 连流局规则（红方直接获胜 / 进入强制轮）</li></ul>
      <p class="muted">修改后所有玩家需要重新准备。</p></div>
    ${qa.map(([q, a], i) => `<div class="card"><h3>Q${i + 1}：${q}</h3><p>A：${a}</p></div>`).join('')}`;
}

// ---------- profile (nickname remembered on this device) ----------
const PROFILE_KEY = 'avalon.profile';
function loadProfile() { try { return JSON.parse(localStorage.getItem(PROFILE_KEY)) || {}; } catch { return {}; } }
function saveProfile(p) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch {} }
function profileModal() {
  const p = loadProfile();
  $modal.innerHTML = `<form class="card stack" data-form="profile">
    <h3>设置昵称</h3>
    <div><label>你的昵称（最多 12 个字）</label><input name="name" maxlength="12" autocomplete="nickname" value="${esc(p.name || '')}" required autofocus></div>
    <div class="grid2"><button type="button" class="ghost" data-a="close-modal">取消</button><button type="submit">保存</button></div>
  </form>`;
  $modal.classList.remove('hidden');
}
function secretModal() {
  ui.showSecret = false;
  const draw = () => {
    $modal.innerHTML = `<div class="card">${secretCard(ui.state)}<button class="ghost" style="margin-top:12px" data-a="close-modal">关闭</button></div>`;
  };
  $modal._redraw = draw;
  draw();
  $modal.classList.remove('hidden');
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const a = el.dataset.a;
  const st = ui.state;
  switch (a) {
    case 'go-create':
      ui.screen = 'create';
      if (!ui.createConfig && ui.options) ui.createConfig = { ...ui.options.defaults };
      render();
      break;
    case 'cfg-size': changeConfig('size', el.dataset.v); break;
    case 'cfg-preset': changeConfig('preset'); break;
    case 'cfg-rule': changeConfig('rule'); break;
    case 'cfg-lady': changeConfig('lady'); break;
    case 'go-join': ui.screen = 'join'; render(); break;
    case 'home': ui.screen = 'home'; render(); break;
    case 'rules': ui.screen = 'rules'; render(); scrollTo(0, 0); break;
    case 'rules-tab': ui.rulesTab = el.dataset.v; render(); scrollTo(0, 0); break;
    case 'profile': profileModal(); break;
    case 'close-modal': $modal.classList.add('hidden'); $modal._redraw = null; ui.showSecret = false; render(); break;
    case 'secret': secretModal(); break;
    case 'toggle-secret':
      ui.showSecret = !ui.showSecret;
      if ($modal._redraw && !$modal.classList.contains('hidden')) $modal._redraw(); else render();
      break;
    case 'resume': enterGame(loadSession()); break;
    case 'forget':
      if (await confirmDialog('放弃该会话？', '放弃后将无法以该玩家身份回到房间。', '放弃')) { clearSession(); render(); }
      break;
    case 'install':
      if (ui.installPrompt) { ui.installPrompt.prompt(); ui.installPrompt = null; render(); }
      break;
    case 'share': {
      const link = `${location.origin}/r/${st.code}`;
      try {
        if (navigator.share) await navigator.share({ title: 'Avalon 阿瓦隆', text: `加入房间 ${st.code}`, url: link });
        else { await navigator.clipboard.writeText(link); toast('链接已复制', 'info'); }
      } catch {}
      break;
    }
    case 'copy': {
      const ok = await copyText(el.dataset.v === 'reveal' ? revealText(st) : historyText(st));
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文字复制', ok ? 'info' : 'error');
      break;
    }
    case 'ready': act('ready', { value: !st.players.find(p => p.id === st.me.id).ready }); break;
    case 'seat': {
      const seat = Number(el.dataset.v);
      const other = st.players.find(p => p.seat === seat);
      if (!other || await confirmDialog('请求换座位？', `请求和 ${other.name} 互换座位，对方同意后生效。`, '发送请求', 'primary')) act('seat', { seat });
      break;
    }
    case 'swap-yes': act('swap_answer', { from: el.dataset.v, accept: true }); break;
    case 'swap-no': act('swap_answer', { from: el.dataset.v, accept: false }); break;
    case 'swap-cancel': act('swap_cancel'); break;
    case 'start': act('start'); break;
    case 'leave': {
      const inGame = st.status === 'playing';
      const ok = await confirmDialog('离开房间？',
        inGame ? '游戏正在进行，你离开后本局会立即结束，所有人回到大厅。' : '你将离开这个房间，座位会空出来。',
        inGame ? '离开并结束本局' : '离开房间');
      if (ok) act('leave');
      break;
    }
    case 'dissolve': {
      const ok = await confirmDialog('解散房间？', '房间会立即关闭，所有玩家都会回到首页，进行中的游戏也会结束。此操作无法撤销。', '解散房间');
      if (ok) act('dissolve');
      break;
    }
    case 'confirm-yes': closeConfirm(true); break;
    case 'confirm-no': closeConfirm(false); break;
    case 'ack': act('ack'); break;
    case 'pick': {
      const id = el.dataset.id;
      if (ui.selection.includes(id)) ui.selection = ui.selection.filter(x => x !== id);
      else if (ui.selection.length < st.teamSize) ui.selection.push(id);
      else toast(`本轮只能选择 ${st.teamSize} 人`);
      render();
      break;
    }
    case 'propose': act('propose', { team: ui.selection }); break;
    case 'vote': {
      const approve = el.dataset.v === '1';
      if (await confirmDialog(`确认投「${approve ? '赞成' : '反对'}」？`, '提交后不可更改。', approve ? '赞成' : '反对', approve ? 'ok' : 'danger')) act('vote', { approve });
      break;
    }
    case 'card': {
      const card = el.dataset.v;
      if (await confirmDialog(`确认提交「${card === 'success' ? '成功' : '失败'}」牌？`, '提交后不可更改。', card === 'success' ? '提交成功' : '提交失败', card === 'success' ? 'ok' : 'danger')) act('mission', { card });
      break;
    }
    case 'target': ui.target = el.dataset.id; render(); break;
    case 'lady':
      if (ui.target && await confirmDialog(`查验 ${seatNo(st, ui.target)}号 ${nameOf(st, ui.target)}？`, '确认后不可更改，湖中女神会交给对方。', '查验', 'primary')) act('lady', { target: ui.target });
      break;
    case 'assassinate':
      if (ui.target && await confirmDialog(`确认刺杀 ${seatName(st, ui.target)}？`, '此操作不可撤销。猜中梅林则坏人获胜，否则好人获胜。', '刺杀')) act('assassinate', { target: ui.target });
      break;
    case 'restart': if (await confirmDialog('重新开始？', '将回到大厅并重新随机分配所有身份。', '重新开始', 'primary')) act('restart'); break;
  }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.form;
  const name = form.name.value.trim();
  if (!name) return toast('请输入昵称');
  if (kind === 'profile') {
    saveProfile({ ...loadProfile(), name });
    ui.createName = name;
    $modal.classList.add('hidden');
    render();
    return;
  }
  saveProfile({ ...loadProfile(), name }); // remember the last nickname used to create or join
  ui.busy = true;
  form.querySelector('button').disabled = true;
  try {
    if (kind === 'create') {
      const r = await api('POST', '/api/rooms', { name, config: ui.createConfig });
      ui.busy = false;
      enterGame({ code: r.code, token: r.token, playerId: r.playerId });
    } else {
      const code = form.code.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{5}$/.test(code)) throw new Error('房间代码应为 5 位字母或数字');
      ui.joinCode = code;
      const r = await api('POST', `/api/rooms/${code}/join`, { name });
      ui.busy = false;
      enterGame({ code: r.code, token: r.token, playerId: r.playerId });
    }
  } catch (err) {
    ui.busy = false;
    toast(err.message);
    form.querySelector('button').disabled = false;
  }
});

// Keep the typed nickname when the create screen re-renders after a config change.
document.addEventListener('input', e => {
  if (e.target.name === 'name' && e.target.form && e.target.form.dataset.form === 'create') ui.createName = e.target.value;
});

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  ui.installPrompt = e;
  if (ui.screen === 'home') render();
});

// ---------- boot ----------
async function loadOptions() {
  for (let attempt = 0; !ui.options; attempt++) {
    try {
      ui.options = await api('GET', '/api/options');
      if (!ui.createConfig) ui.createConfig = { ...ui.options.defaults };
      render();
    } catch {
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 10000)));
    }
  }
}
loadOptions();

(function boot() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{5})$/);
  const s = loadSession();
  if (m) {
    const code = m[1].toUpperCase();
    if (s && s.code === code) return enterGame(s);
    if (!s) { ui.joinCode = code; ui.screen = 'join'; history.replaceState(null, '', '/'); }
    else toast('你已在其他房间中。请先返回或放弃该会话。');
  } else if (s) {
    return enterGame(s); // automatic reconnect after refresh
  }
  render();
})();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
