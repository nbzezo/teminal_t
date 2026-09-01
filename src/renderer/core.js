'use strict';

/**
 * Nền chung của renderer: cầu nối IPC, state chia sẻ, và những mảnh giao diện
 * mà mọi màn hình đều dùng (toast, hộp thoại, icon, menu chuột phải).
 * Module này không import module nào khác của ứng dụng để không tạo vòng phụ thuộc.
 */

export const bridge = window.api;

export const $ = (id) => document.getElementById(id);

/** Bóc phản hồi {ok, data, error} từ main process, ném lỗi nếu thất bại. */
export async function call(promise) {
  const res = await promise;
  if (!res || !res.ok) throw new Error((res && res.error) || 'Lỗi không xác định');
  return res.data;
}

/**
 * Bảng màu terminal mặc định của Ubuntu: nền tím cà #300A24 cùng bảng Tango.
 * Giữ nguyên trong cả chế độ sáng lẫn tối, đúng như GNOME Terminal trên Ubuntu.
 */
export const TERM_THEME = {
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

export const TERMINAL_FONTS = {
  'ubuntu-mono': '"Ubuntu Sans Mono", "Ubuntu Mono", monospace',
  cascadia: '"Cascadia Mono", "Cascadia Code", monospace',
  consolas: 'Consolas, monospace',
};

export const state = {
  connections: [],
  snippets: [],
  /** sessionId -> { connId, name, term, fit, search, pane, status, workspaceId, … } */
  sessions: new Map(),
  /** workspaceId -> { layout, activeSessionId, name, autoName, tabIndexByConn }
   *  — một tab là một công việc, các pane trong đó có thể ở những máy chủ khác
   *  nhau; tabIndexByConn giữ số tab của từng máy chủ để đặt tên phiên tmux. */
  workspaces: new Map(),
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
  sftpSort: { key: 'name', direction: 1 },
  activeTransferId: null,
  dashboardTimer: null,
  connFormDirty: false,
};

/* =========================================================================
 * Thông báo
 * ========================================================================= */

let toastTimer = null;

/** Thông báo nổi kiểu AdwToast: hiện giữa dưới rồi tự tắt. */
/**
 * @param {string} text
 * @param {string} [kind] 'error' | 'ok'
 * @param {{label: string, onClick: Function}} [action] Nút trên toast. Toast có
 *   nút thì ở lại lâu hơn hẳn — biến mất sau 3,5 giây thì nút trên nó vô nghĩa —
 *   nhưng vẫn tự ẩn, vì một toast dính vĩnh viễn còn tệ hơn một nút bị lỡ.
 */
export function setStatus(text, kind, action) {
  const toast = $('statusbar');
  const button = $('status-action');
  $('status-text').textContent = text;
  toast.className = 'toast' + (kind === 'error' ? ' toast-error' : kind === 'ok' ? ' toast-ok' : '');
  toast.hidden = false;

  button.hidden = !action;
  button.onclick = null;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => {
      toast.hidden = true;
      action.onClick();
    };
  }

  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    action ? 20000 : kind === 'error' ? 6000 : 3500,
  );
}

export function showError(elId, message) {
  const el = $(elId);
  el.textContent = message;
  el.hidden = false;
}

export function clearError(elId) {
  $(elId).hidden = true;
}

/* =========================================================================
 * Icon
 * ========================================================================= */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Icon dạng symbolic của GNOME. Mỗi icon là danh sách sub-path; icon có lỗ
 * (khung, vòng) dùng fill-rule evenodd để phần trong thành khoảng trống.
 */
const ICONS = {
  edit: ['M11.13 1.47a1.75 1.75 0 0 1 2.47 2.47l-.72.72-2.47-2.47ZM9.35 3.25l2.47 2.47-6.1 6.1-3.09.62.62-3.09Z'],
  close: [
    'M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94Z',
  ],
  plus: ['M7.25 2.5h1.5v4.75h4.75v1.5H8.75v4.75h-1.5V8.75H2.5v-1.5h4.75Z'],
  copy: [
    'M4 6h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm.5 1.5v4h4v-4Z',
    'M6 3h5a2 2 0 0 1 2 2v5h-1.5V5a.5.5 0 0 0-.5-.5H6Z',
  ],
  paste: [
    'M4 3.5h8a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Zm.5 1.5v7.5h7V5Z',
    'M6.5 1.5h3a1 1 0 0 1 1 1V4h-5V2.5a1 1 0 0 1 1-1Z',
  ],
  splitVertical: [
    'M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 11V5A1.5 1.5 0 0 1 3 3.5ZM3 5v6h4V5Zm6 0v6h4V5Z',
  ],
  splitHorizontal: [
    'M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 11V5A1.5 1.5 0 0 1 3 3.5ZM3 5v2.25h10V5Zm0 3.75V11h10V8.75Z',
  ],
  dashboard: [
    'M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM3 4v8h10V4Z',
    'M4.5 9h1.5v2H4.5zM7.25 6.5h1.5V11h-1.5zM10 8h1.5v3H10z',
  ],
  // Hai khung xếp chồng: phiên vẫn còn đó sau khi đóng cửa sổ này.
  persist: [
    'M1.5 6.5A1.5 1.5 0 0 1 3 5h6a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 9 14H3a1.5 1.5 0 0 1-1.5-1.5Zm1.5 0v6h6v-6Z',
    'M5 2h8a1.5 1.5 0 0 1 1.5 1.5V11H13V3.5H5Z',
  ],
  transfer: ['M9.5 2.6 13.4 5.5 9.5 8.4V6.5H2.6v-2H9.5Z', 'M6.5 7.6 2.6 10.5 6.5 13.4V11.5h6.9v-2H6.5Z'],
  tunnel: ['M1.8 8 5 5.4v5.2Z', 'M14.2 8 11 10.6V5.4Z', 'M4.6 7h6.8v2H4.6z'],
  record: [
    'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z',
    'M8 5.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z',
  ],
  download: [
    'M8 1.75a.75.75 0 0 1 .75.75v5.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2.5A.75.75 0 0 1 8 1.75ZM2.75 10a.75.75 0 0 1 .75.75v1.75h9v-1.75a.75.75 0 0 1 1.5 0v2.5a.75.75 0 0 1-.75.75h-10.5a.75.75 0 0 1-.75-.75v-2.5a.75.75 0 0 1 .75-.75Z',
  ],
  settings: [
    'M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5Zm0 1.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
    'm6.9 1.5-.28 1.53a5.5 5.5 0 0 0-1.06.61L4.1 3.1 2.6 5.7l1.19.99a5.6 5.6 0 0 0 0 1.22L2.6 8.9l1.5 2.6 1.46-.54c.33.25.69.45 1.06.61l.28 1.53h3l.28-1.53c.37-.16.73-.36 1.06-.61l1.46.54 1.5-2.6-1.19-.99a5.6 5.6 0 0 0 0-1.22l1.19-.99-1.5-2.6-1.46.54a5.5 5.5 0 0 0-1.06-.61L9.9 1.5Zm1.1 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  ],
  lock: [
    'M8 1a3.5 3.5 0 0 0-3.5 3.5V6H4a1.5 1.5 0 0 0-1.5 1.5v5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 12 6h-.5V4.5A3.5 3.5 0 0 0 8 1Zm0 1.5a2 2 0 0 1 2 2V6H6V4.5a2 2 0 0 1 2-2Z',
  ],
  search: [
    'M7 2a5 5 0 1 0 3.09 8.93l2.99 2.99a.75.75 0 1 0 1.06-1.06l-2.99-2.99A5 5 0 0 0 7 2Zm0 1.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z',
  ],
  folder: ['M2 4.5A1.5 1.5 0 0 1 3.5 3h2.2l1.2 1.5h5.6A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5Z'],
  file: ['M4 1.5h4.6L12.5 5.4V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5Zm4.5 1.7v2.3h2.3Z'],
  symlink: [
    'M4 1.5h4.6L12.5 5.4V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5Zm4.5 1.7v2.3h2.3Z',
    'M5 9.25h3.4V7.6l2.6 2.4-2.6 2.4v-1.65H5Z',
  ],
  star: ['M8 1.8l1.9 3.85 4.25.62-3.08 3 .73 4.23L8 11.5l-3.8 2 .73-4.23-3.08-3 4.25-.62Z'],
  starOutline: [
    'M8 1.8l1.9 3.85 4.25.62-3.08 3 .73 4.23L8 11.5l-3.8 2 .73-4.23-3.08-3 4.25-.62Zm0 3.4L7 7.2l-2.3.33 1.67 1.63-.4 2.3L8 10.37l2.03 1.07-.4-2.3L11.3 7.53 9 7.2Z',
  ],
  kebab: [
    'M3.4 8a1.15 1.15 0 1 1 2.3 0 1.15 1.15 0 0 1-2.3 0Zm3.45 0a1.15 1.15 0 1 1 2.3 0 1.15 1.15 0 0 1-2.3 0Zm3.45 0a1.15 1.15 0 1 1 2.3 0 1.15 1.15 0 0 1-2.3 0Z',
  ],
  chevronUp: ['M8 5.5 12.2 9.7l-1.06 1.06L8 7.62 4.86 10.76 3.8 9.7Z'],
  chevronDown: ['M8 10.5 3.8 6.3l1.06-1.06L8 8.38l3.14-3.14L12.2 6.3Z'],
  reconnect: [
    'M8 2.5a5.5 5.5 0 0 1 4.9 3H11.2A4 4 0 0 0 4 8h1.9L3.4 11 1 8h1.5A5.5 5.5 0 0 1 8 2.5Zm5 2.5 2.4 3H14a5.5 5.5 0 0 1-10.4 2.5h1.7A4 4 0 0 0 12.5 8h-1.9Z',
  ],
  eye: [
    'M8 3.5c3 0 5.4 2 6.4 4.5-1 2.5-3.4 4.5-6.4 4.5S2.6 10.5 1.6 8C2.6 5.5 5 3.5 8 3.5Zm0 1.6a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8Zm0 1.5a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z',
  ],
};

/** Dựng icon SVG kiểu symbolic của GNOME. */
export function icon(name, size = 16) {
  const paths = ICONS[name] || [String(name)];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** Thay nội dung một nút bằng icon, giữ nguyên nhãn cho screen reader. */
export function setButtonIcon(id, name, size = 16) {
  const button = $(id);
  if (!button) return;
  button.textContent = '';
  button.appendChild(icon(name, size));
}

/* =========================================================================
 * Hộp thoại
 * ========================================================================= */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const modalStack = [];

function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.hidden && el.offsetParent !== null && !el.closest('[hidden]'),
  );
}

/**
 * Mở lớp phủ và giam focus trong đó. Không giam focus thì Tab sẽ chạy ra sau
 * lớp phủ và người dùng bàn phím lạc mất hộp thoại đang mở.
 */
export function openModal(id) {
  const overlay = $(id);
  if (!overlay || !overlay.hidden) return;
  const dialog = overlay.querySelector('.dialog, .palette') || overlay;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  modalStack.push({ id, returnFocus: document.activeElement });
  overlay.hidden = false;
  const first = focusablesIn(overlay)[0];
  if (first) first.focus();
}

export function closeModal(id) {
  const overlay = $(id);
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  const index = modalStack.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [entry] = modalStack.splice(index, 1);
  // Trả focus về đúng nút đã mở hộp thoại, không thả về đầu trang.
  if (entry.returnFocus && document.contains(entry.returnFocus)) {
    try {
      entry.returnFocus.focus();
    } catch {
      // phần tử có thể đã bị gỡ khỏi DOM, bỏ qua
    }
  }
}

/**
 * Lớp phủ có thể bị ẩn bằng cách khác (test, code cũ, hoặc một nhánh quên gọi
 * closeModal). Dọn những mục đã khuất khỏi ngăn xếp trước khi trả lời, để một
 * lần lệch nhịp không khoá luôn phím tắt của cả ứng dụng.
 */
function pruneModalStack() {
  while (modalStack.length) {
    const overlay = $(modalStack[modalStack.length - 1].id);
    if (overlay && !overlay.hidden) break;
    modalStack.pop();
  }
}

export function topModalId() {
  pruneModalStack();
  return modalStack.length ? modalStack[modalStack.length - 1].id : null;
}

export function isModalOpen() {
  pruneModalStack();
  return modalStack.length > 0;
}

/** Tab bị giữ lại bên trong lớp phủ trên cùng. */
function trapFocus(event) {
  if (event.key !== 'Tab') return;
  pruneModalStack();
  if (!modalStack.length) return;
  const overlay = $(topModalId());
  if (!overlay) return;
  const items = focusablesIn(overlay);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
document.addEventListener('keydown', trapFocus, true);

/* =========================================================================
 * Hộp nhập liệu
 * ========================================================================= */

let inputResolver = null;

/**
 * Thay cho `window.prompt`, thứ Electron không hỗ trợ và ném lỗi ngay khi gọi.
 * Trả về chuỗi người dùng nhập, hoặc null nếu huỷ.
 *
 * @param {{title: string, label: string, value?: string, placeholder?: string,
 *          hint?: string, confirmLabel?: string, selectAll?: boolean}} options
 * @returns {Promise<string|null>}
 */
export function askInput(options) {
  const { title, label, value = '', placeholder = '', hint = '', confirmLabel = 'Đồng ý', selectAll = true } = options;
  $('input-modal-title').textContent = title;
  $('input-label').textContent = label;
  $('input-field').value = value;
  $('input-field').placeholder = placeholder;
  $('input-hint').textContent = hint;
  $('input-hint').hidden = !hint;
  $('input-confirm').textContent = confirmLabel;
  clearError('input-error');
  openModal('input-modal');
  const field = $('input-field');
  field.focus();
  if (selectAll) field.select();

  return new Promise((resolve) => {
    inputResolver = resolve;
  });
}

function settleInput(result) {
  const resolve = inputResolver;
  inputResolver = null;
  closeModal('input-modal');
  if (resolve) resolve(result);
}

export function initInputModal() {
  $('input-form').addEventListener('submit', (event) => {
    event.preventDefault();
    settleInput($('input-field').value);
  });
  $('input-cancel').addEventListener('click', () => settleInput(null));
}

/** Huỷ hộp nhập liệu từ nơi khác (ví dụ khi nhấn Escape). */
export function cancelInput() {
  if (inputResolver) settleInput(null);
}

/* =========================================================================
 * Menu chuột phải
 * ========================================================================= */

let openMenu = null;

export function closeContextMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
}

/**
 * Menu ngữ cảnh dựng bằng DOM để bám đúng theme của ứng dụng.
 * @param {{x: number, y: number}} position
 * @param {Array<{label: string, action?: Function, disabled?: boolean, destructive?: boolean, separator?: boolean}>} items
 */
export function showContextMenu(position, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.separator) {
      const line = document.createElement('div');
      line.className = 'context-separator';
      menu.appendChild(line);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'context-item' + (item.destructive ? ' destructive' : '');
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.addEventListener('click', () => {
      closeContextMenu();
      if (item.action) item.action();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const x = Math.min(position.x, window.innerWidth - rect.width - 8);
  const y = Math.min(position.y, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
  openMenu = menu;
  const firstEnabled = menu.querySelector('.context-item:not([disabled])');
  if (firstEnabled) firstEnabled.focus();
}

document.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeContextMenu();
});
window.addEventListener('blur', closeContextMenu);

/* =========================================================================
 * Định dạng
 * ========================================================================= */

export function formatBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(value) || 0;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return (index > 1 ? size.toFixed(1) : Math.round(size)) + ' ' + units[index];
}

export function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return (days ? days + ' ngày ' : '') + hours + ' giờ ' + minutes + ' phút';
}

/** Thời điểm sửa của file remote, tính theo giây epoch. */
export function formatTimestamp(seconds) {
  if (!seconds) return '—';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('vi-VN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/* =========================================================================
 * Tìm kiếm tiếng Việt
 * ========================================================================= */

/**
 * Bỏ dấu tiếng Việt để gõ nhanh không dấu vẫn tìm ra máy có dấu.
 * NFD tách chữ cái khỏi dấu thanh thành hai ký tự rời, xoá dải dấu là xong;
 * riêng đ/Đ không phải chữ có dấu thanh nên phải thay tay.
 */
function boDau(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

export function matchesFilter(conn, needle) {
  if (!needle) return true;
  const hay = boDau(
    [conn.name, conn.host, conn.username, conn.group, conn.environment, ...(conn.tags || []), conn.notes]
      .filter(Boolean)
      .join(' '),
  );
  return hay.includes(boDau(needle));
}

/** Ưu tiên máy hay dùng và mới dùng để "truy cập nhanh" đúng nghĩa. */
export function sortConnections(list) {
  return [...list].sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    if (a.lastUsedAt || b.lastUsedAt) {
      return String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || ''));
    }
    return a.name.localeCompare(b.name);
  });
}

export function connectionById(id) {
  return state.connections.find((conn) => conn.id === id) || null;
}

/* =========================================================================
 * Phiên đang xem
 * ========================================================================= */

/** Truy vấn thuần: không hiện toast, để nơi gọi tự quyết định báo hay không. */
export function activeSession() {
  const session = state.sessions.get(state.activeSessionId);
  return session && session.status === 'connected' ? session : null;
}

/** Dùng cho thao tác do người dùng chủ động bấm: im lặng là khó hiểu. */
export function requireConnectedSession() {
  const session = activeSession();
  if (!session) setStatus('Hãy chọn một phiên SSH đã kết nối.', 'error');
  return session;
}

/* =========================================================================
 * Làm mới dữ liệu
 * ========================================================================= */

const refreshHandlers = new Set();

export function onRefresh(handler) {
  refreshHandlers.add(handler);
}

export async function refreshAll() {
  state.connections = await call(bridge.connections.list());
  state.snippets = await call(bridge.snippets.list());
  state.settings = await call(bridge.vault.settings());
  for (const handler of refreshHandlers) handler();
}
