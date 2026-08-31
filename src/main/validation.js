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

function validatePort(value) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port phải là số nguyên từ 1 đến 65535');
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
  inspectCommand,
  safeErrorMessage,
};
