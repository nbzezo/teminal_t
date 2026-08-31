'use strict';

/* global Terminal, FitAddon, SearchAddon */

const bridge = window.api;

const $ = (id) => document.getElementById(id);

/** Bóc phản hồi {ok, data, error} từ main process, ném lỗi nếu thất bại. */
async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) throw new Error((res && res.error) || 'Lỗi không xác định');
  return res.data;
}

/**
 * Bảng màu terminal mặc định của Ubuntu: nền tím cà #300A24 cùng bảng Tango.
 * Giữ nguyên trong cả chế độ sáng lẫn tối, đúng như GNOME Terminal trên Ubuntu.
 */
const TERM_THEME = {
  background: '#300A24',
  foreground: '#FFFFFF',
  cursor: '#FFFFFF',
  cursorAccent: '#300A24',
  selectionBackground: 'rgba(233, 84, 32, 0.45)',
  black: '#2E3436',
  red: '#CC0000',
  green: '#4E9A06',
  yellow: '#C4A000',
  blue: '#3465A4',
  magenta: '#75507B',
  cyan: '#06989A',
  white: '#D3D7CF',
  brightBlack: '#555753',
  brightRed: '#EF2929',
  brightGreen: '#8AE234',
  brightYellow: '#FCE94F',
  brightBlue: '#729FCF',
  brightMagenta: '#AD7FA8',
  brightCyan: '#34E2E2',
  brightWhite: '#EEEEEC',
};

const TERMINAL_FONTS = {
  'ubuntu-mono': '"Ubuntu Sans Mono", "Ubuntu Mono", monospace',
  cascadia: '"Cascadia Mono", "Cascadia Code", monospace',
  consolas: 'Consolas, monospace',
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
  settings: { autoLockMinutes: 15 },
  sftpPath: '/',
  sftpRoot: '/',
  activeTransferId: null,
};

/* =========================================================================
 * Tiện ích
 * ========================================================================= */

let toastTimer = null;

/** Thông báo nổi kiểu AdwToast: hiện giữa dưới rồi tự tắt. */
function setStatus(text, kind) {
  const toast = $('statusbar');
  $('status-text').textContent = text;
  toast.className = 'toast' + (kind === 'error' ? ' toast-error' : kind === 'ok' ? ' toast-ok' : '');
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    kind === 'error' ? 6000 : 3500,
  );
}

/** Cập nhật tiêu đề thanh trên theo phiên đang xem. */
function renderHeader() {
  const session = state.sessions.get(state.activeSessionId);
  const conn = session && state.connections.find((c) => c.id === session.connId);
  if (session && conn) {
    $('hb-title').textContent = conn.name;
    $('hb-subtitle').textContent = conn.username + '@' + conn.host + (conn.port !== 22 ? ':' + conn.port : '');
  } else {
    $('hb-title').textContent = 'SSH Manager';
    $('hb-subtitle').textContent = state.sessions.size ? state.sessions.size + ' phiên đang mở' : 'Chưa có phiên nào';
  }
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

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_EDIT =
  'M11.13 1.47a1.75 1.75 0 0 1 2.47 2.47l-.72.72-2.47-2.47ZM9.35 3.25l2.47 2.47-6.1 6.1-3.09.62.62-3.09Z';
const ICON_CLOSE =
  'M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94Z';

/** Dựng icon SVG kiểu symbolic của GNOME. */
function icon(pathData, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size || 16);
  svg.setAttribute('height', size || 16);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  return svg;
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
let autoLockTimer = null;

function scheduleAutoLock() {
  clearTimeout(autoLockTimer);
  if ($('app').hidden) return;
  const minutes = Number(state.settings.autoLockMinutes) || 15;
  autoLockTimer = setTimeout(() => lockVault(), minutes * 60 * 1000);
}

async function initLockScreen() {
  const status = await call(bridge.vault.status());
  lockMode = status.exists ? 'unlock' : 'setup';

  if (lockMode === 'setup') {
    $('lock-title').textContent = 'Tạo kho kết nối';
    $('lock-subtitle').textContent = 'Đặt master password để mã hoá toàn bộ máy chủ và mật khẩu đã lưu.';
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
  scheduleAutoLock();
  $('search').focus();
});

async function lockVault() {
  clearTimeout(autoLockTimer);
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
  state.settings = await call(bridge.vault.settings());
  renderConnections();
  renderSnippets();
  renderGroupOptions();
}

/**
 * Bỏ dấu tiếng Việt để gõ nhanh không dấu vẫn tìm ra máy có dấu.
 * NFD tách chữ cái khỏi dấu thanh thành hai ký tự rời, xoá dải dấu là xong;
 * riêng đ/Đ không phải chữ có dấu thanh nên phải thay tay.
 */
function boDau(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

function matchesFilter(conn, needle) {
  if (!needle) return true;
  const hay = boDau(
    [conn.name, conn.host, conn.username, conn.group, conn.environment, ...(conn.tags || []), conn.notes]
      .filter(Boolean)
      .join(' '),
  );
  return hay.includes(boDau(needle));
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

  for (const [groupName, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
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
  if (conn.environment === 'production') item.classList.add('production');
  if (conn.color) item.style.borderLeft = '3px solid ' + conn.color;
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
    conn.username +
    '@' +
    conn.host +
    (conn.port !== 22 ? ':' + conn.port : '') +
    ' · ' +
    authTag +
    (conn.environment === 'production' ? ' · PROD' : '');
  body.append(name, sub);

  const edit = document.createElement('button');
  edit.className = 'conn-edit';
  edit.type = 'button';
  edit.appendChild(icon(ICON_EDIT, 14));
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
    theme: { ...TERM_THEME, background: state.settings.terminalBackground || TERM_THEME.background },
    fontFamily: TERMINAL_FONTS[state.settings.terminalFontFamily] || TERMINAL_FONTS['ubuntu-mono'],
    fontSize: state.settings.terminalFontSize || 14,
    lineHeight: 1.1,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(pane);
  fit.fit();

  term.onData((data) => bridge.ssh.input(sessionId, data));
  term.onResize(({ cols, rows }) => bridge.ssh.resize(sessionId, cols, rows));

  const session = {
    connId,
    name: conn.name,
    term,
    fit,
    search,
    pane,
    status: 'connecting',
    manualClose: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
  };
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
  session.manualClose = true;
  clearTimeout(session.reconnectTimer);
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
    label.className = 'tab-label';
    label.textContent = session.name;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.type = 'button';
    close.appendChild(icon(ICON_CLOSE, 13));
    close.title = 'Đóng phiên (Ctrl+W)';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSession(sessionId);
    });

    tab.append(dot, label, close);
    tab.addEventListener('click', () => activateSession(sessionId));
    bar.appendChild(tab);
  }
  renderHeader();
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
    session.reconnectAttempts = 0;
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
    setStatus(status.message, 'ok');
  } else if (status.state === 'error') {
    session.status = 'gone';
    session.term.writeln('\r\n\x1b[31m✗ ' + status.message + '\x1b[0m');
    setStatus(status.message, 'error');
    scheduleReconnect(sessionId);
  } else if (status.state === 'closed' || status.state === 'ended') {
    session.status = 'gone';
    session.term.writeln('\r\n\x1b[90m— ' + status.message + ' —\x1b[0m');
    setStatus(status.message);
    scheduleReconnect(sessionId);
  } else if (status.state === 'connecting') {
    setStatus(status.message);
  }
  renderTabs();
  renderConnections();
});

function scheduleReconnect(sessionId) {
  const session = state.sessions.get(sessionId);
  const conn = session && state.connections.find((item) => item.id === session.connId);
  if (!session || !conn || !conn.autoReconnect || session.manualClose || session.reconnectTimer) return;
  if (session.reconnectAttempts >= 3) {
    setStatus('Đã dừng tự kết nối lại sau 3 lần thất bại.', 'error');
    return;
  }
  const delay = 1000 * 2 ** session.reconnectAttempts;
  session.reconnectAttempts += 1;
  session.term.writeln(
    '\r\n\x1b[33m— Kết nối lại lần ' + session.reconnectAttempts + ' sau ' + delay / 1000 + ' giây —\x1b[0m',
  );
  session.reconnectTimer = setTimeout(async () => {
    session.reconnectTimer = null;
    if (session.manualClose || !state.sessions.has(sessionId)) return;
    session.status = 'connecting';
    renderTabs();
    try {
      await call(
        bridge.ssh.reconnect(sessionId, session.connId, {
          cols: session.term.cols,
          rows: session.term.rows,
        }),
      );
    } catch (err) {
      session.status = 'gone';
      session.term.writeln('\r\n\x1b[31m✗ ' + err.message + '\x1b[0m');
      scheduleReconnect(sessionId);
    }
  }, delay);
}

/* =========================================================================
 * Lệnh nhanh
 * ========================================================================= */

function renderSnippets(query = $('snippet-search').value) {
  const list = $('snippet-list');
  list.textContent = '';
  const needle = String(query || '')
    .trim()
    .toLocaleLowerCase('vi');
  const snippets = state.snippets.filter(
    (snippet) =>
      !needle ||
      [snippet.name, snippet.group, snippet.command].some((value) =>
        String(value || '')
          .toLocaleLowerCase('vi')
          .includes(needle),
      ),
  );
  if (snippets.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'snippet-empty';
    empty.textContent = needle
      ? 'Không tìm thấy lệnh phù hợp.'
      : 'Chưa có lệnh nào — lưu các lệnh hay dùng để bấm một phát là chạy.';
    list.appendChild(empty);
    return;
  }
  for (const snippet of snippets) {
    const chip = document.createElement('div');
    chip.className = 'snippet-chip';
    chip.title = snippet.command;

    const label = document.createElement('span');
    label.className = 'chip-name';
    label.textContent = snippet.name;
    label.addEventListener('click', () => runSnippet(snippet));

    const edit = document.createElement('span');
    edit.className = 'chip-edit';
    edit.appendChild(icon(ICON_EDIT, 12));
    edit.title = 'Sửa';
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openSnippetModal(snippet.id);
    });

    chip.append(label, edit);
    list.appendChild(chip);
  }
}

async function runSnippet(snippet) {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return setStatus('Chưa có phiên nào đang mở để gửi lệnh.', 'error');
  if (session.status !== 'connected') {
    return setStatus('Phiên hiện tại chưa kết nối.', 'error');
  }
  let command = snippet.command;
  const variableNames = [
    ...new Set([...command.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g)].map((match) => match[1])),
  ];
  for (const name of variableNames) {
    const value = window.prompt('Giá trị cho ${' + name + '}:');
    if (value === null) return setStatus('Đã huỷ điền biến.', undefined);
    if (value.length > 1024 || /[\r\n\0]/.test(value)) return setStatus('Giá trị biến không hợp lệ.', 'error');
    command = command.replaceAll('${' + name + '}', value);
  }
  if (snippet.autoRun) {
    const confirmed = await call(
      bridge.dialogs.confirm(snippet.dangerous ? 'Lệnh có rủi ro cao — vẫn chạy?' : 'Chạy lệnh nhanh này?', command),
    );
    if (!confirmed) return setStatus('Đã huỷ lệnh.', undefined);
  }
  bridge.ssh.input(state.activeSessionId, command + (snippet.autoRun ? '\n' : ''));
  session.term.focus();
  setStatus('Đã gửi: ' + snippet.name, 'ok');
}

$('snippet-search').addEventListener('input', (event) => renderSnippets(event.target.value));

/* =========================================================================
 * Form kết nối
 * ========================================================================= */

function openConnectionModal(connId) {
  state.editingConnId = connId || null;
  const conn = connId ? state.connections.find((c) => c.id === connId) : null;

  $('conn-modal-title').textContent = conn ? 'Sửa kết nối' : 'Kết nối mới';
  $('f-name').value = conn ? conn.name : '';
  $('f-group').value = conn ? conn.group : '';
  $('f-environment').value = conn ? conn.environment || 'development' : 'development';
  $('f-tags').value = conn ? (conn.tags || []).join(', ') : '';
  $('f-color').value = conn && conn.color ? conn.color : '#e95420';
  $('f-favorite').checked = Boolean(conn && conn.favorite);
  $('f-host').value = conn ? conn.host : '';
  $('f-port').value = conn ? conn.port : 22;
  $('f-username').value = conn ? conn.username : '';
  $('f-keypath').value = conn ? conn.privateKeyPath : '';
  $('f-onconnect').value = conn ? conn.onConnect || '' : '';
  $('f-default-directory').value = conn ? conn.defaultDirectory || '' : '';
  $('f-sftp-root').value = conn ? conn.sftpRoot || '/' : '/';
  const jumpSelect = $('f-jump-host');
  jumpSelect.textContent = '';
  const noJump = document.createElement('option');
  noJump.value = '';
  noJump.textContent = 'Không dùng';
  jumpSelect.appendChild(noJump);
  for (const candidate of state.connections.filter((item) => item.id !== connId)) {
    const option = document.createElement('option');
    option.value = candidate.id;
    option.textContent = candidate.name + ' — ' + candidate.host;
    jumpSelect.appendChild(option);
  }
  jumpSelect.value = conn ? conn.jumpHostId || '' : '';
  $('f-timeout').value = conn ? conn.connectTimeout || 20000 : 20000;
  $('f-keepalive').value = conn ? (conn.keepaliveInterval ?? 20000) : 20000;
  $('f-auto-reconnect').checked = Boolean(conn && conn.autoReconnect);
  $('f-notes').value = conn ? conn.notes || '' : '';
  $('f-password').value = '';
  $('f-passphrase').value = '';
  $('password-note').hidden = !(conn && conn.hasPassword);
  $('passphrase-note').hidden = !(conn && conn.hasPassphrase);

  const authType = conn ? conn.authType : 'key';
  document.querySelector('input[name="authType"][value="' + authType + '"]').checked = true;
  syncAuthPanes();

  $('btn-conn-delete').hidden = !conn;
  $('btn-conn-duplicate').hidden = !conn;
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
    environment: $('f-environment').value,
    tags: $('f-tags').value,
    color: $('f-color').value,
    favorite: $('f-favorite').checked,
    host: $('f-host').value,
    port: $('f-port').value,
    username: $('f-username').value,
    authType: document.querySelector('input[name="authType"]:checked').value,
    privateKeyPath: $('f-keypath').value,
    password: $('f-password').value,
    passphrase: $('f-passphrase').value,
    onConnect: $('f-onconnect').value,
    defaultDirectory: $('f-default-directory').value,
    sftpRoot: $('f-sftp-root').value,
    jumpHostId: $('f-jump-host').value,
    connectTimeout: $('f-timeout').value,
    keepaliveInterval: $('f-keepalive').value,
    autoReconnect: $('f-auto-reconnect').checked,
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
    bridge.dialogs.confirm('Xoá kết nối “' + conn.name + '”?', 'Thao tác này không thể hoàn tác.'),
  );
  if (!confirmed) return;
  await call(bridge.connections.remove(conn.id));
  closeModal('conn-modal');
  await refreshAll();
  setStatus('Đã xoá kết nối.', 'ok');
});

$('btn-conn-duplicate').addEventListener('click', async () => {
  if (!state.editingConnId) return;
  await call(bridge.connections.duplicate(state.editingConnId));
  closeModal('conn-modal');
  await refreshAll();
  setStatus('Đã tạo bản sao kết nối.', 'ok');
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
  $('s-group').value = snippet ? snippet.group || '' : '';
  $('s-autorun').checked = snippet ? snippet.autoRun : false;
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
        group: $('s-group').value,
        autoRun: $('s-autorun').checked,
      }),
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
  state.paletteItems = sortConnections(state.connections.filter((c) => matchesFilter(c, query))).slice(0, 12);
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
  // Bộ gõ tiếng Việt đang soạn thảo: Enter và mũi tên lúc này thuộc về bộ gõ
  // (chốt từ, chọn ứng viên), không phải lệnh của ứng dụng.
  if (event.isComposing || event.keyCode === 229) return;

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
  state.settings = await call(bridge.vault.settings());
  $('auto-lock-minutes').value = state.settings.autoLockMinutes;
  $('clipboard-clear-seconds').value = state.settings.clipboardClearSeconds;
  $('terminal-font-family').value = state.settings.terminalFontFamily || 'ubuntu-mono';
  $('terminal-font-size').value = state.settings.terminalFontSize || 14;
  $('terminal-background').value = state.settings.terminalBackground || '#300a24';
  const list = $('app-info');
  list.textContent = '';
  const rows = [
    ['Phiên bản', info.version],
    ['Vị trí kho', info.vaultPath],
    ['ssh-agent', info.agent || 'không phát hiện'],
    ['Nền tảng', info.platformLabel + ' (' + info.platform + ')'],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  }
  clearError('password-error');
  clearError('backup-error');
  $('password-ok').hidden = true;
  await renderKnownHosts();
  openModal('settings-modal');
}

async function renderKnownHosts() {
  const container = $('known-hosts-list');
  container.textContent = '';
  const entries = await call(bridge.knownHosts.list());
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'row-note dim';
    empty.textContent = 'Chưa có host key nào được tin cậy.';
    container.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = entry.host + ' — ' + entry.fingerprint;
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'btn btn-flat btn-sm';
    forget.textContent = 'Quên';
    forget.addEventListener('click', async () => {
      const confirmed = await call(
        bridge.dialogs.confirm('Quên host key đã tin cậy?', entry.host + '\n' + entry.fingerprint),
      );
      if (!confirmed) return;
      await call(bridge.knownHosts.forget(entry.host));
      await renderKnownHosts();
    });
    row.append(label, forget);
    container.appendChild(row);
  }
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

$('security-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    state.settings = await call(
      bridge.vault.saveSettings({
        autoLockMinutes: Number($('auto-lock-minutes').value),
        clipboardClearSeconds: Number($('clipboard-clear-seconds').value),
        terminalFontFamily: $('terminal-font-family').value,
        terminalFontSize: Number($('terminal-font-size').value),
        terminalBackground: $('terminal-background').value,
      }),
    );
    for (const session of state.sessions.values()) {
      session.term.options.fontFamily = TERMINAL_FONTS[state.settings.terminalFontFamily];
      session.term.options.fontSize = state.settings.terminalFontSize;
      session.term.options.theme = { ...TERM_THEME, background: state.settings.terminalBackground };
      session.fit.fit();
    }
    scheduleAutoLock();
    setStatus('Đã lưu cài đặt.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

$('backup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError('backup-error');
  try {
    const result = await call(
      bridge.vault.exportBackup($('backup-password').value, {
        includeCredentials: $('backup-credentials').checked,
      }),
    );
    if (!result.canceled) setStatus('Đã xuất backup mã hoá.', 'ok');
  } catch (err) {
    showError('backup-error', err.message);
  } finally {
    $('backup-password').value = '';
  }
});

$('btn-import-backup').addEventListener('click', async () => {
  clearError('backup-error');
  const password = $('backup-password').value;
  try {
    const result = await call(bridge.vault.importBackup(password));
    if (!result.canceled) {
      await refreshAll();
      setStatus('Đã nhập ' + result.connectionsAdded + ' máy chủ và ' + result.snippetsAdded + ' snippet.', 'ok');
    }
  } catch (err) {
    showError('backup-error', err.message);
  } finally {
    $('backup-password').value = '';
  }
});

/* =========================================================================
 * Nút và phím tắt
 * ========================================================================= */

// --- Nút cửa sổ (cửa sổ không khung nên trang tự vẽ) ---
$('wc-min').addEventListener('click', () => bridge.window.minimize());
$('wc-close').addEventListener('click', () => bridge.window.close());
$('wc-max').addEventListener('click', () => bridge.window.toggleMaximize());

bridge.window.onStateChange(({ maximized }) => {
  document.body.classList.toggle('maximized', maximized);
  $('wc-max').title = maximized ? 'Khôi phục' : 'Phóng to';
});

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
      result.added > 0 ? 'ok' : undefined,
    );
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

function activeConnectedSession() {
  const session = state.sessions.get(state.activeSessionId);
  if (!session || session.status !== 'connected') {
    setStatus('Hãy chọn một phiên SSH đã kết nối.', 'error');
    return null;
  }
  return session;
}

async function loadSftp(remotePath) {
  const session = activeConnectedSession();
  if (!session) return;
  clearError('sftp-error');
  try {
    const result = await call(bridge.sftp.list(state.activeSessionId, remotePath));
    state.sftpPath = result.path;
    state.sftpRoot = result.root;
    $('sftp-path').value = result.path;
    const list = $('sftp-list');
    list.textContent = '';
    const sorted = [...result.items].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of sorted) {
      const row = document.createElement('div');
      row.className = 'sftp-row';
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'sftp-name';
      name.textContent = (item.type === 'directory' ? '📁 ' : '📄 ') + item.name;
      const fullPath = result.path.replace(/\/$/, '') + '/' + item.name;
      name.addEventListener('click', () => {
        if (item.type === 'directory') loadSftp(fullPath);
        else
          bridge.sftp
            .download(state.activeSessionId, fullPath)
            .then(call)
            .then((value) => {
              if (!value.canceled) {
                $('sftp-progress-row').hidden = true;
                state.activeTransferId = null;
                setStatus('Đã tải file xuống.', 'ok');
              }
            })
            .catch((err) => setStatus(err.message, 'error'));
      });
      const meta = document.createElement('span');
      meta.className = 'sftp-meta';
      meta.textContent = item.type === 'directory' ? 'thư mục' : item.size + ' B';
      const actions = document.createElement('div');
      actions.className = 'row-inline';
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'btn btn-flat btn-sm';
      rename.textContent = 'Đổi tên';
      rename.addEventListener('click', async () => {
        const next = window.prompt('Tên mới', item.name);
        if (!next || next === item.name) return;
        try {
          await call(bridge.sftp.rename(state.activeSessionId, fullPath, next));
          await loadSftp(result.path);
        } catch (err) {
          showError('sftp-error', err.message);
        }
      });
      const chmod = document.createElement('button');
      chmod.type = 'button';
      chmod.className = 'btn btn-flat btn-sm';
      chmod.textContent = 'Quyền';
      chmod.addEventListener('click', async () => {
        const mode = window.prompt('Permission dạng bát phân, ví dụ 644', '644');
        if (!mode) return;
        try {
          await call(bridge.sftp.chmod(state.activeSessionId, fullPath, mode));
          setStatus('Đã đổi permission.', 'ok');
        } catch (err) {
          showError('sftp-error', err.message);
        }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-destructive btn-sm';
      remove.textContent = 'Xoá';
      remove.addEventListener('click', async () => {
        try {
          const removed = await call(bridge.sftp.remove(state.activeSessionId, fullPath, item.type === 'directory'));
          if (removed) await loadSftp(result.path);
        } catch (err) {
          showError('sftp-error', err.message);
        }
      });
      actions.append(rename, chmod, remove);
      row.append(name, meta, actions);
      list.appendChild(row);
    }
  } catch (err) {
    showError('sftp-error', err.message);
  }
}

$('btn-sftp').addEventListener('click', async () => {
  const session = activeConnectedSession();
  if (!session) return;
  const conn = state.connections.find((item) => item.id === session.connId);
  state.sftpPath = (conn && conn.sftpRoot) || '/';
  openModal('sftp-modal');
  await loadSftp(state.sftpPath);
});
$('sftp-refresh').addEventListener('click', () => loadSftp($('sftp-path').value));
$('sftp-path').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    loadSftp(event.target.value);
  }
});
$('sftp-up').addEventListener('click', () => {
  if (state.sftpPath === state.sftpRoot) return;
  const parts = state.sftpPath.split('/').filter(Boolean);
  parts.pop();
  const parent = '/' + parts.join('/');
  loadSftp(parent.length < state.sftpRoot.length ? state.sftpRoot : parent);
});
$('sftp-upload').addEventListener('click', async () => {
  try {
    const result = await call(bridge.sftp.upload(state.activeSessionId, state.sftpPath));
    if (!result.canceled) {
      $('sftp-progress-row').hidden = true;
      state.activeTransferId = null;
      setStatus('Upload hoàn tất.', 'ok');
      await loadSftp(state.sftpPath);
    }
  } catch (err) {
    showError('sftp-error', err.message);
  }
});
$('sftp-mkdir').addEventListener('click', async () => {
  const name = window.prompt('Tên thư mục mới');
  if (!name) return;
  try {
    await call(bridge.sftp.mkdir(state.activeSessionId, state.sftpPath, name));
    await loadSftp(state.sftpPath);
  } catch (err) {
    showError('sftp-error', err.message);
  }
});
bridge.sftp.onProgress((progress) => {
  if (progress.sessionId !== state.activeSessionId) return;
  const percent = progress.total ? Math.round((progress.transferred / progress.total) * 100) : 0;
  state.activeTransferId = progress.transferId;
  $('sftp-progress-row').hidden = false;
  $('sftp-progress').textContent =
    'Đang truyền: ' + progress.transferred + '/' + progress.total + ' byte (' + percent + '%)';
});
$('sftp-cancel').addEventListener('click', async () => {
  if (!state.activeTransferId) return;
  try {
    await call(bridge.sftp.cancel(state.activeTransferId));
  } catch (err) {
    showError('sftp-error', err.message);
  }
  state.activeTransferId = null;
  $('sftp-progress-row').hidden = true;
});

async function renderTunnels() {
  const session = activeConnectedSession();
  if (!session) return;
  const conn = state.connections.find((item) => item.id === session.connId);
  const active = await call(bridge.tunnels.list(state.activeSessionId));
  const activeById = new Map(active.map((item) => [item.id, item]));
  const configs = [...((conn && conn.tunnels) || [])];
  for (const item of active) if (!configs.some((saved) => saved.id === item.id)) configs.push(item);
  const list = $('tunnel-list');
  list.textContent = '';
  for (const config of configs) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.className = 'row-label';
    if (config.type === 'dynamic') {
      label.textContent = 'SOCKS5 127.0.0.1:' + config.localPort;
    } else if (config.type === 'remote') {
      label.textContent =
        'R 127.0.0.1:' + config.remotePort + ' → local ' + config.destinationHost + ':' + config.destinationPort;
    } else {
      label.textContent =
        'L 127.0.0.1:' + config.localPort + ' → remote ' + config.destinationHost + ':' + config.destinationPort;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-flat btn-sm';
    button.textContent = activeById.has(config.id) ? 'Dừng' : 'Bật';
    button.addEventListener('click', async () => {
      try {
        if (activeById.has(config.id)) await call(bridge.tunnels.stop(config.id));
        else await call(bridge.tunnels.start(state.activeSessionId, config));
        await renderTunnels();
      } catch (err) {
        showError('tunnel-error', err.message);
      }
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-destructive btn-sm';
    remove.textContent = 'Xoá';
    remove.addEventListener('click', async () => {
      if (activeById.has(config.id)) await call(bridge.tunnels.stop(config.id));
      await call(bridge.connections.deleteTunnel(session.connId, config.id));
      await refreshAll();
      await renderTunnels();
    });
    row.append(label, button, remove);
    list.appendChild(row);
  }
}

$('btn-tunnels').addEventListener('click', async () => {
  if (!activeConnectedSession()) return;
  clearError('tunnel-error');
  openModal('tunnel-modal');
  await renderTunnels();
});
$('btn-session-log').addEventListener('click', async () => {
  if (!activeConnectedSession()) return;
  try {
    const active = await call(bridge.logs.status(state.activeSessionId));
    const changed = active
      ? await call(bridge.logs.stop(state.activeSessionId))
      : await call(bridge.logs.start(state.activeSessionId));
    if (changed) setStatus(active ? 'Đã dừng ghi log.' : 'Đang ghi log phiên.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});
$('t-type').addEventListener('change', () => {
  const type = $('t-type').value;
  $('t-port-label').textContent = type === 'remote' ? 'Remote port' : 'Local port';
  $('t-dest-host-row').hidden = type === 'dynamic';
  $('t-dest-port-row').hidden = type === 'dynamic';
  $('t-dest-host').required = type !== 'dynamic';
  $('t-dest-port').required = type !== 'dynamic';
});
$('tunnel-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const session = activeConnectedSession();
  if (!session) return;
  const type = $('t-type').value;
  const config = { type, name: type + ' ' + $('t-local-port').value };
  if (type === 'remote') config.remotePort = Number($('t-local-port').value);
  else config.localPort = Number($('t-local-port').value);
  if (type !== 'dynamic') {
    config.destinationHost = $('t-dest-host').value;
    config.destinationPort = Number($('t-dest-port').value);
  }
  try {
    const started = await call(bridge.tunnels.start(state.activeSessionId, config));
    await call(
      bridge.connections.saveTunnel(session.connId, {
        ...config,
        id: started.id,
      }),
    );
    await refreshAll();
    await renderTunnels();
    setStatus('Đã mở ' + (type === 'dynamic' ? 'SOCKS5 proxy.' : type + ' tunnel.'), 'ok');
  } catch (err) {
    showError('tunnel-error', err.message);
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
  // Đang gõ tiếng Việt thì nhường toàn bộ phím cho bộ gõ; đặc biệt là Escape,
  // vốn dùng để huỷ từ đang soạn chứ không phải để đóng hộp thoại.
  if (event.isComposing || event.keyCode === 229) return;

  const ctrl = event.ctrlKey || event.metaKey;

  if (event.key === 'Escape') {
    for (const overlay of document.querySelectorAll('.overlay')) overlay.hidden = true;
    return;
  }
  if ($('app').hidden) return; // đang ở màn hình khoá

  // Sao chép / dán theo quy ước GNOME Terminal: trong terminal, Ctrl+C là tín
  // hiệu ngắt tiến trình nên phải thêm Shift mới là sao chép.
  if (ctrl && event.shiftKey && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    const session = state.sessions.get(state.activeSessionId);
    if (session && session.term.hasSelection()) {
      const copied = session.term.getSelection();
      navigator.clipboard.writeText(copied);
      const clearAfter = Number(state.settings.clipboardClearSeconds) || 0;
      if (clearAfter > 0) {
        setTimeout(async () => {
          try {
            if ((await navigator.clipboard.readText()) === copied) await navigator.clipboard.writeText('');
          } catch {}
        }, clearAfter * 1000);
      }
      setStatus('Đã sao chép vùng chọn.', 'ok');
    }
    return;
  }
  if (ctrl && event.shiftKey && event.key.toLowerCase() === 'v') {
    event.preventDefault();
    if (state.activeSessionId) {
      navigator.clipboard.readText().then((text) => {
        if (text) bridge.ssh.input(state.activeSessionId, text);
      });
    }
    return;
  }

  if (ctrl && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    const session = state.sessions.get(state.activeSessionId);
    if (session) {
      const query = window.prompt('Tìm trong terminal');
      if (query) session.search.findNext(query, { caseSensitive: false });
      session.term.focus();
    }
    return;
  }

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

for (const eventName of ['pointerdown', 'keydown', 'wheel']) {
  document.addEventListener(eventName, scheduleAutoLock, { passive: true });
}

initLockScreen().catch((err) => showError('lock-error', err.message));
