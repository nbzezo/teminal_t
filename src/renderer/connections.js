'use strict';

import {
  $,
  bridge,
  call,
  state,
  setStatus,
  showError,
  clearError,
  icon,
  openModal,
  closeModal,
  showContextMenu,
  matchesFilter,
  sortConnections,
  connectionById,
  refreshAll,
} from './core.js';
import { openSession, liveCount } from './sessions.js';

/* =========================================================================
 * Danh sách máy chủ
 * ========================================================================= */

export function renderConnections() {
  const container = $('conn-list');
  container.textContent = '';
  const needle = state.filter.trim();
  const visible = state.connections.filter((conn) => matchesFilter(conn, needle));

  $('search-clear').hidden = !needle;
  $('search-count').textContent = needle ? visible.length + '/' + state.connections.length : '';

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
  updateRovingTabindex();
}

/** Đúng một item giữ tabIndex 0 để Tab vào danh sách rồi dùng mũi tên đi tiếp. */
function updateRovingTabindex() {
  const items = [...$('conn-list').querySelectorAll('.conn-item')];
  if (items.length === 0) return;
  const selected = items.find((item) => item.dataset.connId === state.selectedConnId) || items[0];
  for (const item of items) item.tabIndex = item === selected ? 0 : -1;
}

async function toggleFavorite(conn) {
  try {
    await call(bridge.connections.save({ ...conn, favorite: !conn.favorite, password: '', passphrase: '' }));
    await refreshAll();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function openConnectionMenu(event, conn) {
  showContextMenu({ x: event.clientX, y: event.clientY }, [
    { label: 'Kết nối', action: () => openSession(conn.id) },
    { label: conn.favorite ? 'Bỏ yêu thích' : 'Đánh dấu yêu thích', action: () => toggleFavorite(conn) },
    { separator: true },
    { label: 'Sửa…', action: () => openConnectionModal(conn.id) },
    { label: 'Nhân bản', action: () => duplicateConnection(conn.id) },
    { separator: true },
    { label: 'Xoá…', action: () => deleteConnection(conn.id), destructive: true },
  ]);
}

function connectionItem(conn) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'conn-item';
  item.dataset.connId = conn.id;
  if (conn.environment === 'production') item.classList.add('production');
  if (conn.color) item.style.borderLeft = '3px solid ' + conn.color;
  if (conn.id === state.selectedConnId) item.classList.add('selected');
  if (liveCount(conn.id) > 0) item.classList.add('live');
  item.title = conn.notes || conn.username + '@' + conn.host + ':' + conn.port;

  const dot = document.createElement('span');
  dot.className = 'conn-dot';

  const body = document.createElement('span');
  body.className = 'conn-body';
  const name = document.createElement('span');
  name.className = 'conn-name';
  name.textContent = conn.name;
  const sub = document.createElement('span');
  sub.className = 'conn-sub';
  const authTag = conn.authType === 'password' ? 'pw' : 'key';
  sub.textContent = conn.username + '@' + conn.host + (conn.port !== 22 ? ':' + conn.port : '') + ' · ' + authTag;
  body.append(name, sub);

  // Nhãn PROD nằm ngoài phần chữ bị cắt: đây đúng là thứ không được phép biến
  // mất khi tên máy chủ dài.
  const badge = document.createElement('span');
  if (conn.environment === 'production') {
    badge.className = 'conn-badge';
    badge.textContent = 'PROD';
  }

  const actions = document.createElement('span');
  actions.className = 'conn-actions';

  const favorite = document.createElement('span');
  favorite.className = 'conn-action conn-favorite' + (conn.favorite ? ' on' : '');
  favorite.setAttribute('role', 'button');
  favorite.tabIndex = -1;
  favorite.appendChild(icon(conn.favorite ? 'star' : 'starOutline', 14));
  favorite.title = conn.favorite ? 'Bỏ yêu thích' : 'Đánh dấu yêu thích';
  favorite.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavorite(conn);
  });

  const edit = document.createElement('span');
  edit.className = 'conn-action';
  edit.setAttribute('role', 'button');
  edit.tabIndex = -1;
  edit.appendChild(icon('edit', 14));
  edit.title = 'Sửa';
  edit.addEventListener('click', (event) => {
    event.stopPropagation();
    openConnectionModal(conn.id);
  });

  actions.append(favorite, edit);
  item.append(dot, body, badge, actions);
  item.addEventListener('click', () => {
    state.selectedConnId = conn.id;
    openSession(conn.id);
  });
  item.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openConnectionMenu(event, conn);
  });
  return item;
}

/** Mũi tên đi trong danh sách, Enter/Space kết nối — không cần chuột. */
function onListKeydown(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...$('conn-list').querySelectorAll('.conn-item')];
  if (items.length === 0) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement);
  let next = current;
  if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
  else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
  else if (event.key === 'Home') next = 0;
  else next = items.length - 1;
  for (const item of items) item.tabIndex = -1;
  items[next].tabIndex = 0;
  items[next].focus();
}

/* =========================================================================
 * Form kết nối
 * ========================================================================= */

export function renderGroupOptions() {
  const list = $('group-options');
  list.textContent = '';
  const groups = [...new Set(state.connections.map((conn) => conn.group).filter(Boolean))].sort();
  for (const group of groups) {
    const option = document.createElement('option');
    option.value = group;
    list.appendChild(option);
  }
}

function setColorControls(color) {
  const hasColor = Boolean(color);
  $('f-color-enabled').checked = hasColor;
  $('f-color').value = hasColor ? color : '#e95420';
  $('f-color').disabled = !hasColor;
}

export function openConnectionModal(connId) {
  state.editingConnId = connId || null;
  const conn = connId ? connectionById(connId) : null;

  $('conn-modal-title').textContent = conn ? 'Sửa kết nối' : 'Kết nối mới';
  $('f-name').value = conn ? conn.name : '';
  $('f-group').value = conn ? conn.group : '';
  $('f-environment').value = conn ? conn.environment || 'development' : 'development';
  $('f-tags').value = conn ? (conn.tags || []).join(', ') : '';
  setColorControls(conn ? conn.color : '');
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
  $('f-persistent-session').value = conn ? conn.persistentSession || '' : '';
  $('f-tmux-name').value = conn ? conn.tmuxSessionName || '' : '';
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
  state.connFormDirty = false;
  openModal('conn-modal');
  $('f-name').focus();
}

function syncAuthPanes() {
  const value = document.querySelector('input[name="authType"]:checked').value;
  $('auth-key').hidden = value !== 'key';
  $('auth-password').hidden = value !== 'password';
}

async function duplicateConnection(connId) {
  try {
    await call(bridge.connections.duplicate(connId));
    await refreshAll();
    setStatus('Đã tạo bản sao kết nối.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

/**
 * Xoá kết nối. Nếu nó đang là jump host của máy khác thì phải nói ra trước,
 * chứ không để người dùng phát hiện lúc đang cần kết nối gấp.
 */
export async function deleteConnection(connId) {
  const conn = connectionById(connId);
  if (!conn) return;
  let detail = 'Thao tác này không thể hoàn tác.';
  try {
    const users = await call(bridge.connections.jumpUsers(connId));
    if (users.length) {
      detail =
        'Máy chủ này đang là jump host của: ' +
        users.join(', ') +
        '.\nCác kết nối đó sẽ mất jump host và phải chọn lại.\n\n' +
        detail;
    }
  } catch {
    // Không tra được danh sách thì vẫn cho xoá, chỉ mất phần cảnh báo thêm.
  }
  const confirmed = await call(bridge.dialogs.confirm('Xoá kết nối “' + conn.name + '”?', detail));
  if (!confirmed) return;
  const result = await call(bridge.connections.remove(connId));
  closeModal('conn-modal');
  await refreshAll();
  setStatus(
    result && result.detached
      ? 'Đã xoá kết nối và gỡ jump host khỏi ' + result.detached + ' máy chủ.'
      : 'Đã xoá kết nối.',
    'ok',
  );
}

export function initConnections() {
  $('search').addEventListener('input', (event) => {
    state.filter = event.target.value;
    renderConnections();
  });
  $('search').addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && state.filter) {
      event.preventDefault();
      event.stopPropagation();
      clearSearchFilter();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      const first = $('conn-list').querySelector('.conn-item');
      if (first) first.focus();
    }
  });
  $('search-clear').addEventListener('click', clearSearchFilter);
  $('conn-list').addEventListener('keydown', onListKeydown);

  for (const radio of document.querySelectorAll('input[name="authType"]')) {
    radio.addEventListener('change', syncAuthPanes);
  }

  $('f-color-enabled').addEventListener('change', (event) => {
    $('f-color').disabled = !event.target.checked;
  });

  $('btn-pick-key').addEventListener('click', async () => {
    const picked = await call(bridge.dialogs.pickPrivateKey());
    if (picked) $('f-keypath').value = picked;
  });

  // Escape trên form đang sửa dở phải hỏi lại, không im lặng vứt dữ liệu.
  $('conn-form').addEventListener('input', () => {
    state.connFormDirty = true;
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
      color: $('f-color-enabled').checked ? $('f-color').value : '',
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
      persistentSession: $('f-persistent-session').value,
      tmuxSessionName: $('f-tmux-name').value.trim(),
      notes: $('f-notes').value,
    };
    try {
      await call(bridge.connections.save(payload));
    } catch (err) {
      return showError('conn-error', err.message);
    }
    state.connFormDirty = false;
    closeModal('conn-modal');
    await refreshAll();
    setStatus('Đã lưu kết nối.', 'ok');
  });

  $('btn-conn-delete').addEventListener('click', () => deleteConnection(state.editingConnId));
  $('btn-conn-duplicate').addEventListener('click', async () => {
    if (!state.editingConnId) return;
    const id = state.editingConnId;
    state.connFormDirty = false;
    closeModal('conn-modal');
    await duplicateConnection(id);
  });
}

function clearSearchFilter() {
  state.filter = '';
  $('search').value = '';
  renderConnections();
  $('search').focus();
}
