'use strict';

/* global Terminal, FitAddon */

const bridge = window.api;

const $ = (id) => document.getElementById(id);

/** Bóc phản hồi {ok, data, error} từ main process, ném lỗi nếu thất bại. */
async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) throw new Error((res && res.error) || 'Lỗi không xác định');
  return res.data;
}

const TERM_THEME = {
  background: '#14161a',
  foreground: '#dfe3ea',
  cursor: '#4f9cf9',
  cursorAccent: '#14161a',
  selectionBackground: 'rgba(79, 156, 249, 0.3)',
  black: '#2c313b',
  red: '#ef5f6b',
  green: '#3ddc97',
  yellow: '#f2b04a',
  blue: '#4f9cf9',
  magenta: '#c78ef7',
  cyan: '#4fd6e0',
  white: '#dfe3ea',
  brightBlack: '#5c6472',
  brightRed: '#ff8189',
  brightGreen: '#6ff0b8',
  brightYellow: '#ffc978',
  brightBlue: '#7bb8ff',
  brightMagenta: '#dcb0ff',
  brightCyan: '#84e9f0',
  brightWhite: '#ffffff',
};

const state = {
  connections: [],
  snippets: [],
  sessions: new Map(), // sessionId -> { connId, name, term, fit, pane, status }
  activeSessionId: null,
  selectedConnId: null,
  filter: '',
  editingConnId: null,
  editingSnippetId: null,
  paletteIndex: 0,
  paletteItems: [],
};

/* =========================================================================
 * Tiện ích
 * ========================================================================= */

function setStatus(text, kind) {
  const el = $('status-text');
  el.textContent = text;
  el.className = kind === 'error' ? 'status-err' : kind === 'ok' ? 'status-ok' : 'muted';
}

function showError(elId, message) {
  const el = $(elId);
  el.textContent = message;
  el.hidden = false;
}

function clearError(elId) {
  $(elId).hidden = true;
}

function openModal(id) {
  $(id).hidden = false;
}

function closeModal(id) {
  $(id).hidden = true;
}

/** Số phiên đang mở của một kết nối, dùng để chấm xanh trong danh sách. */
function liveCount(connId) {
  let n = 0;
  for (const s of state.sessions.values()) {
    if (s.connId === connId && s.status !== 'gone') n += 1;
  }
  return n;
}

/* =========================================================================
 * Màn hình khoá
 * ========================================================================= */

let lockMode = 'unlock'; // 'unlock' | 'setup'

async function initLockScreen() {
  const status = await call(bridge.vault.status());
  lockMode = status.exists ? 'unlock' : 'setup';

  if (lockMode === 'setup') {
    $('lock-title').textContent = 'Tạo kho kết nối';
    $('lock-subtitle').textContent =
      'Đặt master password để mã hoá toàn bộ máy chủ và mật khẩu đã lưu.';
    $('lock-password').placeholder = 'Master password (tối thiểu 8 ký tự)';
    $('lock-password').setAttribute('autocomplete', 'new-password');
    $('lock-password-confirm').hidden = false;
    $('lock-password-confirm').required = true;
    $('lock-submit').textContent = 'Tạo kho';
    $('lock-hint').hidden = false;
  }
  $('lock-password').focus();
}

$('lock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('lock-error');
  const password = $('lock-password').value;

  try {
    if (lockMode === 'setup') {
      if (password !== $('lock-password-confirm').value) {
        return showError('lock-error', 'Hai mật khẩu không khớp.');
      }
      await call(bridge.vault.init(password));
    } else {
      await call(bridge.vault.unlock(password));
    }
  } catch (err) {
    return showError('lock-error', err.message);
  }

  $('lock-password').value = '';
  $('lock-password-confirm').value = '';
  $('lock-screen').hidden = true;
  $('app').hidden = false;
  await refreshAll();
  $('search').focus();
});

async function lockVault() {
  for (const id of [...state.sessions.keys()]) closeSession(id, true);
  await call(bridge.vault.lock());
  state.connections = [];
  state.snippets = [];
  $('app').hidden = true;
  $('lock-screen').hidden = false;
  lockMode = 'unlock';
  $('lock-title').textContent = 'Mở kho kết nối';
  $('lock-subtitle').textContent = 'Nhập master password để giải mã kho.';
  $('lock-password-confirm').hidden = true;
  $('lock-password-confirm').required = false;
  $('lock-submit').textContent = 'Mở khoá';
  $('lock-hint').hidden = true;
  $('lock-password').focus();
}

/* =========================================================================
 * Danh sách kết nối
 * ========================================================================= */

async function refreshAll() {
  state.connections = await call(bridge.connections.list());
  state.snippets = await call(bridge.snippets.list());
  renderConnections();
  renderSnippets();
  renderGroupOptions();
}

function matchesFilter(conn, needle) {
  if (!needle) return true;
  const hay = [conn.name, conn.host, conn.username, conn.group, conn.notes]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(needle);
}

/** Ưu tiên máy hay dùng và mới dùng để "truy cập nhanh" đúng nghĩa. */
function sortConnections(list) {
  return [...list].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    if (a.lastUsedAt || b.lastUsedAt) {
      return String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || ''));
    }
    return a.name.localeCompare(b.name);
  });
}

function renderConnections() {
  const container = $('conn-list');
  container.textContent = '';
  const needle = state.filter.trim().toLowerCase();
  const visible = state.connections.filter((c) => matchesFilter(c, needle));

  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = state.connections.length
      ? 'Không có máy chủ nào khớp.'
      : 'Chưa có máy chủ nào. Nhấn “+ Kết nối” hoặc “Nhập config”.';
    container.appendChild(empty);
    return;
  }

  const groups = new Map();
  for (const conn of sortConnections(visible)) {
    const key = conn.group || 'Khác';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(conn);
  }

  for (const [groupName, items] of [...groups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = groupName;
    container.appendChild(title);
    for (const conn of items) container.appendChild(connectionItem(conn));
  }
}

function connectionItem(conn) {
  const item = document.createElement('div');
  item.className = 'conn-item';
  if (conn.id === state.selectedConnId) item.classList.add('selected');
  if (liveCount(conn.id) > 0) item.classList.add('live');
  item.title = conn.notes || conn.username + '@' + conn.host + ':' + conn.port;

  const dot = document.createElement('span');
  dot.className = 'conn-dot';

  const body = document.createElement('div');
  body.className = 'conn-body';
  const name = document.createElement('div');
  name.className = 'conn-name';
  name.textContent = conn.name;
  const sub = document.createElement('div');
  sub.className = 'conn-sub';
  const authTag = conn.authType === 'password' ? 'pw' : 'key';
  sub.textContent =
    conn.username + '@' + conn.host + (conn.port !== 22 ? ':' + conn.port : '') + ' · ' + authTag;
  body.append(name, sub);

  const edit = document.createElement('button');
  edit.className = 'conn-edit';
  edit.type = 'button';
  edit.textContent = '✎';
  edit.title = 'Sửa';
  edit.addEventListener('click', (event) => {
    event.stopPropagation();
    openConnectionModal(conn.id);
  });

  item.append(dot, body, edit);
  item.addEventListener('click', () => {
    state.selectedConnId = conn.id;
    openSession(conn.id);
  });
  return item;
}

function renderGroupOptions() {
  const list = $('group-options');
  list.textContent = '';
  const groups = [...new Set(state.connections.map((c) => c.group).filter(Boolean))].sort();
  for (const group of groups) {
    const option = document.createElement('option');
    option.value = group;
    list.appendChild(option);
  }
}

$('search').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderConnections();
});

/* =========================================================================
 * Phiên SSH và tab
 * ========================================================================= */

async function openSession(connId) {
  const conn = state.connections.find((c) => c.id === connId);
  if (!conn) return;

  const sessionId = crypto.randomUUID();

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  $('terminals').appendChild(pane);

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  fit.fit();

  term.onData((data) => bridge.ssh.input(sessionId, data));
  term.onResize(({ cols, rows }) => bridge.ssh.resize(sessionId, cols, rows));

  const session = { connId, name: conn.name, term, fit, pane, status: 'connecting' };
  state.sessions.set(sessionId, session);
  activateSession(sessionId);
  renderTabs();
  renderConnections();

  term.writeln('\x1b[90mĐang kết nối tới ' + conn.username + '@' + conn.host + '…\x1b[0m');

  try {
    await call(bridge.ssh.open(sessionId, connId, { cols: term.cols, rows: term.rows }));
  } catch (err) {
    session.status = 'gone';
    term.writeln('\r\n\x1b[31m✗ ' + err.message + '\x1b[0m');
    setStatus(err.message, 'error');
    renderTabs();
  }
}

function activateSession(sessionId) {
  state.activeSessionId = sessionId;
  for (const [id, session] of state.sessions) {
    session.pane.hidden = id !== sessionId;
  }
  $('empty-state').hidden = state.sessions.size > 0;

  const session = state.sessions.get(sessionId);
  if (session) {
    // Chờ trình duyệt vẽ xong pane rồi mới đo kích thước
    requestAnimationFrame(() => {
      session.fit.fit();
      session.term.focus();
    });
  }
  renderTabs();
}

function closeSession(sessionId, silent) {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  bridge.ssh.close(sessionId);
  session.term.dispose();
  session.pane.remove();
  state.sessions.delete(sessionId);

  if (state.activeSessionId === sessionId) {
    const next = [...state.sessions.keys()].pop() || null;
    state.activeSessionId = next;
    if (next) activateSession(next);
  }
  $('empty-state').hidden = state.sessions.size > 0;
  if (!silent) {
    renderTabs();
    renderConnections();
  }
}

function renderTabs() {
  const bar = $('tabbar');
  bar.textContent = '';
  for (const [sessionId, session] of state.sessions) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    if (sessionId === state.activeSessionId) tab.classList.add('active');
    if (session.status === 'connected') tab.classList.add('connected');
    if (session.status === 'gone') tab.classList.add('dead');

    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    const label = document.createElement('span');
    label.textContent = session.name;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Đóng phiên (Ctrl+W)';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSession(sessionId);
    });

    tab.append(dot, label, close);
    tab.addEventListener('click', () => activateSession(sessionId));
    bar.appendChild(tab);
  }
}

bridge.ssh.onData((sessionId, data) => {
  const session = state.sessions.get(sessionId);
  if (session) session.term.write(data);
});

bridge.ssh.onStatus((sessionId, status) => {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  if (status.state === 'connected') {
    session.status = 'connected';
    setStatus(status.message, 'ok');
  } else if (status.state === 'error') {
    session.status = 'gone';
    session.term.writeln('\r\n\x1b[31m✗ ' + status.message + '\x1b[0m');
    setStatus(status.message, 'error');
  } else if (status.state === 'closed' || status.state === 'ended') {
    session.status = 'gone';
    session.term.writeln('\r\n\x1b[90m— ' + status.message + ' —\x1b[0m');
    setStatus(status.message);
  } else if (status.state === 'connecting') {
    setStatus(status.message);
  }
  renderTabs();
  renderConnections();
});

/* =========================================================================
 * Lệnh nhanh
 * ========================================================================= */

function renderSnippets() {
  const list = $('snippet-list');
  list.textContent = '';
  if (state.snippets.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'snippet-empty';
    empty.textContent = 'Chưa có lệnh nào — lưu các lệnh hay dùng để bấm một phát là chạy.';
    list.appendChild(empty);
    return;
  }
  for (const snippet of state.snippets) {
    const chip = document.createElement('div');
    chip.className = 'snippet-chip';
    chip.title = snippet.command;

    const label = document.createElement('span');
    label.textContent = snippet.name;
    label.addEventListener('click', () => runSnippet(snippet));

    const edit = document.createElement('span');
    edit.className = 'chip-edit';
    edit.textContent = '✎';
    edit.title = 'Sửa';
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openSnippetModal(snippet.id);
    });

    chip.append(label, edit);
    list.appendChild(chip);
  }
}

function runSnippet(snippet) {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return setStatus('Chưa có phiên nào đang mở để gửi lệnh.', 'error');
  if (session.status !== 'connected') {
    return setStatus('Phiên hiện tại chưa kết nối.', 'error');
  }
  bridge.ssh.input(state.activeSessionId, snippet.command + (snippet.autoRun ? '\n' : ''));
  session.term.focus();
  setStatus('Đã gửi: ' + snippet.name, 'ok');
}

/* =========================================================================
 * Form kết nối
 * ========================================================================= */

function openConnectionModal(connId) {
  state.editingConnId = connId || null;
  const conn = connId ? state.connections.find((c) => c.id === connId) : null;

  $('conn-modal-title').textContent = conn ? 'Sửa kết nối' : 'Kết nối mới';
  $('f-name').value = conn ? conn.name : '';
  $('f-group').value = conn ? conn.group : '';
  $('f-host').value = conn ? conn.host : '';
  $('f-port').value = conn ? conn.port : 22;
  $('f-username').value = conn ? conn.username : '';
  $('f-keypath').value = conn ? conn.privateKeyPath : '';
  $('f-onconnect').value = conn ? conn.onConnect || '' : '';
  $('f-notes').value = conn ? conn.notes || '' : '';
  $('f-password').value = '';
  $('f-passphrase').value = '';
  $('password-note').hidden = !(conn && conn.hasPassword);
  $('passphrase-note').hidden = !(conn && conn.hasPassphrase);

  const authType = conn ? conn.authType : 'key';
  document.querySelector('input[name="authType"][value="' + authType + '"]').checked = true;
  syncAuthPanes();

  $('btn-conn-delete').hidden = !conn;
  clearError('conn-error');
  openModal('conn-modal');
  $('f-name').focus();
}

function syncAuthPanes() {
  const value = document.querySelector('input[name="authType"]:checked').value;
  $('auth-key').hidden = value !== 'key';
  $('auth-password').hidden = value !== 'password';
}

for (const radio of document.querySelectorAll('input[name="authType"]')) {
  radio.addEventListener('change', syncAuthPanes);
}

$('btn-pick-key').addEventListener('click', async () => {
  const picked = await call(bridge.dialogs.pickPrivateKey());
  if (picked) $('f-keypath').value = picked;
});

$('conn-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('conn-error');
  const payload = {
    id: state.editingConnId,
    name: $('f-name').value,
    group: $('f-group').value,
    host: $('f-host').value,
    port: $('f-port').value,
    username: $('f-username').value,
    authType: document.querySelector('input[name="authType"]:checked').value,
    privateKeyPath: $('f-keypath').value,
    password: $('f-password').value,
    passphrase: $('f-passphrase').value,
    onConnect: $('f-onconnect').value,
    notes: $('f-notes').value,
  };
  try {
    await call(bridge.connections.save(payload));
  } catch (err) {
    return showError('conn-error', err.message);
  }
  closeModal('conn-modal');
  await refreshAll();
  setStatus('Đã lưu kết nối.', 'ok');
});

$('btn-conn-delete').addEventListener('click', async () => {
  const conn = state.connections.find((c) => c.id === state.editingConnId);
  if (!conn) return;
  const confirmed = await call(
    bridge.dialogs.confirm('Xoá kết nối “' + conn.name + '”?', 'Thao tác này không thể hoàn tác.')
  );
  if (!confirmed) return;
  await call(bridge.connections.remove(conn.id));
  closeModal('conn-modal');
  await refreshAll();
  setStatus('Đã xoá kết nối.', 'ok');
});

/* =========================================================================
 * Form lệnh nhanh
 * ========================================================================= */

function openSnippetModal(snippetId) {
  state.editingSnippetId = snippetId || null;
  const snippet = snippetId ? state.snippets.find((s) => s.id === snippetId) : null;
  $('snippet-modal-title').textContent = snippet ? 'Sửa lệnh nhanh' : 'Lệnh nhanh mới';
  $('s-name').value = snippet ? snippet.name : '';
  $('s-command').value = snippet ? snippet.command : '';
  $('s-autorun').checked = snippet ? snippet.autoRun : true;
  $('btn-snippet-delete').hidden = !snippet;
  clearError('snippet-error');
  openModal('snippet-modal');
  $('s-name').focus();
}

$('snippet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('snippet-error');
  try {
    await call(
      bridge.snippets.save({
        id: state.editingSnippetId,
        name: $('s-name').value,
        command: $('s-command').value,
        autoRun: $('s-autorun').checked,
      })
    );
  } catch (err) {
    return showError('snippet-error', err.message);
  }
  closeModal('snippet-modal');
  state.snippets = await call(bridge.snippets.list());
  renderSnippets();
});

$('btn-snippet-delete').addEventListener('click', async () => {
  await call(bridge.snippets.remove(state.editingSnippetId));
  closeModal('snippet-modal');
  state.snippets = await call(bridge.snippets.list());
  renderSnippets();
});

/* =========================================================================
 * Bảng tìm nhanh (Ctrl+K)
 * ========================================================================= */

function openPalette() {
  $('palette-input').value = '';
  renderPalette('');
  openModal('palette');
  $('palette-input').focus();
}

function renderPalette(needle) {
  const query = needle.trim().toLowerCase();
  state.paletteItems = sortConnections(
    state.connections.filter((c) => matchesFilter(c, query))
  ).slice(0, 12);
  state.paletteIndex = 0;

  const box = $('palette-results');
  box.textContent = '';
  if (state.paletteItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = 'Không tìm thấy máy chủ nào.';
    box.appendChild(empty);
    return;
  }
  state.paletteItems.forEach((conn, index) => {
    const row = document.createElement('div');
    row.className = 'palette-item' + (index === 0 ? ' active' : '');
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = conn.name;
    const host = document.createElement('span');
    host.className = 'p-host';
    host.textContent = conn.username + '@' + conn.host;
    row.append(name, host);
    row.addEventListener('click', () => {
      closeModal('palette');
      openSession(conn.id);
    });
    box.appendChild(row);
  });
}

function movePalette(delta) {
  const rows = [...$('palette-results').children];
  if (rows.length === 0 || !rows[0].classList.contains('palette-item')) return;
  rows[state.paletteIndex].classList.remove('active');
  state.paletteIndex = (state.paletteIndex + delta + rows.length) % rows.length;
  rows[state.paletteIndex].classList.add('active');
  rows[state.paletteIndex].scrollIntoView({ block: 'nearest' });
}

$('palette-input').addEventListener('input', (event) => renderPalette(event.target.value));

$('palette-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    movePalette(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    movePalette(-1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const conn = state.paletteItems[state.paletteIndex];
    if (conn) {
      closeModal('palette');
      openSession(conn.id);
    }
  }
});

/* =========================================================================
 * Cài đặt
 * ========================================================================= */

async function openSettings() {
  const info = await call(bridge.app.info());
  const list = $('app-info');
  list.textContent = '';
  const rows = [
    ['Phiên bản', info.version],
    ['Vị trí kho', info.vaultPath],
    ['ssh-agent', info.agent || 'không phát hiện'],
    ['Nền tảng', info.platform],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  clearError('password-error');
  $('password-ok').hidden = true;
  openModal('settings-modal');
}

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('password-error');
  $('password-ok').hidden = true;
  try {
    await call(bridge.vault.changePassword($('p-old').value, $('p-new').value));
  } catch (err) {
    return showError('password-error', err.message);
  }
  $('p-old').value = '';
  $('p-new').value = '';
  $('password-ok').hidden = false;
});

/* =========================================================================
 * Nút và phím tắt
 * ========================================================================= */

$('btn-new').addEventListener('click', () => openConnectionModal(null));
$('btn-new-snippet').addEventListener('click', () => openSnippetModal(null));
$('btn-lock').addEventListener('click', lockVault);
$('btn-settings').addEventListener('click', openSettings);

$('btn-import').addEventListener('click', async () => {
  try {
    const result = await call(bridge.vault.importSshConfig());
    await refreshAll();
    setStatus(
      'Đã nhập ' + result.added + '/' + result.scanned + ' mục từ ~/.ssh/config.',
      result.added > 0 ? 'ok' : undefined
    );
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => closeModal(button.dataset.close));
}

// Bấm ra nền để đóng lớp phủ
for (const overlay of document.querySelectorAll('.overlay')) {
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) overlay.hidden = true;
  });
}

document.addEventListener('keydown', (event) => {
  const ctrl = event.ctrlKey || event.metaKey;

  if (event.key === 'Escape') {
    for (const overlay of document.querySelectorAll('.overlay')) overlay.hidden = true;
    return;
  }
  if ($('app').hidden) return; // đang ở màn hình khoá

  if (ctrl && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    openPalette();
  } else if (ctrl && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    openConnectionModal(null);
  } else if (ctrl && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    lockVault();
  } else if (ctrl && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    if (state.activeSessionId) closeSession(state.activeSessionId);
  } else if (ctrl && event.key === 'Tab') {
    event.preventDefault();
    const ids = [...state.sessions.keys()];
    if (ids.length > 1) {
      const next = (ids.indexOf(state.activeSessionId) + 1) % ids.length;
      activateSession(ids[next]);
    }
  }
});

// Cửa sổ đổi kích thước: đo lại terminal đang hiện
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const session = state.sessions.get(state.activeSessionId);
    if (session) session.fit.fit();
  }, 80);
});

initLockScreen().catch((err) => showError('lock-error', err.message));
