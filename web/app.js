const SUPABASE_URL = 'https://msfiisubbdeyiwwphdub.supabase.co';
const SUPABASE_KEY = 'sb_publishable_AWQXVLy4kAgXjpK8gvs8VQ_hA6obdSZ';
const API = `${SUPABASE_URL}/rest/v1`;

const CATS = [
  { id: 'sight', label: '景点', color: '#2f7d68' },
  { id: 'food', label: '吃饭', color: '#d9694a' },
  { id: 'stay', label: '住宿', color: '#6d5bb7' },
  { id: 'move', label: '交通', color: '#35709f' },
  { id: 'shop', label: '购物', color: '#c08a17' },
  { id: 'other', label: '其他', color: '#7b8a85' }
];

const LS = { nick: 'tripmap.nick', trip: 'tripmap.trip', recent: 'tripmap.recent' };
const CODE_RE = /^[A-Z0-9]{6,12}$/;
const SYNC_MS = 6000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  let code = '';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

const state = {
  me: store.get(LS.nick, ''),
  trip: null,
  points: [],
  comments: [],
  day: 0,
  tab: 'points',
  openPointId: null,
  draft: null,
  dirty: false,
  signature: '',
  justAddedId: null
};

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const el2 = el;
const catOf = id => CATS.find(c => c.id === id) || CATS[CATS.length - 1];
const dayLabel = d => d > 0 ? 'D' + d : '待定';
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

let toastTimer;
function toast(text, bad) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', !!bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/* ---------- api (Supabase) ---------- */

const ERRORS = {
  trip_not_found: '找不到这趟行程，邀请码可能填错了',
  invalid_input: '内容有点问题，检查一下再试',
  not_found: '这条内容已经被别人删掉了',
  payload_too_large: '内容太长了，精简一下'
};

const supabaseHeaders = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation'
};

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method: options.method || 'GET',
      headers: { ...supabaseHeaders, ...(options.headers || {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch {
    throw new Error('连不上服务器，检查一下网络');
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const code = data && data.error ? data.error.code : 'request_failed';
    const err = new Error(ERRORS[code] || ('请求没成功（' + code + '）'));
    err.code = code;
    throw err;
  }
  return data;
}

// Supabase-specific API helpers
async function apiGet(table, params = {}) {
  const query = new URLSearchParams();
  query.set('select', '*');
  for (const [key, value] of Object.entries(params)) {
    query.set(key, value);
  }
  const res = await fetch(`${API}/${table}?${query.toString()}`, {
    headers: supabaseHeaders
  });
  if (!res.ok) throw new Error('请求失败');
  return await res.json();
}

async function apiInsert(table, row) {
  const res = await fetch(`${API}/${table}`, {
    method: 'POST',
    headers: supabaseHeaders,
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error('请求失败');
  return await res.json();
}

async function apiUpdate(table, filter, patch) {
  const res = await fetch(`${API}/${table}?${filter}`, {
    method: 'PATCH',
    headers: supabaseHeaders,
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error('请求失败');
  return await res.json();
}

async function apiDelete(table, filter) {
  const res = await fetch(`${API}/${table}?${filter}`, {
    method: 'DELETE',
    headers: supabaseHeaders
  });
  if (!res.ok) throw new Error('请求失败');
  return await res.json();
}

/* ---------- map (MapLibre GL) ---------- */

let map = null;
const markers = new Map();

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/bright',
    center: [139.767, 35.681],
    zoom: 13
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-right');

  map.on('click', e => {
    if (!state.trip) return;
    openPoint(null, { lat: e.lngLat.lat, lng: e.lngLat.lng });
  });

  map.on('load', () => {
    map.resize();
  });

  const mapContainer = $('map');
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      if (map) map.resize();
    });
    ro.observe(mapContainer);
  }

  setTimeout(() => {
    if (map) map.resize();
  }, 500);

  setTimeout(() => $('mapTip').classList.add('hide'), 7000);
}

function createMarkerEl(point, commentCount) {
  const color = catOf(point.category).color;
  const div = document.createElement('div');
  div.className = 'pin' + (point.id === state.justAddedId ? ' fresh' : '');
  div.innerHTML = `<svg width="26" height="34" viewBox="0 0 26 34"><path d="M13 33C13 33 24 20.6 24 12.6A11 11 0 1 0 2 12.6C2 20.6 13 33 13 33Z" fill="${color}"/><circle cx="13" cy="12.5" r="4.6" fill="#fff" opacity=".92"/></svg>${commentCount > 0 ? `<span class="pin-badge">${commentCount}</span>` : ''}`;
  return div;
}

function commentsOf(pointId) {
  return state.comments.filter(c => c.point_id === pointId);
}

function visiblePoints() {
  const list = state.day === 0 ? state.points : state.points.filter(p => p.day === state.day);
  return list.slice().sort((a, b) => (a.day - b.day) || (a.created_at < b.created_at ? -1 : 1));
}

function renderMarkers() {
  const visible = visiblePoints();
  const ids = new Set(visible.map(p => p.id));
  for (const [id, marker] of markers) {
    if (!ids.has(id)) { marker.remove(); markers.delete(id); }
  }
  for (const point of visible) {
    let marker = markers.get(point.id);
    if (!marker) {
      const el = createMarkerEl(point, commentsOf(point.id).length);
      const info = el2('div', 'marker-popup');
      info.appendChild(el2('b', 'mp-name', point.title || '未命名'));
      if (point.cost) info.appendChild(el2('span', 'mp-cost', '¥' + point.cost));
      if (point.note) info.appendChild(el2('span', 'mp-note', point.note));
      const popup = new maplibregl.Popup({ offset: 36, closeButton: true, maxWidth: '220px' })
        .setLngLat([point.lng, point.lat])
        .setDOMContent(info);
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        selectPoint(point.id);
        popup.addTo(map);
      });
      marker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' })
        .setLngLat([point.lng, point.lat])
        .setPopup(popup)
        .addTo(map);
      marker.togglePopup();
      marker.on('dragend', async () => {
        const pos = marker.getLngLat();
        try {
          await patchPoint(point.id, { lat: pos.lat, lng: pos.lng });
          await load();
        } catch (err) {
          toast(err.message, true);
          await load();
        }
      });
      markers.set(point.id, marker);
    } else {
      marker.remove();
      markers.delete(point.id);
      const el = createMarkerEl(point, commentsOf(point.id).length);
      const info = el2('div', 'marker-popup');
      info.appendChild(el2('b', 'mp-name', point.title || '未命名'));
      if (point.cost) info.appendChild(el2('span', 'mp-cost', '¥' + point.cost));
      if (point.note) info.appendChild(el2('span', 'mp-note', point.note));
      const popup = new maplibregl.Popup({ offset: 36, closeButton: true, maxWidth: '220px' })
        .setLngLat([point.lng, point.lat])
        .setDOMContent(info);
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        selectPoint(point.id);
        popup.addTo(map);
      });
      const newMarker = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom' })
        .setLngLat([point.lng, point.lat])
        .setPopup(popup)
        .addTo(map);
      newMarker.togglePopup();
      newMarker.on('dragend', async () => {
        const pos = newMarker.getLngLat();
        try { await patchPoint(point.id, { lat: pos.lat, lng: pos.lng }); await load(); }
        catch (err) { toast(err.message, true); await load(); }
      });
      markers.set(point.id, newMarker);
    }
  }
}

/* ---------- sync ---------- */

function signatureOf() {
  const stamp = [
    state.points.map(p => p.id + ':' + p.updated_at).join(','),
    state.comments.map(c => c.id).join(',')
  ].join('|');
  let h = 0;
  for (const ch of stamp) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h + '#' + state.points.length + '/' + state.comments.length;
}

function setSync(kind, text) {
  $('syncState').className = 'sync' + (kind === 'ok' ? '' : ' ' + kind);
  $('syncState').title = text;
  $('syncState').textContent = text;
}

async function load() {
  if (!state.trip) return false;
  setSync('busy', '同步中');
  try {
    // Fetch trip, points, and comments from Supabase
    const [tripRows, pointsRows, commentsRows] = await Promise.all([
      apiGet('trips', { code: `eq.${state.trip.code}` }),
      apiGet('points', { trip_code: `eq.${state.trip.code}`, order: 'created_at.asc' }),
      apiGet('comments', { trip_code: `eq.${state.trip.code}`, order: 'created_at.asc' })
    ]);

    if (!tripRows || tripRows.length === 0) throw { code: 'trip_not_found' };

    state.trip = tripRows[0];
    state.points = pointsRows || [];
    state.comments = commentsRows || [];
    const sig = signatureOf();
    const changed = sig !== state.signature;
    state.signature = sig;
    if (changed || !markers.size) {
      const scroll = $('pointList').parentElement.scrollTop;
      renderAll();
      $('pointList').parentElement.scrollTop = scroll;
    }
    paintHeader();
    setSync('ok', '已同步');
    rememberTrip(state.trip);
    return true;
  } catch (err) {
    if (err.code === 'trip_not_found') { signOut(); toast('这趟行程打不开了', true); return false; }
    setSync('bad', '同步失败');
    if (!state.points.length) toast(err.message, true);
    return false;
  }
}

function paintHeader() {
  $('tripNameBtn').textContent = state.trip.name;
  $('tripCodeText').textContent = '邀请码 ' + state.trip.code;
  document.title = state.trip.name + ' · 行程地图';
}

let pollTimer = null;
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden && state.trip && !state.dirty) load();
  }, SYNC_MS);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.trip) load(); });
window.addEventListener('focus', () => { if (state.trip && !state.dirty) load(); });

/* ---------- render ---------- */

function renderAll() {
  renderDaybar();
  renderPointList();
  renderMarkers();
  renderChat();
  renderCounts();
  if (map) map.resize();
}

function renderDaybar() {
  const bar = $('daybar');
  bar.textContent = '';
  const days = Math.max(1, Number(state.trip && state.trip.days) || 1);
  for (const d of [0, ...Array.from({ length: days }, (_, i) => i + 1)]) {
    const b = el('button', null, d === 0 ? '全程' : '第 ' + d + ' 天');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(state.day === d));
    b.onclick = () => { state.day = d; renderDaybar(); renderPointList(); renderMarkers(); };
    bar.appendChild(b);
  }
}

function renderCounts() {
  $('countPoints').textContent = String(state.points.length);
  $('countChat').textContent = String(state.comments.filter(c => !c.point_id).length);
}

function renderPointList() {
  const list = $('pointList');
  list.textContent = '';
  const points = visiblePoints();
  $('pointsEmpty').hidden = points.length > 0;
  for (const p of points) {
    const li = el('li');
    const expanded = state.openPointId === p.id;

    const card = el('div', 'pcard' + (expanded ? ' sel' : ''));
    card.style.setProperty('--pin', catOf(p.category).color);
    card.appendChild(el('span', 'bar'));

    const body = el('div', 'pcard-body');
    body.appendChild(el('div', 'name', p.title || '未命名地点'));
    if (p.note) body.appendChild(el('div', 'sub', p.note));
    const meta = el('div', 'meta');
    meta.appendChild(el('span', 'day-tag', dayLabel(p.day)));
    meta.appendChild(el('span', null, catOf(p.category).label));
    if (p.cost) meta.appendChild(el('span', null, '¥' + p.cost));
    if (p.author) meta.appendChild(el('span', null, '标记者 ' + p.author));
    body.appendChild(meta);
    card.appendChild(body);

    const actions = el('div', 'pcard-actions');
    const editBtn = el('button', 'pcard-edit', '编辑');
    editBtn.type = 'button';
    editBtn.onclick = ev => { ev.stopPropagation(); openPoint(p.id); };
    actions.appendChild(editBtn);
    const count = commentsOf(p.id).length;
    if (count) actions.appendChild(el('span', 'badge', String(count)));
    card.appendChild(actions);

    card.onclick = () => {
      if (expanded) { state.openPointId = null; }
      else { state.openPointId = p.id; focusPoint(p); }
      renderPointList();
      renderMarkers();
    };
    li.appendChild(card);

    if (expanded) {
      const thread = el('div', 'inline-thread');
      const msgs = commentsOf(p.id).sort(sortAsc);
      for (const c of msgs) thread.appendChild(messageRow(c, true));
      if (!msgs.length) thread.appendChild(el('div', 'thread-empty', '还没有讨论，来说点什么吧'));
      const form = el('form', 'inline-form');
      const input = el('input');
      input.type = 'text';
      input.placeholder = '写点评论…';
      const send = el('button', 'btn primary sm', '发送');
      send.type = 'submit';
      form.appendChild(input);
      form.appendChild(send);
      form.onsubmit = async ev => {
        ev.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        try {
          await apiInsert('comments', { trip_code: state.trip.code, point_id: p.id, author: state.me, text });
          await load();
        } catch (err) { toast(err.message, true); }
      };
      thread.appendChild(form);
      li.appendChild(thread);
    }
    list.appendChild(li);
  }
}

function selectPoint(id) {
  state.openPointId = id;
  renderPointList();
  renderMarkers();
}

function focusPoint(p) {
  map.flyTo({ center: [p.lng, p.lat], zoom: 14 });
}

function authorColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 48% 34%)`;
}

function messageRow(c, inThread) {
  const li = el('li', 'msg' + (c.author === state.me ? ' mine' : ''));
  const who = el('div', 'who');
  const name = el('b', null, c.author);
  name.style.color = authorColor(c.author);
  who.appendChild(name);
  who.appendChild(el('span', null, timeAgo(c.created_at)));

  if (c.point_id && !inThread) {
    const p = state.points.find(x => x.id === c.point_id);
    const jump = el('button', 'about', '关于：' + (p ? p.title : '已删除的地点'));
    jump.type = 'button';
    if (p) jump.onclick = () => { state.tab = 'points'; switchTab(); selectPoint(p.id); focusPoint(p); };
    else jump.disabled = true;
    who.appendChild(jump);
  }

  const del = el('button', 'del', '删除');
  del.type = 'button';
  del.hidden = c.author !== state.me;
  del.onclick = () => {
    if (del.dataset.armed) {
      apiDelete('comments', `id=eq.${c.id}`)
        .then(load)
        .catch(err => toast(err.message, true));
      return;
    }
    del.dataset.armed = '1';
    del.textContent = '确认删除？';
    setTimeout(() => { if (del.isConnected) { del.dataset.armed = ''; del.textContent = '删除'; } }, 4000);
  };
  who.appendChild(del);

  li.appendChild(who);
  li.appendChild(el('div', 'text', c.text));
  return li;
}

function sortAsc(a, b) { return new Date(a.created_at) - new Date(b.created_at); }

function renderChat() {
  const list = $('chatList');
  list.textContent = '';

  // 全程讨论
  const generalMsgs = state.comments.filter(m => !m.point_id).sort(sortAsc);
  const generalThread = el('div', 'chat-thread');
  const generalHead = el('button', 'thread-head');
  generalHead.type = 'button';
  generalHead.appendChild(el('span', 'thread-title', '全程讨论'));
  generalHead.appendChild(el('span', 'thread-count', String(generalMsgs.length)));
  generalHead.onclick = () => { generalThread.classList.toggle('open'); };
  generalThread.appendChild(generalHead);
  const generalBody = el('div', 'thread-body');
  for (const c of generalMsgs) generalBody.appendChild(messageRow(c, false));
  const gForm = el('form', 'inline-form');
  const gInput = el('input'); gInput.type = 'text'; gInput.placeholder = '聊聊整趟行程…';
  const gSend = el('button', 'btn primary sm', '发送'); gSend.type = 'submit';
  gForm.appendChild(gInput); gForm.appendChild(gSend);
  gForm.onsubmit = async ev => {
    ev.preventDefault();
    const text = gInput.value.trim(); if (!text) return;
    gInput.value = '';
    try { await apiInsert('comments', { trip_code: state.trip.code, author: state.me, text }); await load(); }
    catch (err) { toast(err.message, true); }
  };
  generalBody.appendChild(gForm);
  generalThread.appendChild(generalBody);
  list.appendChild(generalThread);

  // 按地点分组
  const pointIds = new Set(state.comments.filter(m => m.point_id).map(m => m.point_id));
  for (const pid of pointIds) {
    const p = state.points.find(x => x.id === pid);
    const msgs = state.comments.filter(m => m.point_id === pid).sort(sortAsc);
    const thread = el('div', 'chat-thread');
    const head = el('button', 'thread-head');
    head.type = 'button';
    head.appendChild(el('span', 'thread-title', p ? p.title : '已删除的地点'));
    head.appendChild(el('span', 'thread-author', msgs[msgs.length - 1]?.author || ''));
    head.appendChild(el('span', 'thread-count', String(msgs.length)));
    head.onclick = () => { thread.classList.toggle('open'); };
    thread.appendChild(head);
    const body = el('div', 'thread-body');
    for (const c of msgs) body.appendChild(messageRow(c, true));
    if (p) {
      const form = el('form', 'inline-form');
      const input = el('input'); input.type = 'text'; input.placeholder = '回复…';
      const send = el('button', 'btn primary sm', '发送'); send.type = 'submit';
      form.appendChild(input); form.appendChild(send);
      form.onsubmit = async ev => {
        ev.preventDefault();
        const text = input.value.trim(); if (!text) return;
        input.value = '';
        try { await apiInsert('comments', { trip_code: state.trip.code, point_id: pid, author: state.me, text }); await load(); }
        catch (err) { toast(err.message, true); }
      };
      body.appendChild(form);
    }
    thread.appendChild(body);
    list.appendChild(thread);
  }

  if (!pointIds.size && !generalMsgs.length) {
    list.appendChild(el('div', 'thread-empty', '还没有任何讨论。在地点卡片下方展开评论，或在这里聊整趟行程。'));
  }
}

/* ---------- point sheet ---------- */

function renderCategoryChips(selected) {
  const box = $('pCategory');
  box.textContent = '';
  for (const c of CATS) {
    const b = el('button', null, c.label);
    b.type = 'button';
    b.style.setProperty('--pin', c.color);
    b.setAttribute('aria-pressed', String(c.id === selected));
    b.onclick = () => { state.draft.category = c.id; renderCategoryChips(c.id); markDirty(); };
    box.appendChild(b);
  }
}

function renderDaySelect(selected) {
  const sel = $('pDay');
  sel.textContent = '';
  const days = Math.max(1, Number(state.trip.days) || 1);
  for (let d = 1; d <= days; d++) sel.appendChild(el('option', null, '第 ' + d + ' 天'));
  sel.appendChild(el('option', null, '还没定'));
  sel.value = String(selected === 0 ? 0 : Math.min(selected, days));
}

function openPoint(pointId, seed = {}) {
  const p = pointId ? state.points.find(x => x.id === pointId) : null;
  if (pointId && !p) return;
  state.openPointId = pointId || null;
  state.draft = p
    ? { id: p.id, title: p.title, address: p.address, lat: p.lat, lng: p.lng, category: p.category, day: p.day, note: p.note, cost: p.cost }
    : {
        id: null,
        title: seed.title || '',
        address: seed.address || '',
        lat: seed.lat,
        lng: seed.lng,
        category: seed.category || 'sight',
        day: state.day > 0 ? state.day : 1,
        note: '',
        cost: ''
      };
  state.dirty = false;

  $('pTitle').value = state.draft.title;
  $('pNote').value = state.draft.note || '';
  $('pCost').value = state.draft.cost || '';
  $('pAddress').textContent = state.draft.address || positionText(state.draft);
  $('pTitle').readOnly = false;
  renderCategoryChips(state.draft.category);
  renderDaySelect(state.draft.day);
  $('pDelete').hidden = !p;
  $('pSavedFlag').hidden = true;
  $('mapTip').classList.add('hide');

  $('scrim').hidden = false;
  $('pointSheet').hidden = false;
  renderPointList();
  renderMarkers();
  if (!p && !state.draft.address) reverseGeocode(state.draft);
  setTimeout(() => $('pTitle').focus(), 80);
}

const positionText = d => d.lat.toFixed(5) + ', ' + d.lng.toFixed(5) + ' · 拖动标记可以微调位置';

function markDirty() {
  state.dirty = true;
  $('pSavedFlag').hidden = true;
}

async function reverseGeocode(draft) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${draft.lat}&lon=${draft.lng}&accept-language=zh`);
    const data = await res.json();
    if (state.draft !== draft) return;
    if (data.display_name) {
      draft.address = data.display_name;
      $('pAddress').textContent = data.display_name;
      const name = data.address?.building || data.address?.road || data.display_name.split(',')[0];
      if (!$('pTitle').value && name) {
        $('pTitle').value = name;
        draft.title = name;
      }
      markDirty();
    }
  } catch {}
}

async function savePoint() {
  const d = state.draft;
  d.title = $('pTitle').value.trim();
  d.note = $('pNote').value.trim();
  d.cost = $('pCost').value.trim();
  d.day = Number($('pDay').value);
  if (!d.title) { toast('先给地点起个名字', true); $('pTitle').focus(); return; }

  const body = {
    trip_code: state.trip.code,
    title: d.title,
    address: d.address,
    lat: d.lat,
    lng: d.lng,
    category: d.category,
    day: d.day,
    note: d.note,
    cost: d.cost,
    author: state.me
  };
  const button = $('pSave');
  button.disabled = true;
  try {
    if (d.id) {
      await apiUpdate('points', `id=eq.${d.id}`, body);
    } else {
      const created = await apiInsert('points', body);
      d.id = created[0].id;
      state.openPointId = created[0].id;
      state.justAddedId = created[0].id;
      setTimeout(() => { if (state.justAddedId === created[0].id) { state.justAddedId = null; renderMarkers(); } }, 500);
    }
    state.dirty = false;
    $('pSavedFlag').hidden = false;
    await load();
    renderPointList();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

function patchPoint(id, fields) {
  return apiUpdate('points', `id=eq.${id}`, { trip_code: state.trip.code, author: state.me, ...fields });
}

function closeSheets() {
  for (const id of ['pointSheet', 'tripSheet', 'meSheet', 'shareSheet']) $(id).hidden = true;
  $('scrim').hidden = true;
  state.openPointId = null;
  state.draft = null;
  state.dirty = false;
  renderPointList();
  renderMarkers();
}

function openSheet(id) {
  $('scrim').hidden = false;
  $(id).hidden = false;
}

/* ---------- trip switcher ---------- */

function openTripSwitcher() {
  let pop = $('tripSwitcher');
  if (pop) pop.remove();
  pop = el('div', 'trip-switcher');
  pop.id = 'tripSwitcher';

  const cur = el('div', 'ts-current');
  cur.appendChild(el('div', 'ts-label', '当前行程'));
  const curName = el('div', 'ts-name', state.trip.name);
  cur.appendChild(curName);
  const curActions = el('div', 'ts-actions');
  const editBtn = el('button', 'btn ghost sm', '编辑名称/天数');
  editBtn.type = 'button';
  editBtn.id = 'tEditBtn';
  editBtn.onclick = () => { pop.remove(); $('tName').value = state.trip.name; $('tDays').value = String(state.trip.days); openSheet('tripSheet'); };
  curActions.appendChild(editBtn);
  cur.appendChild(curActions);
  pop.appendChild(cur);

  const recent = store.get(LS.recent, []).filter(t => t.code !== state.trip.code);
  if (recent.length) {
    pop.appendChild(el('div', 'ts-label', '切换行程'));
    const list = el('div', 'ts-list');
    for (const t of recent) {
      const item = el('button', 'ts-item');
      item.type = 'button';
      item.appendChild(el('span', 'ts-item-name', t.name || t.code));
      item.appendChild(el('span', 'ts-item-code', t.code));
      item.onclick = () => { pop.remove(); enterTrip(t.code).catch(err => toast(err.message, true)); };
      list.appendChild(item);
    }
    pop.appendChild(list);
  }

  const newBtn = el('button', 'btn ghost wide sm', '+ 新建行程');
  newBtn.type = 'button';
  newBtn.onclick = () => { pop.remove(); signOut(); };
  pop.appendChild(newBtn);

  document.querySelector('.trip-id').appendChild(pop);
  setTimeout(() => document.addEventListener('click', function close(e) {
    if (!pop.contains(e.target) && e.target !== $('tripNameBtn')) { pop.remove(); document.removeEventListener('click', close); }
  }), 0);
}

/* ---------- search (Nominatim) ---------- */

let searchSeq = 0;

function runSearch(query) {
  const seq = ++searchSeq;
  const box = $('searchResults');
  box.hidden = false;
  box.textContent = '';
  box.appendChild(el('li', 'pending', '搜索中…'));

  fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&accept-language=zh`)
    .then(r => r.json())
    .then(results => {
      if (seq !== searchSeq) return;
      box.textContent = '';
      if (!results || !results.length) {
        box.appendChild(el('li', 'pending', '没找到这个地方。换个关键词，或者直接在地图上点一下'));
        return;
      }
      for (const r of results) {
        const li = el('li');
        li.appendChild(el('div', 'st', r.display_name.split(',')[0]));
        li.appendChild(el('div', 'ss', r.display_name));
        li.onclick = () => {
          box.hidden = true;
          $('searchInput').value = r.display_name.split(',')[0];
          const lng = parseFloat(r.lon), lat = parseFloat(r.lat);
          map.flyTo({ center: [lng, lat], zoom: 14 });
          openPoint(null, { lat, lng, address: r.display_name, title: r.display_name.split(',')[0] });
        };
        box.appendChild(li);
      }
    })
    .catch(() => {
      if (seq !== searchSeq) return;
      box.textContent = '';
      box.appendChild(el('li', 'pending', '搜索出错了，检查一下网络'));
    });
}

/* ---------- trips ---------- */

function codeFromUrl() {
  const code = (new URLSearchParams(location.search).get('trip') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE_RE.test(code) ? code : '';
}

function rememberTrip(trip) {
  store.set(LS.trip, trip.code);
  const recent = store.get(LS.recent, []).filter(t => t.code !== trip.code);
  recent.unshift({ code: trip.code, name: trip.name });
  store.set(LS.recent, recent.slice(0, 6));
  if (location.search !== '?trip=' + encodeURIComponent(trip.code)) {
    history.replaceState(null, '', '?trip=' + encodeURIComponent(trip.code));
  }
}

function signOut() {
  clearInterval(pollTimer);
  state.trip = null;
  state.points = [];
  state.comments = [];
  state.signature = '';
  closeSheets();
  $('app').hidden = true;
  $('gate').hidden = false;
  renderRecent();
}

async function enterTrip(code) {
  await ensureNick();
  $('meBtn').textContent = state.me;
  $('gate').hidden = true;
  $('app').hidden = false;
  state.trip = { code, name: '加载中…', days: 1 };
  state.signature = '';
  state.day = 0;
  paintHeader();
  await load();
  if (!state.trip) throw new Error('邀请码打不开这趟行程');
  renderDaybar();
  startPolling();
  fitAll(true);
}

function ensureNick() {
  if (state.me) return Promise.resolve();
  const nick = (window.prompt('先告诉大家你叫什么，只用来标记评论是谁写的', '') || '').trim().slice(0, 16);
  state.me = nick || '朋友';
  store.set(LS.nick, state.me);
}

function renderRecent() {
  const box = $('recentTrips');
  box.textContent = '';
  const recent = store.get(LS.recent, []);
  if (!recent.length) return;
  box.appendChild(el('p', 'hint', '这台设备最近打开过'));
  for (const t of recent) {
    const card = el('button', 'pcard recent');
    card.type = 'button';
    card.style.setProperty('--pin', 'var(--site-accent)');
    card.appendChild(el('span', 'bar'));
    const body = el('div');
    body.appendChild(el('div', 'name', t.name || t.code));
    body.appendChild(el('div', 'sub', '邀请码 ' + t.code));
    card.appendChild(body);
    card.onclick = () => enterTrip(t.code).catch(err => showGateError(err.message));
    box.appendChild(card);
  }
}

function showGateError(message) {
  $('gateError').textContent = message;
  $('gateError').hidden = false;
}

async function fitAll(force) {
  if (!state.points.length) return;
  const lngs = state.points.map(p => p.lng);
  const lats = state.points.map(p => p.lat);
  const bounds = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
  if (!force) {
    const current = map.getBounds();
    if (current.contains([Math.min(...lngs), Math.min(...lats)]) && current.contains([Math.max(...lngs), Math.max(...lats)])) return;
  }
  map.fitBounds(bounds, { padding: 60 });
}

/* ---------- tabs ---------- */

function switchTab() {
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  }
  $('tabPoints').hidden = state.tab !== 'points';
  $('tabChat').hidden = state.tab !== 'chat';
}

/* ---------- composer ---------- */

function bindComposer(formId, inputId, send) {
  const form = $(formId), input = $(inputId), button = form.querySelector('button');
  input.addEventListener('input', () => { button.disabled = !input.value.trim(); });
  input.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    await ensureNick();
    button.disabled = true;
    try {
      await send(text);
      input.value = '';
      await load();
    } catch (err) {
      toast(err.message, true);
      button.disabled = !input.value.trim();
    }
  });
}

/* ---------- wire ---------- */

function wire() {
  $('gateNick').value = state.me;
  $('meBtn').textContent = state.me || '未署名';
  $('gateNick').addEventListener('change', () => {
    const nick = $('gateNick').value.trim().slice(0, 16);
    if (!nick) return;
    state.me = nick;
    store.set(LS.nick, nick);
    $('meBtn').textContent = nick;
  });

  $('createTripBtn').onclick = async () => {
    await ensureNick();
    $('meBtn').textContent = state.me;
    const body = {
      code: generateCode(),
      name: $('gateTripName').value.trim() || '我们的行程',
      days: Math.min(30, Math.max(1, Number($('gateTripDays').value) || 3)),
      author: state.me
    };
    try {
      await apiInsert('trips', body);
      $('gateError').hidden = true;
      await enterTrip(body.code);
      toast('行程建好了，点分享把链接发给姐妹');
    } catch (err) { showGateError(err.message); }
  };

  $('joinTripBtn').onclick = async () => {
    const code = $('gateJoinCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!CODE_RE.test(code)) { showGateError('邀请码是 6 位以上的大写字母数字，检查一下？'); return; }
    $('gateError').hidden = true;
    try { await enterTrip(code); }
    catch (err) { showGateError(err.message); }
  };

  $('searchInput').addEventListener('input', debounce(() => {
    const q = $('searchInput').value.trim();
    if (q.length < 2) { $('searchResults').hidden = true; return; }
    runSearch(q);
  }, 500));
  document.addEventListener('click', e => {
    if (!$('searchBox').contains(e.target)) $('searchResults').hidden = true;
  });

  $('shareBtn').onclick = () => {
    $('shareLink').value = location.href;
    $('shareCode').textContent = state.trip.code;
    openSheet('shareSheet');
  };
  $('copyLinkBtn').onclick = async () => {
    $('shareLink').select();
    try { await navigator.clipboard.writeText($('shareLink').value); toast('链接复制好了'); }
    catch { toast('按 Ctrl+C 复制'); }
  };

  $('meBtn').onclick = () => { $('mNick').value = state.me; openSheet('meSheet'); };
  $('mSave').onclick = () => {
    const nick = $('mNick').value.trim().slice(0, 16);
    if (!nick) { toast('名字不能为空', true); return; }
    state.me = nick;
    store.set(LS.nick, nick);
    $('meBtn').textContent = nick;
    closeSheets();
    renderChat();
    renderPointList();
  };

  $('tripNameBtn').onclick = () => { openTripSwitcher(); };
  $('tSave').onclick = async () => {
    const name = $('tName').value.trim();
    const days = Math.min(30, Math.max(1, Number($('tDays').value) || 1));
    if (!name) { toast('行程名称不能为空', true); return; }
    try {
      await apiUpdate('trips', `code=eq.${state.trip.code}`, { name, days, author: state.me });
      closeSheets();
      await load();
    } catch (err) { toast(err.message, true); }
  };

  for (const id of ['sheetClose', 'tripSheetClose', 'meSheetClose', 'shareSheetClose']) $(id).onclick = closeSheets;
  $('scrim').onclick = closeSheets;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });

  for (const id of ['pTitle', 'pNote', 'pCost']) $(id).addEventListener('input', markDirty);
  $('pDay').addEventListener('change', markDirty);
  $('pSave').onclick = savePoint;
  $('pDelete').onclick = () => {
    const button = $('pDelete');
    if (button.dataset.armed) {
      apiDelete('points', `id=eq.${state.draft.id}`)
        .then(() => { closeSheets(); return load(); })
        .then(() => toast('地点删掉了'))
        .catch(err => toast(err.message, true));
      return;
    }
    button.dataset.armed = '1';
    button.textContent = '再点一次确认删除';
    setTimeout(() => { delete button.dataset.armed; button.textContent = '删除地点'; }, 4000);
  };

  for (const button of document.querySelectorAll('.tabs button')) {
    button.onclick = () => { state.tab = button.dataset.tab; switchTab(); };
  }

  $('fitBtn').onclick = () => fitAll(true);
  $('locBtn').onclick = () => {
    if (!navigator.geolocation) { toast('这个浏览器不给定位', true); return; }
    navigator.geolocation.getCurrentPosition(
      pos => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 14 }),
      () => toast('定位失败，可能没给权限', true),
      { timeout: 8000 }
    );
  };

  const regionBtn = document.createElement('button');
  regionBtn.className = 'tool';
  regionBtn.type = 'button';
  regionBtn.textContent = '区域';
  regionBtn.title = '输入省市名，地图飞过去';
  regionBtn.onclick = () => {
    const name = window.prompt('输入国家、省份或城市名，例如：云南、杭州、日本', '');
    if (!name || !name.trim()) return;
    flyToRegion(name.trim());
  };
  document.querySelector('.map-tools').appendChild(regionBtn);
}

async function flyToRegion(name) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(name)}&limit=1&accept-language=zh`);
    const results = await res.json();
    if (results && results.length) {
      const r = results[0];
      const lng = parseFloat(r.lon), lat = parseFloat(r.lat);
      if (r.boundingbox) {
        const [s, n, w, e] = r.boundingbox.map(Number);
        map.fitBounds([[w, s], [e, n]], { padding: 40 });
      } else {
        map.flyTo({ center: [lng, lat], zoom: 10 });
      }
    } else {
      toast('没找到这个地方', true);
    }
  } catch {
    toast('区域搜索失败', true);
  }
}

/* ---------- boot ---------- */

async function boot() {
  initMap();
  wire();
  renderRecent();

  const code = codeFromUrl() || store.get(LS.trip, '');
  if (!code) return;
  try { await enterTrip(code); }
  catch { signOut(); }
}

boot();
