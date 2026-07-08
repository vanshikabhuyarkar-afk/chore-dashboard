'use strict';

const state = { users: [], chores: [], today: '', config: {}, roster: [] };
const ui = {
  me: localStorage.getItem('me') || '',
  token: localStorage.getItem('token') || '',
  personFilter: 'all',
  statusFilter: 'open',
};

const $ = (sel) => document.querySelector(sel);
const api = async (path, method = 'GET', body) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (ui.token) headers['Authorization'] = 'Bearer ' + ui.token;
  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  // A stale/expired token bounces everyone back to the login screen.
  if (res.status === 401 && path !== '/login') {
    forceLogout();
    throw new Error('Please log in again.');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2800);
}

// ---------- data ----------
async function refresh() {
  const s = await api('/state');
  state.users = s.users;
  state.chores = s.chores;
  state.today = s.today;
  render();
}

// ---------- rendering ----------
function userById(id) {
  return state.users.find((u) => u.id === id);
}

function dueInfo(chore) {
  if (!chore.dueDate) return null;
  if (chore.status === 'done') return { label: chore.dueDate, cls: '' };
  if (chore.dueDate < state.today) return { label: 'Overdue · ' + chore.dueDate, cls: 'due-over' };
  if (chore.dueDate === state.today) return { label: 'Due today', cls: 'due-today' };
  return { label: 'Due ' + chore.dueDate, cls: '' };
}

function visibleChores() {
  return state.chores
    .filter((c) => (ui.personFilter === 'all' ? true : c.assignedTo === ui.personFilter))
    .filter((c) => {
      if (ui.statusFilter === 'all') return true;
      if (ui.statusFilter === 'done') return c.status === 'done';
      return c.status !== 'done';
    })
    .sort((a, b) => {
      // open chores: by due date (nulls last); done: by completedAt desc
      if (a.status !== b.status) return a.status === 'done' ? 1 : -1;
      const ad = a.dueDate || '9999', bd = b.dueDate || '9999';
      return ad.localeCompare(bd);
    });
}

function renderStats() {
  const open = state.chores.filter((c) => c.status !== 'done');
  const overdue = open.filter((c) => c.dueDate && c.dueDate < state.today);
  const done = state.chores.filter((c) => c.status === 'done');
  $('#stats').innerHTML = `
    <div class="stat"><div class="n">${open.length}</div><div class="l">To do</div></div>
    <div class="stat overdue"><div class="n">${overdue.length}</div><div class="l">Overdue</div></div>
    <div class="stat done"><div class="n">${done.length}</div><div class="l">Done</div></div>`;
}

function renderPersonFilters() {
  const el = $('#personFilters');
  const chip = (id, label, color, active) =>
    `<button class="chip ${active ? 'active' : ''}" data-person="${id}">
       ${color ? `<span class="dot" style="background:${color}"></span>` : ''}${label}
     </button>`;
  let html = chip('all', 'Everyone', null, ui.personFilter === 'all');
  for (const u of state.users) html += chip(u.id, esc(u.name), u.color, ui.personFilter === u.id);
  html += `<button class="chip manage" id="managePeople">⚙️ People</button>`;
  el.innerHTML = html;
}

function renderList() {
  const list = visibleChores();
  const el = $('#choreList');
  if (!list.length) {
    el.innerHTML = `<div class="empty">No chores here yet.<br>Tap ＋ to add one.</div>`;
    return;
  }
  el.innerHTML = list
    .map((c) => {
      const u = userById(c.assignedTo);
      const due = dueInfo(c);
      const overdue = c.status !== 'done' && c.dueDate && c.dueDate < state.today;
      return `
      <div class="chore ${c.status === 'done' ? 'done' : ''} ${overdue ? 'overdue' : ''}"
           style="--assignee:${u ? u.color : 'transparent'}">
        <div class="check" data-toggle="${c.id}">✓</div>
        <div class="chore-body">
          <div class="chore-title">${esc(c.title)}</div>
          ${c.notes ? `<div class="chore-notes">${esc(c.notes)}</div>` : ''}
          <div class="chore-meta">
            ${u ? `<span class="tag assignee"><span class="dot" style="background:${u.color}"></span>${esc(u.name)}</span>`
                : `<span class="tag">Unassigned</span>`}
            ${due ? `<span class="tag ${due.cls}">${due.label}</span>` : ''}
            ${c.remindTime && c.status !== 'done' ? `<span class="tag">⏰ ${c.remindTime}</span>` : ''}
            ${c.repeat && c.repeat !== 'none' ? `<span class="tag">${repeatLabel(c)}</span>` : ''}
            ${(c.rotation || []).length > 1 ? `<span class="tag">🔄 rotating</span>` : ''}
          </div>
        </div>
        <div class="chore-actions">
          <button class="iconbtn" data-comment="${c.id}">💬${(c.comments || []).length ? `<span class="badge">${c.comments.length}</span>` : ''}</button>
          <button class="iconbtn" data-edit="${c.id}">✏️</button>
        </div>
      </div>`;
    })
    .join('');
}

function render() {
  renderMeBadge();
  renderStats();
  renderPersonFilters();
  renderList();
}

function renderMeBadge() {
  const me = userById(ui.me);
  $('#meName').textContent = me ? me.name : '';
  $('#meDot').style.background = me ? me.color : 'var(--accent)';
  updateNotifyBtn();
}

function repeatLabel(c) {
  const n = c.repeatEvery || 1;
  const unit = { day: 'day', week: 'week', month: 'month' }[c.repeat] || c.repeat;
  return `🔁 every ${n === 1 ? '' : n + ' '}${unit}${n === 1 ? '' : 's'}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- chore sheet ----------
function openChoreSheet(chore) {
  $('#sheetTitle').textContent = chore ? 'Edit chore' : 'New chore';
  $('#choreId').value = chore ? chore.id : '';
  $('#f-title').value = chore ? chore.title : '';
  $('#f-notes').value = chore ? chore.notes : '';
  $('#f-dueDate').value = chore ? chore.dueDate || '' : '';
  $('#f-remindTime').value = chore ? chore.remindTime || '' : '';
  $('#f-repeat').value = chore ? chore.repeat || 'none' : 'none';
  $('#f-repeatEvery').value = chore && chore.repeatEvery ? chore.repeatEvery : 3;
  const assignSel = $('#f-assignedTo');
  assignSel.innerHTML =
    `<option value="">Unassigned</option>` +
    state.users.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  assignSel.value = chore ? chore.assignedTo || '' : (ui.me || '');

  // rotation checkboxes
  const rotation = chore?.rotation || [];
  $('#rotatePeople').innerHTML = state.users
    .map(
      (u) => `<label><input type="checkbox" class="rot" value="${u.id}" ${rotation.includes(u.id) ? 'checked' : ''}/>
        <span class="dot" style="background:${u.color}"></span>${esc(u.name)}</label>`
    )
    .join('');
  syncRepeatUI();

  $('#deleteChore').hidden = !chore;
  $('#choreSheet').hidden = false;
}

// Show/hide the "how many" and rotation controls based on the repeat choice.
function syncRepeatUI() {
  const repeats = $('#f-repeat').value !== 'none';
  $('#everyWrap').hidden = !repeats;
  $('#rotateWrap').hidden = !repeats;
}
function closeChoreSheet() { $('#choreSheet').hidden = true; }

async function submitChore(e) {
  e.preventDefault();
  const id = $('#choreId').value;
  const payload = {
    title: $('#f-title').value,
    notes: $('#f-notes').value,
    assignedTo: $('#f-assignedTo').value || null,
    dueDate: $('#f-dueDate').value || null,
    remindTime: $('#f-remindTime').value || null,
    repeat: $('#f-repeat').value,
    repeatEvery: parseInt($('#f-repeatEvery').value, 10) || 1,
    rotation: [...document.querySelectorAll('.rot:checked')].map((c) => c.value),
    actingUserId: ui.me || null,
  };
  if (!payload.title.trim()) return;
  try {
    if (id) await api('/chores/' + id, 'PATCH', payload);
    else await api('/chores', 'POST', payload);
    closeChoreSheet();
    await refresh();
    toast(id ? 'Chore updated' : 'Chore added');
  } catch (err) { toast('Error: ' + err.message); }
}

async function toggleDone(id) {
  const c = state.chores.find((x) => x.id === id);
  if (!c) return;
  const wasDone = c.status === 'done';
  const next = wasDone ? 'todo' : 'done';
  try {
    const updated = await api('/chores/' + id, 'PATCH', { status: next, actingUserId: ui.me || null });
    await refresh();
    if (wasDone) {
      toast('Reopened');
    } else if (updated.status === 'todo' && updated.repeat && updated.repeat !== 'none') {
      // recurring chore rolled forward instead of finishing
      const who = userById(updated.assignedTo);
      toast(`✅ Done! Next: ${updated.dueDate}${who ? ' · ' + who.name : ''}`);
    } else {
      toast('✅ Marked done');
    }
  } catch (err) { toast('Error: ' + err.message); }
}

async function deleteChore() {
  const id = $('#choreId').value;
  if (!id) return;
  await api('/chores/' + id, 'DELETE');
  closeChoreSheet();
  await refresh();
  toast('Chore deleted');
}

// ---------- comments / chat ----------
let activeCommentChore = null;

function openComments(choreId) {
  activeCommentChore = choreId;
  renderComments();
  $('#commentSheet').hidden = false;
  setTimeout(() => $('#c-text').focus(), 50);
}
function closeComments() { activeCommentChore = null; $('#commentSheet').hidden = true; }

function renderComments() {
  const chore = state.chores.find((c) => c.id === activeCommentChore);
  if (!chore) return closeComments();
  $('#commentTitle').textContent = '💬 ' + chore.title;
  const list = $('#commentList');
  const comments = chore.comments || [];
  if (!comments.length) {
    list.innerHTML = `<div class="empty small">No messages yet. Start the conversation.</div>`;
  } else {
    list.innerHTML = comments
      .map((m) => {
        const u = userById(m.userId);
        const mine = m.userId && m.userId === ui.me;
        return `<div class="msg ${mine ? 'mine' : ''}">
          <div class="msg-meta"><span class="dot" style="background:${u ? u.color : '#888'}"></span>${esc(u ? u.name : 'Someone')} · ${timeAgo(m.at)}</div>
          <div class="msg-text">${esc(m.text)}</div>
        </div>`;
      })
      .join('');
  }
  list.scrollTop = list.scrollHeight;
}

async function postComment(e) {
  e.preventDefault();
  const text = $('#c-text').value.trim();
  if (!text || !activeCommentChore) return;
  if (!ui.me) return toast('Pick who you are (top right) to chat.');
  try {
    await api('/chores/' + activeCommentChore + '/comments', 'POST', { userId: ui.me, text });
    $('#c-text').value = '';
    await refresh();
    renderComments();
  } catch (err) { toast('Error: ' + err.message); }
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleDateString();
}

// ---------- people ----------
function renderPeople() {
  $('#peopleList').innerHTML = state.users.length
    ? state.users
        .map(
          (u) => `<li>
            <span class="dot" style="background:${u.color}"></span>
            <span class="name">${esc(u.name)}</span>
            <span class="l" style="color:var(--muted);font-size:.75rem">${u.devices || 0} 📱</span>
            <button class="rm" data-rm="${u.id}">✕</button>
          </li>`
        )
        .join('')
    : `<li style="color:var(--muted);background:none;justify-content:center">No one yet — add your family below.</li>`;
}
function openPeople() { renderPeople(); $('#peopleSheet').hidden = false; }
function closePeople() { $('#peopleSheet').hidden = true; }

async function addPerson(e) {
  e.preventDefault();
  const name = $('#p-name').value.trim();
  if (!name) return;
  await api('/users', 'POST', { name, color: $('#p-color').value });
  $('#p-name').value = '';
  await refresh();
  renderPeople();
}
async function removePerson(id) {
  await api('/users/' + id, 'DELETE');
  if (ui.me === id) { ui.me = ''; localStorage.removeItem('me'); }
  await refresh();
  renderPeople();
}

// ---------- notifications ----------
function updateNotifyBtn() {
  const btn = $('#notifyBtn');
  const enabled = 'Notification' in window && Notification.permission === 'granted' && ui.me;
  btn.classList.toggle('on', !!enabled);
  btn.title = ui.me ? 'Enable notifications for you' : 'Pick who you are first';
}

async function enableNotifications() {
  if (!ui.me) return toast('First pick who you are (top right).');
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    return toast('This browser does not support push notifications.');
  if (!state.config.pushConfigured) return toast('Push not configured on the server.');

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications blocked. Enable them in browser settings.');

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(state.config.vapidPublicKey),
      }));
    await api('/subscribe', 'POST', { userId: ui.me, subscription: sub.toJSON() });
    updateNotifyBtn();
    toast('Notifications on for ' + (userById(ui.me)?.name || 'you'));
    await api('/test-notification', 'POST', { userId: ui.me });
  } catch (err) {
    toast('Could not enable: ' + err.message);
  }
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ---------- auth / login ----------
let pendingLogin = null; // the person chosen on the login screen, awaiting their PIN

async function loadRoster() {
  state.roster = await api('/roster');
}

function clearSession() {
  ui.token = '';
  ui.me = '';
  localStorage.removeItem('token');
  localStorage.removeItem('me');
}

// Called when a token turns out to be invalid mid-session.
function forceLogout() {
  clearSession();
  showLogin();
}

async function logout() {
  clearSession();
  $('#meMenu').hidden = true;
  await loadRoster().catch(() => {});
  showLogin();
}

function showApp() {
  $('#loginScreen').hidden = true;
  $('#whoami').hidden = false;
}

function showLogin() {
  $('#whoami').hidden = true;
  $('#loginScreen').hidden = false;
  showPickStep();
  renderLoginPeople();
}

function renderLoginPeople() {
  const el = $('#loginPeople');
  const people = state.roster;
  if (!people.length) {
    el.innerHTML = `<p class="pin-hint">No one here yet — add the first person to get started.</p>`;
    $('#loginAddPerson').hidden = true;
    $('#loginAddForm').hidden = false;
    return;
  }
  el.innerHTML = people
    .map(
      (u) => `<button type="button" class="login-person" data-login="${u.id}">
        <span class="dot" style="background:${u.color}"></span>
        <span class="name">${esc(u.name)}</span>
        <span class="status">${u.hasPin ? 'Enter PIN' : 'Set a PIN'}</span>
      </button>`
    )
    .join('');
  // Adding people from the login screen is only for the empty/bootstrap case;
  // afterwards new members are added from inside the app (People sheet).
  $('#loginAddPerson').hidden = true;
  $('#loginAddForm').hidden = true;
}

function showPickStep() {
  pendingLogin = null;
  $('#pickStep').hidden = false;
  $('#pinForm').hidden = true;
  $('#pinInput').value = '';
  clearPinHint();
}

function clearPinHint() {
  $('#pinHint').textContent = '';
  $('#pinHint').classList.remove('error');
}
function pinError(msg) {
  $('#pinHint').textContent = msg;
  $('#pinHint').classList.add('error');
}

function selectLoginPerson(id) {
  const u = state.roster.find((p) => p.id === id);
  if (!u) return;
  pendingLogin = u;
  $('#pickStep').hidden = true;
  $('#pinForm').hidden = false;
  $('#pinName').textContent = u.name;
  $('#pinDot').style.background = u.color;
  $('#pinPrompt').textContent = u.hasPin ? 'Enter your PIN' : 'Create a PIN';
  $('#pinInput').value = '';
  clearPinHint();
  if (!u.hasPin) $('#pinHint').textContent = "Pick 4–8 numbers you'll remember.";
  setTimeout(() => $('#pinInput').focus(), 60);
}

async function submitPin(e) {
  e.preventDefault();
  if (!pendingLogin) return;
  const pin = $('#pinInput').value.trim();
  if (!/^\d{4,8}$/.test(pin)) return pinError('PIN must be 4–8 numbers.');
  try {
    const { token, userId } = await api('/login', 'POST', { userId: pendingLogin.id, pin });
    ui.token = token;
    ui.me = userId;
    localStorage.setItem('token', token);
    localStorage.setItem('me', userId);
    showApp();
    await refresh();
    toast('Welcome, ' + (userById(ui.me)?.name || 'you') + ' 👋');
  } catch (err) {
    pinError(err.message || 'Login failed.');
    $('#pinInput').select();
  }
}

async function loginAddPerson(e) {
  e.preventDefault();
  const name = $('#login-add-name').value.trim();
  if (!name) return;
  try {
    await api('/users', 'POST', { name, color: $('#login-add-color').value });
    $('#login-add-name').value = '';
    await loadRoster();
    renderLoginPeople();
  } catch (err) {
    toast('Error: ' + err.message);
  }
}

// ---------- wiring ----------
function init() {
  document.body.addEventListener('click', (e) => {
    const hit = (attr) => e.target.closest('[data-' + attr + ']');
    const toggleEl = hit('toggle'), editEl = hit('edit'), commentEl = hit('comment'),
          personEl = hit('person'), rmEl = hit('rm');
    if (toggleEl) toggleDone(toggleEl.dataset.toggle);
    else if (commentEl) openComments(commentEl.dataset.comment);
    else if (editEl) openChoreSheet(state.chores.find((c) => c.id === editEl.dataset.edit));
    else if (personEl) { ui.personFilter = personEl.dataset.person; renderPersonFilters(); renderList(); }
    else if (e.target.id === 'managePeople') openPeople();
    else if (rmEl) removePerson(rmEl.dataset.rm);
  });

  $('#statusFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ui.statusFilter = b.dataset.status;
    [...$('#statusFilter').children].forEach((x) => x.classList.toggle('active', x === b));
    renderList();
  });

  // Login screen
  $('#loginPeople').addEventListener('click', (e) => {
    const b = e.target.closest('[data-login]');
    if (b) selectLoginPerson(b.dataset.login);
  });
  $('#pinForm').addEventListener('submit', submitPin);
  $('#pinBack').addEventListener('click', showPickStep);
  $('#pinInput').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });
  $('#loginAddForm').addEventListener('submit', loginAddPerson);

  // Logged-in badge menu (top right)
  $('#meBadge').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#meMenu').hidden = !$('#meMenu').hidden;
  });
  $('#logoutBtn').addEventListener('click', logout);
  document.addEventListener('click', () => { $('#meMenu').hidden = true; });

  $('#notifyBtn').addEventListener('click', enableNotifications);
  $('#addBtn').addEventListener('click', () => openChoreSheet(null));
  $('#choreForm').addEventListener('submit', submitChore);
  $('#f-repeat').addEventListener('change', syncRepeatUI);
  $('#cancelChore').addEventListener('click', closeChoreSheet);
  $('#deleteChore').addEventListener('click', deleteChore);
  $('#choreSheet').addEventListener('click', (e) => { if (e.target.id === 'choreSheet') closeChoreSheet(); });

  $('#commentForm').addEventListener('submit', postComment);
  $('#closeComments').addEventListener('click', closeComments);
  $('#commentSheet').addEventListener('click', (e) => { if (e.target.id === 'commentSheet') closeComments(); });

  $('#personForm').addEventListener('submit', addPerson);
  $('#closePeople').addEventListener('click', closePeople);
  $('#peopleSheet').addEventListener('click', (e) => { if (e.target.id === 'peopleSheet') closePeople(); });

  boot();
}

async function boot() {
  try {
    state.config = await api('/config');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    await loadRoster();
    if (ui.token) {
      try {
        await refresh(); // token still good → straight into the app
        showApp();
        return;
      } catch (_) {
        clearSession(); // token no longer valid → fall through to the login screen
      }
    }
    showLogin();
  } catch (err) {
    toast('Could not load: ' + err.message);
  }
}

init();
