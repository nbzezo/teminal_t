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
  askInput,
  showContextMenu,
  connectionById,
  requireConnectedSession,
  formatBytes,
  formatTimestamp,
} from './core.js';

const SORT_LABELS = { name: 'Tên', size: 'Kích thước', mtime: 'Sửa lúc' };

function comparator() {
  const { key, direction } = state.sftpSort;
  return (a, b) => {
    // Thư mục luôn đứng trên, đúng thói quen của mọi trình duyệt file.
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    if (key === 'size') return (a.size - b.size) * direction;
    if (key === 'mtime') return (a.mtime - b.mtime) * direction;
    return a.name.localeCompare(b.name, 'vi') * direction;
  };
}

/** Đường dẫn dạng nút bấm được, thay cho ô text phải tự gõ. */
function renderBreadcrumb(currentPath, root) {
  const bar = $('sftp-breadcrumb');
  bar.textContent = '';

  const addCrumb = (label, target, isCurrent) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb' + (isCurrent ? ' current' : '');
    button.textContent = label;
    if (isCurrent) button.setAttribute('aria-current', 'location');
    else button.addEventListener('click', () => loadSftp(target));
    bar.appendChild(button);
  };

  addCrumb(root === '/' ? '/' : root, root, currentPath === root);
  if (currentPath === root) return;
  const relative = currentPath.slice(root === '/' ? 1 : root.length + 1);
  const parts = relative.split('/').filter(Boolean);
  let walked = root === '/' ? '' : root;
  parts.forEach((part, index) => {
    walked += '/' + part;
    const separator = document.createElement('span');
    separator.className = 'crumb-sep';
    separator.textContent = '/';
    separator.setAttribute('aria-hidden', 'true');
    bar.appendChild(separator);
    addCrumb(part, walked, index === parts.length - 1);
  });
}

function rowActions(item, fullPath, currentPath) {
  return [
    {
      label: item.type === 'directory' ? 'Mở' : 'Tải xuống',
      action: () => (item.type === 'directory' ? loadSftp(fullPath) : downloadFile(fullPath)),
    },
    { separator: true },
    { label: 'Đổi tên…', action: () => renameEntry(item, fullPath, currentPath) },
    { label: 'Đổi permission…', action: () => chmodEntry(item, fullPath) },
    { separator: true },
    {
      label: 'Xoá…',
      destructive: true,
      action: () => removeEntry(item, fullPath, currentPath),
    },
  ];
}

async function downloadFile(fullPath) {
  try {
    const value = await call(bridge.sftp.download(state.activeSessionId, fullPath));
    if (!value.canceled) {
      $('sftp-progress-row').hidden = true;
      state.activeTransferId = null;
      setStatus('Đã tải file xuống.', 'ok');
    }
  } catch (err) {
    showError('sftp-error', err.message);
  }
}

async function renameEntry(item, fullPath, currentPath) {
  const next = await askInput({
    title: 'Đổi tên',
    label: 'Tên mới',
    value: item.name,
    confirmLabel: 'Đổi tên',
  });
  if (next === null || !next.trim() || next === item.name) return;
  try {
    await call(bridge.sftp.rename(state.activeSessionId, fullPath, next.trim()));
    await loadSftp(currentPath);
    setStatus('Đã đổi tên.', 'ok');
  } catch (err) {
    showError('sftp-error', err.message);
  }
}

async function chmodEntry(item, fullPath) {
  const current = (item.mode & 0o7777).toString(8).padStart(3, '0');
  const mode = await askInput({
    title: 'Đổi permission',
    label: 'Permission dạng bát phân',
    value: current,
    placeholder: '644',
    hint: 'Ví dụ 644 cho file, 755 cho thư mục.',
    confirmLabel: 'Áp dụng',
  });
  if (mode === null || !mode.trim()) return;
  try {
    await call(bridge.sftp.chmod(state.activeSessionId, fullPath, mode.trim()));
    setStatus('Đã đổi permission.', 'ok');
  } catch (err) {
    showError('sftp-error', err.message);
  }
}

async function removeEntry(item, fullPath, currentPath) {
  try {
    const removed = await call(bridge.sftp.remove(state.activeSessionId, fullPath, item.type === 'directory'));
    if (removed) await loadSftp(currentPath);
  } catch (err) {
    showError('sftp-error', err.message);
  }
}

async function loadSftp(remotePath) {
  const session = requireConnectedSession();
  if (!session) return;
  clearError('sftp-error');
  try {
    const result = await call(bridge.sftp.list(state.activeSessionId, remotePath));
    state.sftpPath = result.path;
    state.sftpRoot = result.root;
    renderBreadcrumb(result.path, result.root);
    $('sftp-up').disabled = result.path === result.root;

    const list = $('sftp-list');
    list.textContent = '';
    const sorted = [...result.items].sort(comparator());
    if (sorted.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'row-note dim';
      empty.textContent = 'Thư mục trống.';
      list.appendChild(empty);
      return;
    }
    for (const item of sorted) {
      const fullPath = result.path.replace(/\/$/, '') + '/' + item.name;
      const row = document.createElement('div');
      row.className = 'sftp-row';

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'sftp-name';
      name.appendChild(icon(item.type === 'directory' ? 'folder' : item.type === 'symlink' ? 'symlink' : 'file', 15));
      const text = document.createElement('span');
      text.textContent = item.name;
      name.appendChild(text);
      name.addEventListener('click', () => {
        if (item.type === 'directory') loadSftp(fullPath);
        else downloadFile(fullPath);
      });

      const size = document.createElement('span');
      size.className = 'sftp-meta';
      size.textContent = item.type === 'directory' ? '—' : formatBytes(item.size);

      const modified = document.createElement('span');
      modified.className = 'sftp-meta';
      modified.textContent = formatTimestamp(item.mtime);

      const menu = document.createElement('button');
      menu.type = 'button';
      menu.className = 'btn btn-flat btn-icon';
      menu.appendChild(icon('kebab', 15));
      menu.title = 'Thao tác với ' + item.name;
      menu.setAttribute('aria-label', 'Thao tác với ' + item.name);
      const openMenu = (event) => {
        const rect = menu.getBoundingClientRect();
        showContextMenu(
          { x: event.clientX || rect.left, y: event.clientY || rect.bottom },
          rowActions(item, fullPath, result.path),
        );
      };
      menu.addEventListener('click', openMenu);
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openMenu(event);
      });

      row.append(name, size, modified, menu);
      list.appendChild(row);
    }
  } catch (err) {
    showError('sftp-error', err.message);
  }
}

function setSort(key) {
  if (state.sftpSort.key === key) state.sftpSort.direction *= -1;
  else state.sftpSort = { key, direction: 1 };
  for (const button of document.querySelectorAll('.sftp-head [data-sort]')) {
    const active = button.dataset.sort === state.sftpSort.key;
    button.setAttribute('aria-sort', active ? (state.sftpSort.direction > 0 ? 'ascending' : 'descending') : 'none');
    button.classList.toggle('sorted', active);
    button.textContent = '';
    button.append(SORT_LABELS[button.dataset.sort]);
    if (active) button.appendChild(icon(state.sftpSort.direction > 0 ? 'chevronDown' : 'chevronUp', 12));
  }
  loadSftp(state.sftpPath);
}

export function initSftp() {
  $('btn-sftp').addEventListener('click', async () => {
    const session = requireConnectedSession();
    if (!session) return;
    const conn = connectionById(session.connId);
    state.sftpPath = (conn && conn.sftpRoot) || '/';
    openModal('sftp-modal');
    await loadSftp(state.sftpPath);
  });

  $('sftp-refresh').addEventListener('click', () => loadSftp(state.sftpPath));
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
        setStatus(
          result.uploaded === 1 ? 'Upload hoàn tất.' : 'Đã upload ' + result.uploaded + ' file.',
          result.uploaded ? 'ok' : undefined,
        );
        await loadSftp(state.sftpPath);
      }
    } catch (err) {
      showError('sftp-error', err.message);
    }
  });

  $('sftp-mkdir').addEventListener('click', async () => {
    const name = await askInput({
      title: 'Thư mục mới',
      label: 'Tên thư mục',
      placeholder: 'ten-thu-muc',
      confirmLabel: 'Tạo',
      selectAll: false,
    });
    if (name === null || !name.trim()) return;
    try {
      await call(bridge.sftp.mkdir(state.activeSessionId, state.sftpPath, name.trim()));
      await loadSftp(state.sftpPath);
      setStatus('Đã tạo thư mục.', 'ok');
    } catch (err) {
      showError('sftp-error', err.message);
    }
  });

  for (const button of document.querySelectorAll('.sftp-head [data-sort]')) {
    button.addEventListener('click', () => setSort(button.dataset.sort));
  }

  bridge.sftp.onProgress((progress) => {
    if (progress.sessionId !== state.activeSessionId) return;
    const percent = progress.total ? Math.round((progress.transferred / progress.total) * 100) : 0;
    state.activeTransferId = progress.transferId;
    $('sftp-progress-row').hidden = false;
    $('sftp-progress').textContent =
      'Đang truyền ' + formatBytes(progress.transferred) + ' / ' + formatBytes(progress.total) + ' (' + percent + '%)';
    $('sftp-progress-bar').style.width = percent + '%';
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
}
