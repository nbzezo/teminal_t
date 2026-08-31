'use strict';

import { $, bridge, call, state, showError, clearError, icon, refreshAll } from './core.js';
import { closeAllSessions, restoreWorkspace, stopDashboardTimer } from './sessions.js';

const MIN_MASTER_PASSWORD = 12;

let lockMode = 'unlock'; // 'unlock' | 'setup'

/**
 * Ước lượng độ mạnh rất thô: đủ để can một mật khẩu tệ, không giả vờ là
 * một mô hình entropy nghiêm túc.
 */
function strengthOf(password) {
  if (!password) return { score: 0, label: '' };
  let score = 0;
  if (password.length >= MIN_MASTER_PASSWORD) score += 1;
  if (password.length >= 16) score += 1;
  if (password.length >= 24) score += 1;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (classes >= 3) score += 1;
  if (/(.)\1{3,}/.test(password) || /^[a-z]+$/i.test(password)) score -= 1;
  score = Math.max(0, Math.min(4, score));
  return { score, label: ['rất yếu', 'yếu', 'tạm được', 'khá', 'mạnh'][score] };
}

function renderStrength() {
  if (lockMode !== 'setup') return;
  const { score, label } = strengthOf($('lock-password').value);
  const meter = $('lock-strength');
  meter.hidden = !$('lock-password').value;
  meter.dataset.score = String(score);
  $('lock-strength-label').textContent = label ? 'Độ mạnh: ' + label : '';
}

function updateCapsLock(event) {
  const on = typeof event.getModifierState === 'function' && event.getModifierState('CapsLock');
  $('lock-caps').hidden = !on;
}

function applyMode() {
  if (lockMode === 'setup') {
    $('lock-title').textContent = 'Tạo kho kết nối';
    $('lock-subtitle').textContent = 'Đặt master password để mã hoá toàn bộ máy chủ và mật khẩu đã lưu.';
    $('lock-password').placeholder = 'Master password (tối thiểu ' + MIN_MASTER_PASSWORD + ' ký tự)';
    $('lock-password').setAttribute('autocomplete', 'new-password');
    $('lock-password-confirm').hidden = false;
    $('lock-password-confirm').required = true;
    $('lock-submit').textContent = 'Tạo kho';
    $('lock-hint').hidden = false;
  } else {
    $('lock-title').textContent = 'Mở kho kết nối';
    $('lock-subtitle').textContent = 'Nhập master password để giải mã kho.';
    $('lock-password').placeholder = 'Master password';
    $('lock-password').setAttribute('autocomplete', 'current-password');
    $('lock-password-confirm').hidden = true;
    $('lock-password-confirm').required = false;
    $('lock-submit').textContent = 'Mở khoá';
    $('lock-hint').hidden = true;
    $('lock-strength').hidden = true;
  }
}

export async function initLockScreen() {
  const status = await call(bridge.vault.status());
  lockMode = status.exists ? 'unlock' : 'setup';
  applyMode();
  $('lock-password').focus();
}

/** Đưa giao diện về màn hình khoá; kho đã bị khoá ở main trước đó. */
function showLockScreen() {
  stopDashboardTimer();
  closeAllSessions();
  state.connections = [];
  state.snippets = [];
  $('app').hidden = true;
  $('lock-screen').hidden = false;
  lockMode = 'unlock';
  applyMode();
  $('lock-password').value = '';
  $('lock-password-confirm').value = '';
  $('lock-caps').hidden = true;
  $('lock-password').focus();
}

export async function lockVault() {
  await call(bridge.vault.lock());
  showLockScreen();
}

export function initLock() {
  const password = $('lock-password');
  password.addEventListener('input', renderStrength);
  password.addEventListener('keyup', updateCapsLock);
  password.addEventListener('keydown', updateCapsLock);
  $('lock-password-confirm').addEventListener('keyup', updateCapsLock);

  $('lock-reveal').addEventListener('click', () => {
    const reveal = $('lock-reveal');
    const shown = password.type === 'text';
    password.type = shown ? 'password' : 'text';
    reveal.setAttribute('aria-pressed', shown ? 'false' : 'true');
    reveal.title = shown ? 'Hiện mật khẩu' : 'Ẩn mật khẩu';
    password.focus();
  });
  $('lock-reveal').appendChild(icon('eye', 15));

  $('lock-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError('lock-error');
    const value = password.value;

    try {
      if (lockMode === 'setup') {
        if (value !== $('lock-password-confirm').value) {
          return showError('lock-error', 'Hai mật khẩu không khớp.');
        }
        await call(bridge.vault.init(value));
      } else {
        await call(bridge.vault.unlock(value));
      }
    } catch (err) {
      return showError('lock-error', err.message);
    }

    password.value = '';
    password.type = 'password';
    $('lock-password-confirm').value = '';
    $('lock-strength').hidden = true;
    $('lock-screen').hidden = true;
    $('app').hidden = false;
    await refreshAll();
    await restoreWorkspace();
    $('search').focus();
  });

  bridge.vault.onLocked(() => {
    if ($('app').hidden) return;
    showLockScreen();
    showError('lock-error', 'Kho đã tự khoá sau thời gian không hoạt động.');
  });
}
