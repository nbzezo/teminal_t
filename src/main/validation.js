'use strict';

const net = require('net');

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DNS_NAME = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const USERNAME = /^[\p{L}\p{N}._@-]{1,64}$/u;

function cleanString(value, field, maxLength, { required = false, trim = true } = {}) {
  let result = String(value == null ? '' : value);
  if (trim) result = result.trim();
  if (required && !result) throw new Error('Thiếu ' + field);
  if (result.length > maxLength) throw new Error(field + ' vượt quá ' + maxLength + ' ký tự');
  if (CONTROL_CHARS.test(result)) throw new Error(field + ' chứa ký tự điều khiển không hợp lệ');
  return result;
}

function validateHost(value) {
  const host = cleanString(value, 'host', 253, { required: true });
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!net.isIP(unwrapped) && !DNS_NAME.test(unwrapped)) {
    throw new Error('Host/IP không hợp lệ');
  }
  return unwrapped.toLowerCase();
}

/**
 * @param {unknown} value
 * @param {{allowZero?: boolean}} [options] cổng 0 nghĩa là "để hệ điều hành tự
 *   cấp", hợp lệ với tunnel nhưng không hợp lệ với địa chỉ máy chủ.
 */
function validatePort(value, { allowZero = false } = {}) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < min || port > 65535) {
    throw new Error('Port phải là số nguyên từ ' + min + ' đến 65535');
  }
  return port;
}

function validateUsername(value) {
  const username = cleanString(value, 'username', 64, { required: true });
  if (!USERNAME.test(username)) {
    throw new Error('Username chỉ được chứa chữ, số, dấu chấm, gạch ngang, gạch dưới hoặc @');
  }
  return username;
}

function validateId(value, field = 'ID') {
  const id = cleanString(value, field, 128, { required: true });
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(field + ' không hợp lệ');
  return id;
}

function clampTerminalSize(size = {}) {
  const cols = Number.isInteger(Number(size.cols)) ? Number(size.cols) : 80;
  const rows = Number.isInteger(Number(size.rows)) ? Number(size.rows) : 24;
  return {
    cols: Math.min(500, Math.max(10, cols)),
    rows: Math.min(300, Math.max(2, rows)),
  };
}

function normalizeEnvironment(value) {
  const env = String(value || 'development').toLowerCase();
  return ['development', 'staging', 'production'].includes(env) ? env : 'development';
}

/** '' = theo mặc định chung trong cài đặt; 'on'/'off' = máy này tự quyết. */
function normalizePersistentSession(value) {
  const mode = String(value == null ? '' : value).toLowerCase();
  return mode === 'on' || mode === 'off' ? mode : '';
}

const TMUX_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Tên session đi thẳng vào một lệnh chạy trên máy chủ, nên nó được *kiểm* chứ
 * không phải escape: chỉ chữ không dấu, số, gạch ngang và gạch dưới mới qua được.
 */
function validateTmuxName(value, field = 'Tên phiên') {
  const name = cleanString(value, field, 32, { required: true });
  if (!TMUX_NAME.test(name)) {
    throw new Error(field + ' chỉ được chứa chữ không dấu, số, gạch ngang hoặc gạch dưới');
  }
  return name;
}

/**
 * Rút tên máy chủ thành mẩu an toàn. Tiếng Việt bị bỏ dấu thay vì bị loại sạch,
 * để "Máy chủ Hà Nội" ra `may-chu-ha-noi` chứ không ra một chuỗi rỗng.
 */
function slugifyForTmux(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    // đ/Đ không tách được bằng NFD vì gạch ngang là một phần của chữ cái.
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 16)
    .replace(/^-+|-+$/g, '');
}

function boundedIndex(value, max) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) return 1;
  return Math.min(max, index);
}

/**
 * Tên tmux session của một pane, đặt theo đúng thứ người dùng đang nhìn: tab thứ
 * mấy, pane thứ mấy. Khi họ ssh tay vào máy rồi gõ `tmux ls` là đối chiếu được
 * ngay, thay vì thấy một dãy UUID vô nghĩa.
 *
 * Tab 1 pane 1 không có hậu tố, nên trường hợp phổ biến nhất được tên ngắn nhất.
 */
function buildTmuxSessionName(connectionName, { tabIndex = 1, paneIndex = 1, base = '' } = {}) {
  const tab = boundedIndex(tabIndex, 99);
  const pane = boundedIndex(paneIndex, 9);
  // Tên người dùng tự đặt cũng chỉ là *gốc*: hậu tố tab/pane vẫn được thêm vào,
  // nếu không thì hai pane cùng gắn một phiên và soi gương nhau.
  let name = base ? validateTmuxName(base).slice(0, 26) : 'sshman_' + (slugifyForTmux(connectionName) || 'server');
  if (tab > 1 || pane > 1) name += '-' + tab;
  if (pane > 1) name += '-' + pane;
  return validateTmuxName(name);
}

const DANGEROUS_PATTERNS = [
  /(?:^|[;&|]\s*)rm\s+(?:-[^\s]*[rf][^\s]*\s+)+(?:\/|~|\*)/i,
  /\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted)\b/i,
  /\bdd\s+[^\n]*\bof=\/dev\//i,
  /\b(?:shutdown|reboot|poweroff|halt)\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i,
  /\bchmod\s+(?:-[^\s]+\s+)*777\s+\//i,
  />\s*\/dev\/(?:sd[a-z]|nvme\d+n\d+)/i,
];

function inspectCommand(value) {
  const command = cleanString(value, 'Câu lệnh', 8192, { required: true, trim: false });
  return {
    command,
    dangerous: DANGEROUS_PATTERNS.some((pattern) => pattern.test(command)),
  };
}

function safeErrorMessage(error) {
  const raw = error && error.message ? String(error.message) : 'Thao tác thất bại';
  return raw
    .replace(/((?:password|passphrase|private[_ -]?key|token|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[đã che]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

module.exports = {
  cleanString,
  validateHost,
  validatePort,
  validateUsername,
  validateId,
  clampTerminalSize,
  normalizeEnvironment,
  normalizePersistentSession,
  validateTmuxName,
  slugifyForTmux,
  buildTmuxSessionName,
  inspectCommand,
  safeErrorMessage,
};
