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
 * Dẫn xuất khoá AES từ master password bằng scrypt.
 * @param {string} password
 * @param {Buffer} salt
 * @returns {Promise<Buffer>} khoá 32 byte
 */
function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LEN, SCRYPT_PARAMS, (err, key) => {
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

module.exports = { makeSalt, deriveKey, encrypt, decrypt, wipe, SCRYPT_PARAMS };
