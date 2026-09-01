'use strict';

import {
  $,
  bridge,
  call,
  state,
  setStatus,
  showError,
  clearError,
  openModal,
  refreshAll,
} from './core.js';
import { applyTerminalAppearance } from './sessions.js';

/* =========================================================================
 * Tab trong hộp cài đặt
 * ========================================================================= */

function selectTab(name) {
  for (const tab of document.querySelectorAll('#settings-tabs [role="tab"]')) {
    const active = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
    tab.classList.toggle('active', active);
  }
  for (const panel of document.querySelectorAll('#settings-modal [data-panel]')) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

/* =========================================================================
 * Cài đặt
 * ========================================================================= */

function readSettingsForm() {
  const theme = document.querySelector('input[name="themeChoice"]:checked');
  return {
    autoLockMinutes: Number($('auto-lock-minutes').value),
    clipboardClearSeconds: Number($('clipboard-clear-seconds').value),
    terminalFontFamily: $('terminal-font-family').value,
    terminalFontSize: Number($('terminal-font-size').value),
    terminalBackground: $('terminal-background').value,
    theme: theme ? theme.value : 'system',
    copyOnSelect: $('setting-copy-on-select').checked,
    confirmOnExit: $('setting-confirm-exit').checked,
    restoreSessions: $('setting-restore-sessions').checked,
    diagnosticLog: $('setting-diagnostic-log').checked,
    persistentSessionDefault: $('setting-persistent-default').checked,
    tmuxMouse: $('setting-tmux-mouse').checked,
    tmuxHideStatus: $('setting-tmux-hide-status').checked,
    tmuxHistoryLimit: Number($('setting-tmux-history').value),
  };
}

function fillSettingsForm(settings) {
  $('auto-lock-minutes').value = settings.autoLockMinutes;
  $('clipboard-clear-seconds').value = settings.clipboardClearSeconds;
  $('terminal-font-family').value = settings.terminalFontFamily || 'ubuntu-mono';
  $('terminal-font-size').value = settings.terminalFontSize || 14;
  $('terminal-background').value = settings.terminalBackground || '#300a24';
  const theme = document.querySelector('input[name="themeChoice"][value="' + (settings.theme || 'system') + '"]');
  if (theme) theme.checked = true;
  $('setting-copy-on-select').checked = Boolean(settings.copyOnSelect);
  $('setting-confirm-exit').checked = settings.confirmOnExit !== false;
  $('setting-restore-sessions').checked = settings.restoreSessions !== false;
  $('setting-diagnostic-log').checked = Boolean(settings.diagnosticLog);
  $('setting-persistent-default').checked = Boolean(settings.persistentSessionDefault);
  $('setting-tmux-mouse').checked = settings.tmuxMouse !== false;
  $('setting-tmux-hide-status').checked = settings.tmuxHideStatus !== false;
  $('setting-tmux-history').value = settings.tmuxHistoryLimit || 50000;
}

let saveTimer = null;

/**
 * Cài đặt tự áp dụng ngay khi đổi, đúng kiểu hộp Preferences của GNOME —
 * thay vì ba nút Lưu ở ba chỗ khiến người dùng tưởng đã lưu hết.
 */
function scheduleSettingsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const next = await call(bridge.vault.saveSettings(readSettingsForm()));
      applyTerminalAppearance(next);
      state.settings = next;
      setStatus('Đã lưu cài đặt.', 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
      fillSettingsForm(state.settings);
    }
  }, 350);
}

/* =========================================================================
 * Host key đã tin cậy
 * ========================================================================= */

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
    label.className = 'row-label selectable';
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

/* =========================================================================
 * Mở hộp cài đặt
 * ========================================================================= */

export async function openSettings() {
  const info = await call(bridge.app.info());
  state.settings = await call(bridge.vault.settings());
  fillSettingsForm(state.settings);

  const list = $('app-info');
  list.textContent = '';
  const rows = [
    ['Phiên bản', info.version],
    ['Vị trí kho', info.vaultPath],
    ['Nhật ký chẩn đoán', info.diagnosticPath],
    ['ssh-agent', info.agent || 'không phát hiện'],
    ['Nền tảng', info.platformLabel + ' (' + info.platform + ')'],
  ];
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    // Đường dẫn là thứ người ta cần dán đi chỗ khác, nên phải bôi đen được.
    dd.className = 'selectable';
    dd.textContent = value;
    list.append(dt, dd);
  }
  clearError('password-error');
  clearError('backup-error');
  $('password-ok').hidden = true;
  await renderKnownHosts();
  selectTab('general');
  openModal('settings-modal');
}

export function initSettings() {
  for (const tab of document.querySelectorAll('#settings-tabs [role="tab"]')) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('#settings-tabs [role="tab"]')];
      const index = tabs.indexOf(tab);
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      selectTab(next.dataset.tab);
    });
  }

  for (const id of [
    'auto-lock-minutes',
    'clipboard-clear-seconds',
    'terminal-font-family',
    'terminal-font-size',
    'terminal-background',
    'setting-copy-on-select',
    'setting-confirm-exit',
    'setting-restore-sessions',
    'setting-diagnostic-log',
    'setting-persistent-default',
    'setting-tmux-mouse',
    'setting-tmux-hide-status',
    'setting-tmux-history',
  ]) {
    $(id).addEventListener('change', scheduleSettingsSave);
  }
  for (const radio of document.querySelectorAll('input[name="themeChoice"]')) {
    radio.addEventListener('change', () => {
      call(bridge.app.setTheme(radio.value)).catch(() => {});
      scheduleSettingsSave();
    });
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
}
