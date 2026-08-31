'use strict';

import {
  $,
  bridge,
  call,
  state,
  setStatus,
  openModal,
  closeModal,
  topModalId,
  isModalOpen,
  cancelInput,
  initInputModal,
  closeContextMenu,
  setButtonIcon,
  onRefresh,
  refreshAll,
} from './core.js';
import { initLock, initLockScreen, lockVault } from './lock.js';
import { initConnections, renderConnections, renderGroupOptions, openConnectionModal } from './connections.js';
import {
  initSessionEvents,
  initSearchBar,
  openSearchBar,
  closeSearchBar,
  renderTabs,
  closeSession,
  closeActiveWorkspace,
  splitActiveSession,
  focusPane,
  cycleWorkspace,
  activateWorkspaceByIndex,
  copyTerminalSelection,
  pasteTerminalClipboard,
  zoomTerminal,
  toggleSessionLog,
  openDashboard,
  refreshDashboard,
  stopDashboardTimer,
} from './sessions.js';
import { initSnippets, renderSnippets, openSnippetModal } from './snippets.js';
import { initPalette, openPalette } from './palette.js';
import { initSftp } from './sftp.js';
import { initTunnels } from './tunnels.js';
import { initSettings, openSettings } from './settings.js';

/* =========================================================================
 * Icon cho các nút công cụ
 * ========================================================================= */

function paintToolbarIcons() {
  setButtonIcon('btn-new', 'plus');
  setButtonIcon('btn-terminal-copy', 'copy');
  setButtonIcon('btn-terminal-paste', 'paste');
  setButtonIcon('btn-split-v', 'splitVertical');
  setButtonIcon('btn-split-h', 'splitHorizontal');
  setButtonIcon('btn-dashboard', 'dashboard');
  setButtonIcon('btn-sftp', 'transfer');
  setButtonIcon('btn-tunnels', 'tunnel');
  setButtonIcon('btn-session-log', 'record');
  setButtonIcon('btn-import', 'download');
  setButtonIcon('btn-settings', 'settings');
  setButtonIcon('btn-lock', 'lock');
  setButtonIcon('term-search-prev', 'chevronUp', 14);
  setButtonIcon('term-search-next', 'chevronDown', 14);
  setButtonIcon('term-search-close', 'close', 14);
  setButtonIcon('search-clear', 'close', 13);
}

/* =========================================================================
 * Nút cửa sổ (cửa sổ không khung nên trang tự vẽ)
 * ========================================================================= */

function bindWindowControl(id, action) {
  const button = $(id);
  // Không để pointerdown bị vùng titlebar draggable của Chromium nhận trước.
  button.addEventListener('pointerdown', (event) => event.stopPropagation());
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await call(action());
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });
}

/* =========================================================================
 * Escape và phím tắt
 * ========================================================================= */

async function handleEscape() {
  closeContextMenu();
  const top = topModalId();
  if (!top) {
    closeSearchBar();
    return;
  }
  if (top === 'input-modal') return cancelInput();
  if (top === 'dashboard-modal') stopDashboardTimer();
  if (top === 'conn-modal' && state.connFormDirty) {
    // Bỏ một form đang điền dở mà không hỏi là cách nhanh nhất để mất dữ liệu.
    const confirmed = await call(
      bridge.dialogs.confirm('Đóng form và bỏ thay đổi?', 'Những gì bạn vừa nhập sẽ không được lưu.'),
    );
    if (!confirmed) return;
    state.connFormDirty = false;
  }
  closeModal(top);
}

function onKeydown(event) {
  // Đang gõ tiếng Việt thì nhường toàn bộ phím cho bộ gõ; đặc biệt là Escape,
  // vốn dùng để huỷ từ đang soạn chứ không phải để đóng hộp thoại.
  if (event.isComposing || event.keyCode === 229) return;

  const ctrl = event.ctrlKey || event.metaKey;

  if (event.key === 'Escape') {
    event.preventDefault();
    handleEscape();
    return;
  }
  if ($('app').hidden) return; // đang ở màn hình khoá

  if (event.key === 'F1' || (ctrl && event.key === '/')) {
    event.preventDefault();
    openModal('shortcuts-modal');
    return;
  }

  // Hộp thoại đang mở thì chỉ nhường phím tắt toàn cục tối thiểu.
  if (isModalOpen() && topModalId() !== 'shortcuts-modal') {
    if (ctrl && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      lockVault();
    }
    return;
  }

  // Sao chép / dán theo quy ước GNOME Terminal: trong terminal, Ctrl+C là tín
  // hiệu ngắt tiến trình nên phải thêm Shift mới là sao chép.
  if ((ctrl && event.shiftKey && event.key.toLowerCase() === 'c') || (ctrl && event.key === 'Insert')) {
    event.preventDefault();
    copyTerminalSelection();
    return;
  }
  if ((ctrl && event.shiftKey && event.key.toLowerCase() === 'v') || (event.shiftKey && event.key === 'Insert')) {
    event.preventDefault();
    pasteTerminalClipboard();
    return;
  }

  if (ctrl && event.shiftKey && event.key.toLowerCase() === 'e') {
    event.preventDefault();
    splitActiveSession('vertical');
    return;
  }
  if (ctrl && event.shiftKey && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    splitActiveSession('horizontal');
    return;
  }

  if (ctrl && (event.key === '+' || event.key === '=')) {
    event.preventDefault();
    zoomTerminal(1);
    return;
  }
  if (ctrl && event.key === '-') {
    event.preventDefault();
    zoomTerminal(-1);
    return;
  }

  if (ctrl && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    openSearchBar();
    return;
  }

  if (event.altKey && !ctrl && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    focusPane(Number(event.key) - 1);
    return;
  }
  if (ctrl && !event.shiftKey && /^[1-9]$/.test(event.key)) {
    event.preventDefault();
    activateWorkspaceByIndex(Number(event.key) - 1);
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
  } else if (ctrl && event.shiftKey && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    closeActiveWorkspace();
  } else if (ctrl && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    if (state.activeSessionId) closeSession(state.activeSessionId);
  } else if (ctrl && event.key === 'Tab') {
    event.preventDefault();
    cycleWorkspace(event.shiftKey ? -1 : 1);
  }
}

/* =========================================================================
 * Khởi động
 * ========================================================================= */

function initShell() {
  paintToolbarIcons();

  bindWindowControl('wc-min', () => bridge.window.minimize());
  bindWindowControl('wc-close', () => bridge.window.close());
  bindWindowControl('wc-max', () => bridge.window.toggleMaximize());

  bridge.window.onStateChange(({ maximized }) => {
    document.body.classList.toggle('maximized', maximized);
    $('wc-max').title = maximized ? 'Khôi phục' : 'Phóng to';
  });

  bridge.app.onNotice((notice) => setStatus(notice.message, notice.kind));

  $('btn-new').addEventListener('click', () => openConnectionModal(null));
  $('btn-new-snippet').addEventListener('click', () => openSnippetModal(null));
  $('btn-lock').addEventListener('click', lockVault);
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-terminal-copy').addEventListener('click', copyTerminalSelection);
  $('btn-terminal-paste').addEventListener('click', pasteTerminalClipboard);
  $('btn-split-v').addEventListener('click', () => splitActiveSession('vertical'));
  $('btn-split-h').addEventListener('click', () => splitActiveSession('horizontal'));
  $('btn-dashboard').addEventListener('click', openDashboard);
  $('btn-session-log').addEventListener('click', toggleSessionLog);
  $('dashboard-refresh').addEventListener('click', refreshDashboard);
  $('btn-shortcuts').addEventListener('click', () => openModal('shortcuts-modal'));

  $('btn-import').addEventListener('click', async () => {
    try {
      const result = await call(bridge.vault.importSshConfig());
      await refreshAll();
      const parts = ['Đã nhập ' + result.added + '/' + result.scanned + ' mục từ ~/.ssh/config'];
      if (result.jumpsLinked) parts.push('nối ' + result.jumpsLinked + ' ProxyJump');
      if (result.errors && result.errors.length) {
        parts.push('bỏ qua ' + result.errors.length + ' mục lỗi: ' + result.errors.map((e) => e.alias).join(', '));
      }
      setStatus(parts.join(' · ') + '.', result.added > 0 ? 'ok' : undefined);
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => {
      if (button.dataset.close === 'dashboard-modal') stopDashboardTimer();
      if (button.dataset.close === 'conn-modal') state.connFormDirty = false;
      closeModal(button.dataset.close);
    });
  }

  // Bấm ra nền để đóng lớp phủ
  for (const overlay of document.querySelectorAll('.overlay')) {
    overlay.addEventListener('mousedown', (event) => {
      if (event.target !== overlay) return;
      if (overlay.id === 'input-modal') return cancelInput();
      if (overlay.id === 'dashboard-modal') stopDashboardTimer();
      if (overlay.id === 'conn-modal' && state.connFormDirty) return;
      closeModal(overlay.id);
    });
  }

  document.addEventListener('keydown', onKeydown);

  // Cửa sổ đổi kích thước: đo lại terminal đang hiện
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const active = state.sessions.get(state.activeSessionId);
      if (!active) return;
      for (const session of state.sessions.values()) {
        if (session.workspaceId === active.workspaceId) session.fit.fit();
      }
    }, 80);
  });

  // Main process giữ đồng hồ tự khoá; renderer chỉ báo "vẫn còn người dùng".
  let lastPing = 0;
  const ping = () => {
    const now = Date.now();
    if (now - lastPing < 5000) return;
    lastPing = now;
    bridge.vault.ping();
  };
  for (const eventName of ['pointerdown', 'keydown', 'wheel']) {
    document.addEventListener(eventName, ping, { passive: true });
  }

  // Lỗi ngoài dự kiến ở renderer phải nhìn thấy được, không im lặng trong console.
  window.addEventListener('error', (event) => {
    setStatus('Lỗi giao diện: ' + (event.message || 'không rõ'), 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    setStatus('Lỗi giao diện: ' + ((reason && reason.message) || String(reason)), 'error');
  });
}

onRefresh(() => {
  renderConnections();
  renderSnippets();
  renderGroupOptions();
  renderTabs();
});

initShell();
initInputModal();
initLock();
initConnections();
initSnippets();
initPalette();
initSftp();
initTunnels();
initSettings();
initSearchBar();
initSessionEvents();

initLockScreen().catch((err) => {
  $('lock-error').textContent = err.message;
  $('lock-error').hidden = false;
});
