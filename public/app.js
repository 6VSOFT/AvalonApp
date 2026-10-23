'use strict';
// Avalon client. It holds no game logic that matters for fairness: every action
// is sent to the server, which validates it and pushes back this player's view.

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $toast = document.getElementById('toast');
const $net = document.getElementById('net');
const SESSION_KEY = 'avalon.session';

const ui = {
  screen: 'home', // home | create | join | game
  joinCode: '',
  state: null,
  selection: [],
  target: null,
  showSecret: false,
  busy: false,
  connected: false,
  es: null,
  lastGameNo: null,
  installPrompt: null,
};

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
    if (type === 'leave') { leaveToHome(); return; }
    if (r.state) applyState(r.state);
  } catch (e) {
    toast(e.message);
    if (e.status === 401 || e.status === 404) { leaveToHome(); return; }
  } finally {
    ui.busy = false;
    render();
  }
}

// ---------- realtime connection ----------
function connect() {
  const s = loadSession();
  if (!s) return;
  if (ui.es) ui.es.close();
  const es = new EventSource(`/api/rooms/${s.code}/events?token=${encodeURIComponent(s.token)}`);
  ui.es = es;
  es.addEventListener('state', ev => {
    ui.connected = true;
    updateNet();
    applyState(JSON.parse(ev.data));
    render();
  });
  es.addEventListener('kicked', () => { es.close(); leaveToHome(); });
  es.onopen = () => { ui.connected = true; updateNet(); };
  es.onerror = async () => {
    ui.connected = false;
    updateNet();
    // If the session is no longer valid (room expired), stop retrying.
    try {
      await api('GET', `/api/rooms/${s.code}/state`, null, s.token);
    } catch (e) {
      if (e.status === 401 || e.status === 404) { es.close(); toast('房间已失效'); leaveToHome(); }
    }
  };
}
function updateNet() {
  const offline = !navigator.onLine || (ui.screen === 'game' && !ui.connected);
  $net.textContent = !navigator.onLine ? '⚠ 网络已断开 — 操作不会被提交' : '⚠ 与服务器断开，正在重新连接…';
  $net.classList.toggle('hidden', !offline);
}
window.addEventListener('online', () => { updateNet(); if (ui.screen === 'game') connect(); });
window.addEventListener('offline', updateNet);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && ui.screen === 'game' && (!ui.es || ui.es.readyState === 2)) connect();
});

function applyState(st) {
  const prev = ui.state;
  if (prev && (prev.phase !== st.phase || prev.round !== st.round || prev.gameNo !== st.gameNo)) {
    ui.selection = [];
    ui.target = null;
  }
  if (st.gameNo !== ui.lastGameNo) { ui.showSecret = false; ui.lastGameNo = st.gameNo; }
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
  if (ui.es) ui.es.close();
  ui.es = null;
  clearSession();
  ui.state = null;
  ui.screen = 'home';
  ui.connected = false;
  updateNet();
  render();
}

// ---------- views ----------
function render() {
  $app.innerHTML = ({ home: viewHome, create: viewCreate, join: viewJoin, game: viewGame })[ui.screen]();
  updateNet();
}

function viewHome() {
  const s = loadSession();
  return `
    <h1>AVALON</h1>
    <p class="center muted" style="margin-bottom:28px">阿瓦隆 · 6 人局 · 无需法官</p>
    ${s ? `<div class="card gold stack"><p>你在房间 <b>${esc(s.code)}</b> 有一个进行中的会话。</p>
      <button data-a="resume">返回房间</button><button class="ghost" data-a="forget">放弃该会话</button></div>` : ''}
    <div class="stack">
      <button data-a="go-create" ${s ? 'disabled' : ''}>创建房间</button>
      <button class="secondary" data-a="go-join" ${s ? 'disabled' : ''}>加入房间</button>
      <button class="ghost" data-a="rules">游戏规则</button>
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
  return `
    <div class="topbar"><button class="small ghost" data-a="home">← 返回</button></div>
    <h2>创建房间</h2>
    <form class="card stack" data-form="create">
      <div><label>你的昵称</label><input name="name" maxlength="12" autocomplete="nickname" required autofocus></div>
      <button type="submit" ${ui.busy ? 'disabled' : ''}>创建 6 人房间</button>
    </form>
    <p class="muted">创建者也是 6 名玩家之一，只负责建房和开始游戏，不是法官，无法看到他人身份。</p>`;
}

function viewJoin() {
  return `
    <div class="topbar"><button class="small ghost" data-a="home">← 返回</button></div>
    <h2>加入房间</h2>
    <form class="card stack" data-form="join">
      <div><label>房间代码</label><input class="code" name="code" maxlength="5" value="${esc(ui.joinCode)}" autocomplete="off" autocapitalize="characters" required></div>
      <div><label>你的昵称</label><input name="name" maxlength="12" autocomplete="nickname" required ${ui.joinCode ? 'autofocus' : ''}></div>
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
  if (st.status === 'lobby') return top + viewLobby(st);
  if (st.status === 'ended') return top + viewEnded(st);
  return top + viewBoard(st) + viewPhase(st) + viewHistory(st);
}

const nameOf = (st, id) => (st.players.find(p => p.id === id) || {}).name || '?';

function viewLobby(st) {
  const me = st.players.find(p => p.id === st.me.id);
  const full = st.players.length === 6;
  const allReady = full && st.players.every(p => p.ready);
  const link = `${location.origin}/r/${st.code}`;
  const rows = st.players.map(p => `<li><span class="dot ${p.online ? 'on' : ''}"></span>
      <span class="name">${esc(p.name)}${p.id === st.me.id ? '（你）' : ''}</span>
      ${p.id === st.hostId ? '<span class="badge gold">房主</span>' : ''}
      <span class="badge ${p.ready ? 'ok' : ''}">${p.ready ? '已准备' : '未准备'}</span></li>`).join('');
  const empty = Array.from({ length: 6 - st.players.length }, () => '<li><span class="name muted">等待玩家加入…</span></li>').join('');
  return `
    <div class="card center">
      <div class="muted">房间代码</div>
      <div class="bigcode">${esc(st.code)}</div>
      <img class="qr" alt="加入二维码" src="/api/rooms/${esc(st.code)}/qr.svg?origin=${encodeURIComponent(location.origin)}">
      <p class="muted" style="word-break:break-all">${esc(link)}</p>
      <button class="small ghost" data-a="share">复制/分享链接</button>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:10px"><h3 class="grow" style="margin:0">玩家</h3><b>${st.players.length}/6</b></div>
      <ul class="players">${rows}${empty}</ul>
    </div>
    <div class="stack">
      <button class="${me.ready ? 'ghost' : 'ok'}" data-a="ready" ${ui.busy ? 'disabled' : ''}>${me.ready ? '取消准备' : '我准备好了'}</button>
      ${st.me.isHost ? `<button data-a="start" ${allReady && !ui.busy ? '' : 'disabled'}>开始游戏</button>
        <p class="muted center">${!full ? '需要 6 名玩家才能开始' : allReady ? '所有人已准备' : '等待所有玩家准备'}</p>`
        : '<p class="muted center">等待房主开始游戏</p>'}
      <button class="ghost" data-a="leave" ${ui.busy ? 'disabled' : ''}>离开房间</button>
    </div>`;
}

function viewBoard(st) {
  const missions = st.missionSizes.map((size, i) => {
    const r = st.history[i].result;
    const cls = r ? (r.success ? 'ok' : 'bad') : (i + 1 === st.round && st.phase !== 'assassin' ? 'current' : '');
    return `<div class="mission ${cls}" title="第 ${i + 1} 轮">${r ? (r.success ? '✓' : '✗') : size}</div>`;
  }).join('');
  const rejects = Array.from({ length: 5 }, (_, i) => `<span class="r ${i < st.rejects ? 'on' : ''}"></span>`).join('');
  return `<div class="card">
    <div class="score"><div class="g"><b>${st.successes}</b>任务成功</div><div><b>${st.round}</b>当前轮次</div><div class="e"><b>${st.fails}</b>任务失败</div></div>
    <div class="track">${missions}</div>
    <div class="rejects">连续否决 ${rejects} <span>${st.rejects}/5</span></div>
  </div>`;
}

function secretCard(st) {
  const s = st.secret;
  if (!ui.showSecret) {
    return `<div class="cover" data-a="toggle-secret"><div style="font-size:40px">🂠</div><b>点击查看你的身份</b><p class="muted">请确认旁人看不到你的屏幕</p></div>`;
  }
  return `<div class="card secret ${s.team}" data-a="toggle-secret">
    <div class="badge ${s.team}">${s.team === 'good' ? '好人阵营' : '坏人阵营'}</div>
    <div class="role">${esc(s.roleName)}</div>
    <p>${esc(s.desc)}</p>
    ${s.knowsLabel ? `<p class="muted" style="margin-top:10px">${esc(s.knowsLabel)}：</p><ul>${s.knows.map(k => `<li>${esc(k.name)}</li>`).join('')}</ul>` : '<p class="muted">你不知道任何人的身份。</p>'}
    <p class="muted" style="margin-top:12px">点击隐藏</p>
  </div>`;
}

function playerList(st, opts = {}) {
  return `<ul class="players">${st.players.map((p, i) => {
    const sel = opts.selectable && opts.selected.includes(p.id);
    const badges = [];
    if (p.id === st.leaderId) badges.push('<span class="badge gold">👑 队长</span>');
    if (opts.showTeam && st.team.includes(p.id)) badges.push('<span class="badge good">队员</span>');
    if (opts.voted) badges.push(opts.voted.includes(p.id) ? '<span class="badge ok">已投票</span>' : '<span class="badge">未投票</span>');
    if (opts.acked) badges.push(opts.acked.includes(p.id) ? '<span class="badge ok">已确认</span>' : '<span class="badge">查看中</span>');
    const disabled = opts.disabledId === p.id;
    return `<li class="${opts.selectable && !disabled ? 'selectable' : ''} ${sel ? 'selected' : ''}" ${opts.selectable && !disabled ? `data-a="${opts.action}" data-id="${esc(p.id)}"` : ''} style="${disabled ? 'opacity:.4' : ''}">
      <span class="seat">${i + 1}</span><span class="dot ${p.online ? 'on' : ''}"></span>
      <span class="name">${esc(p.name)}${p.id === st.me.id ? '（你）' : ''}</span>${badges.join('')}</li>`;
  }).join('')}</ul>`;
}

// Latest public announcement (vote or mission result), shown at the top of the phase panel.
function lastNotice(st) {
  const cur = st.history[st.round - 1];
  const att = cur.attempts[cur.attempts.length - 1];
  if (st.phase === 'mission' && att) {
    return `<div class="notice ok">组队通过：赞成 ${att.approve} · 反对 ${att.reject}</div>`;
  }
  if (st.phase === 'team' && att && !att.passed) {
    return `<div class="notice bad">上次组队被否决：赞成 ${att.approve} · 反对 ${att.reject}<br>队长移交给 <b>${esc(nameOf(st, st.leaderId))}</b></div>`;
  }
  const prev = st.phase === 'assassin' ? cur : (st.round > 1 && cur.attempts.length === 0 ? st.history[st.round - 2] : null);
  if (prev && prev.result) {
    const r = prev.result;
    return `<div class="notice ${r.success ? 'ok' : 'bad'}">
      <b>第 ${prev.round} 轮任务${r.success ? '成功' : '失败'}</b><br>
      队员：${r.team.map(id => esc(nameOf(st, id))).join('、')}<br>
      成功牌 ${r.successCards} · 失败牌 ${r.failCards}<br>
      当前比分：成功 ${st.successes} · 失败 ${st.fails}<br>
      ${st.phase === 'assassin' ? '好人已完成三次任务，进入刺杀阶段。' : `下一位队长：<b>${esc(nameOf(st, st.leaderId))}</b>`}
    </div>`;
  }
  return '';
}

function viewPhase(st) {
  const me = st.me.id;
  const leader = nameOf(st, st.leaderId);
  const busy = ui.busy ? 'disabled' : '';
  let body = '';
  switch (st.phase) {
    case 'reveal': {
      const done = st.acked.includes(me);
      body = `<div class="phase">身份确认</div><h2>查看你的秘密身份</h2>
        ${secretCard(st)}
        ${done ? '<p class="center">✓ 你已确认，等待其他玩家…</p>' : `<button data-a="ack" ${busy}>我已记住身份</button>`}
        <p class="muted center" style="margin-top:8px">已确认 ${st.acked.length}/6</p>
        ${playerList(st, { acked: st.acked })}`;
      break;
    }
    case 'team': {
      if (st.leaderId === me) {
        const n = ui.selection.length;
        body = `<div class="phase">第 ${st.round} 轮 · 组队</div><h2>你是队长：选择 ${st.teamSize} 名队员</h2>
          <p class="muted">可以选择自己。已选 ${n}/${st.teamSize}</p>
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
        <p>队长 <b>${esc(leader)}</b> 提名：${st.team.map(id => `<span class="badge good">${esc(nameOf(st, id))}</span>`).join(' ')}</p>
        <p class="muted">需要至少 4 票赞成才能通过。投票在全员投完前保密。</p>
        ${voted ? `<div class="notice">你已投票：<b>${st.myVote ? '赞成 ✓' : '反对 ✗'}</b>，等待其他玩家…</div>`
          : `<div class="grid2"><button class="ok" data-a="vote" data-v="1" ${busy}>赞成</button><button class="bad" data-a="vote" data-v="0" ${busy}>反对</button></div>`}
        <p class="muted center" style="margin-top:8px">已投票 ${st.votedIds.length}/6</p>
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
        <p>队员：${st.team.map(id => `<span class="badge good">${esc(nameOf(st, id))}</span>`).join(' ')}</p>
        ${action}
        <p class="muted center" style="margin-top:8px">已提交 ${st.submittedCount}/${st.team.length}</p>`;
      break;
    }
    case 'assassin': {
      if (st.secret.role === 'assassin') {
        body = `<div class="phase">刺杀阶段</div><h2>选择你认为是梅林的玩家</h2>
          <p class="muted">确认后不可撤销。猜中梅林则坏人获胜。</p>
          ${playerList(st, { selectable: true, selected: ui.target ? [ui.target] : [], action: 'target', disabledId: me })}
          <button class="bad" data-a="assassinate" ${ui.target && !ui.busy ? '' : 'disabled'}>${ui.target ? `刺杀 ${esc(nameOf(st, ui.target))}` : '请选择目标'}</button>`;
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
    const atts = h.attempts.map((a, i) => `<div>#${i + 1} ${esc(nameOf(st, a.leader))}：${a.team.map(id => esc(nameOf(st, id))).join('、')}
      <span class="badge ${a.passed ? 'ok' : 'bad'}">${a.approve}:${a.reject}</span></div>`).join('');
    const res = h.result ? `<span class="badge ${h.result.success ? 'ok' : 'bad'}">${h.result.success ? '成功' : '失败'} ${h.result.successCards}✓ ${h.result.failCards}✗</span>` : '<span class="badge">进行中</span>';
    return `<tr><td>第${h.round}轮<br><span class="muted">${h.size}人</span></td><td>${atts}</td><td>${res}</td></tr>`;
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
    ${a ? `<div class="card"><h3>刺杀结果</h3><p>刺客选择了 <b>${esc(nameOf(st, a.target))}</b> —— ${a.hit ? '正是梅林！' : '不是梅林。'}</p></div>` : ''}
    <div class="card"><h3>身份揭晓</h3><ul class="players">${st.reveal.map(r => `<li><span class="name">${esc(r.name)}${r.id === st.me.id ? '（你）' : ''}</span>
      <span class="badge ${r.team}">${esc(r.roleName)}</span></li>`).join('')}</ul></div>
    <div class="card"><div class="score"><div class="g"><b>${st.successes}</b>成功任务</div><div class="e"><b>${st.fails}</b>失败任务</div></div>
      <table class="history"><tr><th>轮次</th><th>提名与投票</th><th>结果</th></tr>${historyRows(st)}</table></div>
    <div class="stack">
      ${st.me.isHost ? `<button data-a="restart" ${ui.busy ? 'disabled' : ''}>重新开始（重新分配身份）</button>` : '<p class="muted center">等待房主重新开始</p>'}
      <button class="ghost" data-a="exit">返回首页</button>
    </div>`;
}

function rulesModal() {
  $modal.innerHTML = `<div class="card rules">
    <h2>游戏规则（6 人局）</h2>
    <h3>角色</h3>
    <ul><li>好人 4：梅林 ×1、亚瑟的忠臣 ×3</li><li>坏人 2：刺客 ×1、莫德雷德爪牙 ×1</li>
    <li>梅林知道两名坏人；两名坏人互相认识；忠臣不知道任何人。</li></ul>
    <h3>流程</h3>
    <ul><li>每轮队长提名队员：第1–5轮分别为 2、3、4、3、4 人。</li>
    <li>全部 6 人投票，至少 4 票赞成才通过；否决则队长顺时针移交。连续 5 次否决，坏人获胜。</li>
    <li>队员秘密提交任务牌。好人只能出成功；坏人可出成功或失败。任意 1 张失败牌即任务失败。</li>
    <li>3 次任务失败：坏人获胜。</li>
    <li>3 次任务成功：刺客刺杀梅林。猜中则坏人获胜，否则好人获胜。</li></ul>
    <h3>注意</h3>
    <ul><li>每人使用自己的手机，不要给他人看你的身份。</li><li>讨论在现实中面对面进行。</li></ul>
    <button style="margin-top:14px" data-a="close-modal">知道了</button></div>`;
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
    case 'go-create': ui.screen = 'create'; render(); break;
    case 'go-join': ui.screen = 'join'; render(); break;
    case 'home': ui.screen = 'home'; render(); break;
    case 'rules': rulesModal(); break;
    case 'close-modal': $modal.classList.add('hidden'); $modal._redraw = null; ui.showSecret = false; render(); break;
    case 'secret': secretModal(); break;
    case 'toggle-secret':
      ui.showSecret = !ui.showSecret;
      if ($modal._redraw && !$modal.classList.contains('hidden')) $modal._redraw(); else render();
      break;
    case 'resume': enterGame(loadSession()); break;
    case 'forget':
      if (confirm('放弃后将无法以该玩家身份回到房间。确定吗？')) { clearSession(); render(); }
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
    case 'ready': act('ready', { value: !st.players.find(p => p.id === st.me.id).ready }); break;
    case 'start': act('start'); break;
    case 'leave': if (confirm('确定离开房间？')) act('leave'); break;
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
      if (confirm(`确认投「${approve ? '赞成' : '反对'}」？提交后不可更改。`)) act('vote', { approve });
      break;
    }
    case 'card': {
      const card = el.dataset.v;
      if (confirm(`确认提交「${card === 'success' ? '成功' : '失败'}」牌？提交后不可更改。`)) act('mission', { card });
      break;
    }
    case 'target': ui.target = el.dataset.id; render(); break;
    case 'assassinate':
      if (ui.target && confirm(`确认刺杀 ${nameOf(st, ui.target)}？此操作不可撤销。`)) act('assassinate', { target: ui.target });
      break;
    case 'restart': if (confirm('重新开始将重新随机分配所有身份，确定吗？')) act('restart'); break;
    case 'exit': leaveToHome(); break;
  }
});

document.addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.form;
  const name = form.name.value.trim();
  if (!name) return toast('请输入昵称');
  ui.busy = true;
  form.querySelector('button').disabled = true;
  try {
    if (kind === 'create') {
      const r = await api('POST', '/api/rooms', { name });
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

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  ui.installPrompt = e;
  if (ui.screen === 'home') render();
});

// ---------- boot ----------
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
