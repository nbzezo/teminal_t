'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { makeSalt, deriveKey, encrypt, decrypt, wipe, SCRYPT_PARAMS } = require('./crypto');

const VAULT_VERSION = 1;
const EMPTY = { connections: [], snippets: [] };

/**
 * Kho lưu trữ cấu hình SSH. Toàn bộ nội dung (kể cả tên host) được mã hoá
 * bằng AES-256-GCM với khoá dẫn xuất từ master password. Khoá chỉ tồn tại
 * trong RAM của main process, không bao giờ đi qua IPC sang renderer.
 */
class Vault {
  constructor(filePath) {
    this.filePath = filePath;
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  get unlocked() {
    return this.key !== null;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  status() {
    return { exists: this.exists(), unlocked: this.unlocked };
  }

  async init(masterPassword) {
    if (this.exists()) throw new Error('Kho đã tồn tại');
    if (!masterPassword || masterPassword.length < 8) {
      throw new Error('Master password phải từ 8 ký tự trở lên');
    }
    const salt = makeSalt();
    this.key = await deriveKey(masterPassword, salt);
    this.salt = salt;
    this.data = structuredClone(EMPTY);
    this._persist();
    return this.status();
  }

  async unlock(masterPassword) {
    if (!this.exists()) throw new Error('Chưa có kho, hãy tạo mới');
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (raw.version !== VAULT_VERSION) throw new Error('Phiên bản kho không tương thích');
    const salt = Buffer.from(raw.salt, 'base64');
    const key = await deriveKey(masterPassword, salt);
    let payload;
    try {
      payload = JSON.parse(decrypt(key, raw.blob));
    } catch {
      wipe(key);
      throw new Error('Sai master password');
    }
    this.key = key;
    this.salt = salt;
    this.data = { connections: payload.connections || [], snippets: payload.snippets || [] };
    return this.status();
  }

  lock() {
    wipe(this.key);
    this.key = null;
    this.data = null;
    return this.status();
  }

  _assertUnlocked() {
    if (!this.unlocked) throw new Error('Kho đang khoá');
  }

  _persist() {
    const body = {
      version: VAULT_VERSION,
      kdf: 'scrypt',
      params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
      salt: this.salt.toString('base64'),
      blob: encrypt(this.key, JSON.stringify(this.data)),
    };
    const tmp = this.filePath + '.tmp';
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath); // ghi nguyên tử, tránh hỏng kho khi mất điện
  }

  /** Bản ghi rút gọn gửi sang renderer: không kèm mật khẩu/passphrase. */
  _safe(conn) {
    const { password, passphrase, ...rest } = conn;
    return { ...rest, hasPassword: Boolean(password), hasPassphrase: Boolean(passphrase) };
  }

  listConnections() {
    this._assertUnlocked();
    return this.data.connections.map((c) => this._safe(c));
  }

  /** Bản ghi đầy đủ kể cả bí mật — chỉ dùng trong main process để mở kết nối. */
  getConnectionFull(id) {
    this._assertUnlocked();
    return this.data.connections.find((c) => c.id === id) || null;
  }

  saveConnection(input) {
    this._assertUnlocked();
    const list = this.data.connections;
    const idx = input.id ? list.findIndex((c) => c.id === input.id) : -1;
    const prev = idx >= 0 ? list[idx] : {};

    const conn = {
      id: input.id || crypto.randomUUID(),
      name: (input.name || '').trim() || (input.host || '').trim(),
      host: (input.host || '').trim(),
      port: Number(input.port) || 22,
      username: (input.username || '').trim(),
      authType: input.authType === 'password' ? 'password' : 'key',
      privateKeyPath: (input.privateKeyPath || '').trim(),
      group: (input.group || '').trim(),
      notes: input.notes || '',
      onConnect: input.onConnect || '',
      favorite: Boolean(input.favorite),
      createdAt: prev.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: prev.lastUsedAt || null,
      useCount: prev.useCount || 0,
    };
    if (!conn.host) throw new Error('Thiếu host');
    if (!conn.username) throw new Error('Thiếu username');

    // Chuỗi rỗng = giữ nguyên bí mật cũ; giá trị mới = ghi đè
    conn.password = input.password === '' ? prev.password : input.password || undefined;
    conn.passphrase = input.passphrase === '' ? prev.passphrase : input.passphrase || undefined;
    if (conn.authType === 'password') delete conn.passphrase;
    else delete conn.password;

    if (idx >= 0) list[idx] = conn;
    else list.push(conn);
    this._persist();
    return this._safe(conn);
  }

  deleteConnection(id) {
    this._assertUnlocked();
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this._persist();
  }

  /** Ghi nhận lần dùng để sắp xếp “truy cập nhanh” theo tần suất. */
  touchConnection(id) {
    this._assertUnlocked();
    const conn = this.data.connections.find((c) => c.id === id);
    if (!conn) return;
    conn.lastUsedAt = new Date().toISOString();
    conn.useCount = (conn.useCount || 0) + 1;
    this._persist();
  }

  listSnippets() {
    this._assertUnlocked();
    return this.data.snippets;
  }

  saveSnippet(input) {
    this._assertUnlocked();
    const list = this.data.snippets;
    const idx = input.id ? list.findIndex((s) => s.id === input.id) : -1;
    const snippet = {
      id: input.id || crypto.randomUUID(),
      name: (input.name || '').trim() || 'Không tên',
      command: input.command || '',
      autoRun: input.autoRun !== false,
    };
    if (idx >= 0) list[idx] = snippet;
    else list.push(snippet);
    this._persist();
    return snippet;
  }

  deleteSnippet(id) {
    this._assertUnlocked();
    this.data.snippets = this.data.snippets.filter((s) => s.id !== id);
    this._persist();
  }

  async changeMasterPassword(oldPassword, newPassword) {
    this._assertUnlocked();
    if (!newPassword || newPassword.length < 8) {
      throw new Error('Master password mới phải từ 8 ký tự trở lên');
    }
    const check = await deriveKey(oldPassword, this.salt);
    const ok = check.length === this.key.length && crypto.timingSafeEqual(check, this.key);
    wipe(check);
    if (!ok) throw new Error('Master password cũ không đúng');

    const salt = makeSalt();
    const key = await deriveKey(newPassword, salt);
    wipe(this.key);
    this.key = key;
    this.salt = salt;
    this._persist();
  }

  /**
   * Đọc ~/.ssh/config và thêm các Host chưa có trong kho.
   * Bỏ qua các mục wildcard vì chúng là quy tắc, không phải máy cụ thể.
   */
  importSshConfig() {
    this._assertUnlocked();
    const file = path.join(os.homedir(), '.ssh', 'config');
    if (!fs.existsSync(file)) throw new Error('Không tìm thấy ' + file);

    const entries = [];
    let current = null;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [rawKey, ...rest] = trimmed.split(/\s+/);
      const key = rawKey.toLowerCase();
      const value = rest.join(' ').replace(/^=/, '').trim();
      if (key === 'host') {
        current = { alias: value, fields: {} };
        entries.push(current);
      } else if (current) {
        current.fields[key] = value;
      }
    }

    let added = 0;
    for (const { alias, fields } of entries) {
      if (!alias || alias.includes('*') || alias.includes('?')) continue;
      const host = fields.hostname || alias;
      const username = fields.user || os.userInfo().username;
      const port = Number(fields.port) || 22;
      const duplicate = this.data.connections.some(
        (c) => c.host === host && c.username === username && c.port === port
      );
      if (duplicate) continue;
      const keyPath = fields.identityfile
        ? fields.identityfile.replace(/^~/, os.homedir()).replace(/^"|"$/g, '')
        : '';
      this.saveConnection({
        name: alias,
        host,
        port,
        username,
        authType: 'key',
        privateKeyPath: keyPath,
        group: 'Imported',
      });
      added += 1;
    }
    return { added, scanned: entries.length };
  }
}

module.exports = { Vault };
