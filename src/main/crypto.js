'use strict';

const crypto = require('crypto');

// Tham số scrypt: N=2^15 cân bằng giữa bảo mật và thời gian mở khoá (~150ms)
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;

function makeSalt() {
  return crypto.randomBytes(SALT_LEN);
}

/**
 * Đọc tham số KDF ghi kèm trong file kho/backup.
 *
 * Kho luôn mang theo tham số đã dùng để tạo nó. Nhờ vậy, ngày nào tăng chi phí
 * scrypt cho kho mới, kho cũ vẫn mở được bằng đúng tham số của nó thay vì báo
 * "sai master password" — một lỗi vừa sai vừa không cứu được.
 *
 * @param {unknown} value trường `params` đọc từ file
 * @returns {{N: number, r: number, p: number, maxmem: number}}
 */
function readParams(value) {
  if (!value || typeof value !== 'object') return { ...SCRYPT_PARAMS };
  const N = Number(value.N);
  const r = Number(value.r);
  const p = Number(value.p);
  const powerOfTwo = Number.isInteger(N) && N >= 1024 && N <= 1048576 && (N & (N - 1)) === 0;
  if (!powerOfTwo || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    throw new Error('Tham số mã hoá của kho không hợp lệ');
  }
  // scrypt cần khoảng 128 * N * r byte; cộng biên để Node không từ chối.
  const maxmem = Math.max(SCRYPT_PARAMS.maxmem, 256 * N * r);
  return { N, r, p, maxmem };
}

/**
 * Dẫn xuất khoá AES từ master password bằng scrypt.
 * @param {string} password
 * @param {Buffer} salt
 * @param {{N: number, r: number, p: number, maxmem: number}} [params]
 * @returns {Promise<Buffer>} khoá 32 byte
 */
function deriveKey(password, salt, params = SCRYPT_PARAMS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, params, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Mã hoá chuỗi UTF-8 bằng AES-256-GCM.
 * @returns {string} định dạng "iv.tag.ciphertext" (base64)
 */
function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

/**
 * Giải mã chuỗi tạo bởi encrypt(). Ném lỗi nếu sai khoá hoặc dữ liệu bị sửa.
 */
function decrypt(key, payload) {
  const parts = String(payload).split('.');
  if (parts.length !== 3) throw new Error('Dữ liệu mã hoá không hợp lệ');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Xoá khoá khỏi RAM khi khoá kho. */
function wipe(buf) {
  if (Buffer.isBuffer(buf)) buf.fill(0);
}

module.exports = { makeSalt, deriveKey, encrypt, decrypt, wipe, readParams, SCRYPT_PARAMS };
