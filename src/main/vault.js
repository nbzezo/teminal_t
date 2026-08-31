'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeSalt, deriveKey, encrypt, decrypt, wipe, readParams, SCRYPT_PARAMS } = require('./crypto');
const { currentPlatform } = require('./platform');
const {
  cleanString,
  validateHost,
  validatePort,
  validateUsername,
  normalizeEnvironment,
  inspectCommand,
  validateId,
} = require('./validation');
const { normalizeRemoteRoot } = require('./remote-path');

const VAULT_VERSION = 1;
const PAYLOAD_SCHEMA_VERSION = 5;
const BACKUP_VERSION = 1;
// Kho là JSON của vài trăm bản ghi; file lớn hơn mức này là hỏng hoặc bị thay,
// và đọc nó vào RAM trước khi biết điều đó là việc không cần thiết.
const MAX_VAULT_BYTES = 20 * 1024 * 1024;
// Kho này giữ credential SSH của cả hạ tầng và không có đường khôi phục, nên
// 8 ký tự là quá mỏng cho thứ duy nhất đứng giữa nó và người cầm được file.
const MIN_MASTER_PASSWORD = 12;

const THEMES = ['system', 'light', 'dark'];
const TERMINAL_FONTS = ['ubuntu-mono', 'cascadia', 'consolas'];

function defaultSettings() {
  return {
    autoLockMinutes: 15,
    clipboardClearSeconds: 30,
    terminalFontFamily: 'ubuntu-mono',
    terminalFontSize: 14,
    terminalBackground: '#300a24',
    theme: 'system',
    copyOnSelect: false,
    confirmOnExit: true,
    restoreSessions: true,
    diagnosticLog: false,
  };
}

function emptyVault() {
  return {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    connections: [],
    snippets: [],
    settings: defaultSettings(),
    workspace: { sessions: [] },
  };
}

function normalizeSecret(value, field) {
  if (value == null || value === '') return undefined;
  const secret = String(value);
  if (secret.length > 4096) throw new Error(field + ' vượt quá giới hạn cho phép');
  return secret;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeTunnel(input) {
  const type = ['local', 'remote', 'dynamic'].includes(input.type) ? input.type : 'local';
  const tunnel = {
    id: input.id ? validateId(input.id, 'Tunnel ID') : crypto.randomUUID(),
    name:
      cleanString(input.name, 'Tên tunnel', 120) ||
      (type === 'dynamic' ? 'SOCKS proxy' : type === 'remote' ? 'Remote tunnel' : 'Local tunnel'),
    type,
    bindHost: '127.0.0.1',
  };
  // Cổng 0 = để hệ điều hành tự cấp, đúng như `ssh -L 0:…`.
  if (type === 'dynamic') {
    tunnel.localPort = validatePort(input.localPort, { allowZero: true });
    return tunnel;
  }
  if (type === 'remote') tunnel.remotePort = validatePort(input.remotePort, { allowZero: true });
  else tunnel.localPort = validatePort(input.localPort, { allowZero: true });
  tunnel.destinationHost = validateHost(input.destinationHost);
  tunnel.destinationPort = validatePort(input.destinationPort);
  return tunnel;
}

/** Giữ nguyên giá trị boolean đã lưu, và chỉ khi đó mới rơi về mặc định. */
function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function migrateSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const fallback = defaultSettings();
  return {
    autoLockMinutes: Number.isInteger(source.autoLockMinutes)
      ? Math.min(240, Math.max(1, source.autoLockMinutes))
      : fallback.autoLockMinutes,
    clipboardClearSeconds: Number.isInteger(source.clipboardClearSeconds)
      ? Math.min(300, Math.max(0, source.clipboardClearSeconds))
      : fallback.clipboardClearSeconds,
    terminalFontFamily: TERMINAL_FONTS.includes(source.terminalFontFamily)
      ? source.terminalFontFamily
      : fallback.terminalFontFamily,
    terminalFontSize: Math.round(boundedNumber(source.terminalFontSize, fallback.terminalFontSize, 10, 28)),
    terminalBackground: /^#[0-9a-f]{6}$/i.test(String(source.terminalBackground || ''))
      ? String(source.terminalBackground).toLowerCase()
      : fallback.terminalBackground,
    theme: THEMES.includes(source.theme) ? source.theme : fallback.theme,
    copyOnSelect: boolOr(source.copyOnSelect, fallback.copyOnSelect),
    confirmOnExit: boolOr(source.confirmOnExit, fallback.confirmOnExit),
    restoreSessions: boolOr(source.restoreSessions, fallback.restoreSessions),
    diagnosticLog: boolOr(source.diagnosticLog, fallback.diagnosticLog),
  };
}

function migratePayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const migrated = {
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    connections: Array.isArray(source.connections) ? source.connections : [],
    snippets: Array.isArray(source.snippets) ? source.snippets : [],
    settings: migrateSettings(source.settings),
    workspace: {
      sessions: Array.isArray(source.workspace && source.workspace.sessions)
        ? source.workspace.sessions.filter((id) => typeof id === 'string').slice(0, 20)
        : [],
    },
  };

  migrated.connections = migrated.connections.map((conn) => ({
    ...conn,
    environment: normalizeEnvironment(conn.environment),
    tags: Array.isArray(conn.tags) ? conn.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [],
    color: typeof conn.color === 'string' ? conn.color : '',
    defaultDirectory: typeof conn.defaultDirectory === 'string' ? conn.defaultDirectory : '',
    connectTimeout: boundedNumber(conn.connectTimeout, 20000, 1000, 120000),
    keepaliveInterval: boundedNumber(conn.keepaliveInterval, 20000, 0, 120000),
    autoReconnect: Boolean(conn.autoReconnect),
    jumpHostId: typeof conn.jumpHostId === 'string' ? conn.jumpHostId : '',
    sftpRoot: typeof conn.sftpRoot === 'string' ? conn.sftpRoot : '/',
    tunnels: Array.isArray(conn.tunnels)
      ? conn.tunnels
          .slice(0, 20)
          .map((tunnel) => {
            try {
              return normalizeTunnel(tunnel);
            } catch {
              return null;
            }
          })
          .filter(Boolean)
      : [],
  }));
  return migrated;
}

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
    this.params = null;
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
    if (!masterPassword || masterPassword.length < MIN_MASTER_PASSWORD) {
      throw new Error('Master password phải từ ' + MIN_MASTER_PASSWORD + ' ký tự trở lên');
    }
    const salt = makeSalt();
    this.params = { ...SCRYPT_PARAMS };
    this.key = await deriveKey(masterPassword, salt, this.params);
    this.salt = salt;
    this.data = emptyVault();
    this._persist();
    return this.status();
  }

  async unlock(masterPassword) {
    if (!this.exists()) throw new Error('Chưa có kho, hãy tạo mới');
    const size = fs.statSync(this.filePath).size;
    if (size > MAX_VAULT_BYTES) throw new Error('File kho vượt quá giới hạn 20 MB');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      throw new Error('File kho không đọc được hoặc đã hỏng');
    }
    if (raw.version !== VAULT_VERSION) throw new Error('Phiên bản kho không tương thích');
    // Tham số KDF đi cùng kho, không lấy từ hằng số trong code: kho cũ vẫn mở
    // được sau khi tham số mặc định thay đổi.
    const params = readParams(raw.params);
    const salt = Buffer.from(raw.salt, 'base64');
    const key = await deriveKey(masterPassword, salt, params);
    let payload;
    try {
      payload = JSON.parse(decrypt(key, raw.blob));
    } catch {
      wipe(key);
      throw new Error('Sai master password');
    }
    this.key = key;
    this.salt = salt;
    this.params = params;
    this.data = migratePayload(payload);
    if (payload.schemaVersion !== PAYLOAD_SCHEMA_VERSION) this._persist();
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
    const params = this.params || SCRYPT_PARAMS;
    const body = {
      version: VAULT_VERSION,
      kdf: 'scrypt',
      params: { N: params.N, r: params.r, p: params.p },
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
    return {
      ...rest,
      hasPassword: Boolean(password),
      hasPassphrase: Boolean(passphrase),
    };
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
      name: cleanString(input.name, 'Tên hiển thị', 120) || validateHost(input.host),
      host: validateHost(input.host),
      port: validatePort(input.port == null || input.port === '' ? 22 : input.port),
      username: validateUsername(input.username),
      authType: input.authType === 'password' ? 'password' : 'key',
      privateKeyPath: cleanString(input.privateKeyPath, 'Đường dẫn private key', 2048),
      group: cleanString(input.group, 'Nhóm', 80),
      tags: Array.isArray(input.tags)
        ? input.tags
            .map((tag) => cleanString(tag, 'Tag', 40))
            .filter(Boolean)
            .slice(0, 20)
        : cleanString(input.tags, 'Tag', 500)
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean)
            .slice(0, 20),
      color: /^#[0-9a-f]{6}$/i.test(String(input.color || '')) ? input.color : '',
      environment: normalizeEnvironment(input.environment),
      defaultDirectory: cleanString(input.defaultDirectory, 'Thư mục mặc định', 1024),
      sftpRoot: normalizeRemoteRoot(cleanString(input.sftpRoot, 'SFTP root', 1024) || '/'),
      tunnels:
        input.tunnels === undefined
          ? structuredClone(prev.tunnels || [])
          : Array.isArray(input.tunnels)
            ? input.tunnels.slice(0, 20).map(normalizeTunnel)
            : [],
      notes: cleanString(input.notes, 'Ghi chú', 4000, { trim: false }),
      onConnect: input.onConnect ? inspectCommand(input.onConnect).command : '',
      connectTimeout: boundedNumber(input.connectTimeout, 20000, 1000, 120000),
      keepaliveInterval: boundedNumber(input.keepaliveInterval, 20000, 0, 120000),
      autoReconnect: Boolean(input.autoReconnect),
      jumpHostId: input.jumpHostId ? validateId(input.jumpHostId, 'Jump host ID') : '',
      favorite: Boolean(input.favorite),
      createdAt: prev.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: prev.lastUsedAt || null,
      useCount: prev.useCount || 0,
    };
    // Chuỗi rỗng = giữ nguyên bí mật cũ; giá trị mới = ghi đè
    conn.password = input.password === '' ? prev.password : normalizeSecret(input.password, 'Mật khẩu');
    conn.passphrase = input.passphrase === '' ? prev.passphrase : normalizeSecret(input.passphrase, 'Passphrase');
    if (conn.authType === 'password') delete conn.passphrase;
    else delete conn.password;

    if (idx >= 0) list[idx] = conn;
    else list.push(conn);
    this._persist();
    return this._safe(conn);
  }

  /** Những kết nối sẽ mất jump host nếu xoá `id` — để hỏi trước, không báo sau. */
  connectionsUsingJumpHost(id) {
    this._assertUnlocked();
    return this.data.connections.filter((conn) => conn.jumpHostId === id).map((conn) => this._safe(conn));
  }

  deleteConnection(id) {
    this._assertUnlocked();
    const before = this.data.connections.length;
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    // Không để lại tham chiếu treo: kết nối trỏ tới jump host vừa xoá sẽ chỉ
    // báo lỗi lúc đang cần kết nối, tức đúng lúc không muốn gặp lỗi nhất.
    let detached = 0;
    for (const conn of this.data.connections) {
      if (conn.jumpHostId === id) {
        conn.jumpHostId = '';
        conn.updatedAt = new Date().toISOString();
        detached += 1;
      }
    }
    this.data.workspace.sessions = this.data.workspace.sessions.filter((item) => item !== id);
    this._persist();
    return { removed: before !== this.data.connections.length, detached };
  }

  duplicateConnection(id) {
    this._assertUnlocked();
    const source = this.data.connections.find((conn) => conn.id === id);
    if (!source) throw new Error('Không tìm thấy kết nối');
    const copy = {
      ...structuredClone(source),
      id: crypto.randomUUID(),
      name: cleanString(source.name + ' (bản sao)', 'Tên hiển thị', 120),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: null,
      useCount: 0,
    };
    // Tunnel phải có ID riêng, nếu không hai kết nối sẽ tranh nhau cùng một
    // registry và bản sao không bật được tunnel khi bản gốc đang bật.
    copy.tunnels = (copy.tunnels || []).map((tunnel) => ({ ...tunnel, id: crypto.randomUUID() }));
    this.data.connections.push(copy);
    this._persist();
    return this._safe(copy);
  }

  saveTunnel(connectionId, input) {
    this._assertUnlocked();
    const conn = this.data.connections.find((item) => item.id === connectionId);
    if (!conn) throw new Error('Không tìm thấy kết nối');
    const tunnel = normalizeTunnel(input);
    conn.tunnels = Array.isArray(conn.tunnels) ? conn.tunnels : [];
    const index = conn.tunnels.findIndex((item) => item.id === tunnel.id);
    if (index >= 0) conn.tunnels[index] = tunnel;
    else conn.tunnels.push(tunnel);
    if (conn.tunnels.length > 20) throw new Error('Mỗi máy chủ chỉ được lưu tối đa 20 tunnel');
    conn.updatedAt = new Date().toISOString();
    this._persist();
    return tunnel;
  }

  deleteTunnel(connectionId, tunnelId) {
    this._assertUnlocked();
    const conn = this.data.connections.find((item) => item.id === connectionId);
    if (!conn) throw new Error('Không tìm thấy kết nối');
    conn.tunnels = (conn.tunnels || []).filter((item) => item.id !== tunnelId);
    conn.updatedAt = new Date().toISOString();
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
    const inspected = inspectCommand(input.command);
    const snippet = {
      id: input.id || crypto.randomUUID(),
      name: cleanString(input.name, 'Tên snippet', 120) || 'Không tên',
      command: inspected.command,
      group: cleanString(input.group, 'Nhóm snippet', 80),
      autoRun: input.autoRun === true,
      dangerous: inspected.dangerous,
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
    if (!newPassword || newPassword.length < MIN_MASTER_PASSWORD) {
      throw new Error('Master password mới phải từ ' + MIN_MASTER_PASSWORD + ' ký tự trở lên');
    }
    const check = await deriveKey(oldPassword, this.salt, this.params || SCRYPT_PARAMS);
    const ok = check.length === this.key.length && crypto.timingSafeEqual(check, this.key);
    wipe(check);
    if (!ok) throw new Error('Master password cũ không đúng');

    // Đổi mật khẩu là dịp nâng kho lên tham số KDF hiện hành.
    const salt = makeSalt();
    const params = { ...SCRYPT_PARAMS };
    const key = await deriveKey(newPassword, salt, params);
    wipe(this.key);
    this.key = key;
    this.salt = salt;
    this.params = params;
    this._persist();
  }

  getSettings() {
    this._assertUnlocked();
    return { ...this.data.settings };
  }

  saveSettings(input) {
    this._assertUnlocked();
    const autoLockMinutes = Number(input && input.autoLockMinutes);
    if (!Number.isInteger(autoLockMinutes) || autoLockMinutes < 1 || autoLockMinutes > 240) {
      throw new Error('Thời gian tự khoá phải từ 1 đến 240 phút');
    }
    this.data.settings.autoLockMinutes = autoLockMinutes;
    const clipboardClearSeconds = Number(input.clipboardClearSeconds ?? this.data.settings.clipboardClearSeconds);
    if (!Number.isInteger(clipboardClearSeconds) || clipboardClearSeconds < 0 || clipboardClearSeconds > 300) {
      throw new Error('Thời gian xoá clipboard phải từ 0 đến 300 giây');
    }
    this.data.settings.clipboardClearSeconds = clipboardClearSeconds;
    const terminalFontFamily = String(input.terminalFontFamily || this.data.settings.terminalFontFamily);
    if (!['ubuntu-mono', 'cascadia', 'consolas'].includes(terminalFontFamily)) {
      throw new Error('Font terminal không hợp lệ');
    }
    this.data.settings.terminalFontFamily = terminalFontFamily;
    const terminalFontSize = Number(input.terminalFontSize ?? this.data.settings.terminalFontSize);
    if (!Number.isInteger(terminalFontSize) || terminalFontSize < 10 || terminalFontSize > 28) {
      throw new Error('Cỡ chữ terminal phải từ 10 đến 28');
    }
    this.data.settings.terminalFontSize = terminalFontSize;
    const terminalBackground = String(input.terminalBackground || this.data.settings.terminalBackground);
    if (!/^#[0-9a-f]{6}$/i.test(terminalBackground)) throw new Error('Màu nền terminal không hợp lệ');
    this.data.settings.terminalBackground = terminalBackground.toLowerCase();
    const theme = String(input.theme ?? this.data.settings.theme);
    if (!THEMES.includes(theme)) throw new Error('Chế độ màu không hợp lệ');
    this.data.settings.theme = theme;
    for (const flag of ['copyOnSelect', 'confirmOnExit', 'restoreSessions', 'diagnosticLog']) {
      if (input[flag] !== undefined) {
        if (typeof input[flag] !== 'boolean') throw new Error('Giá trị của ' + flag + ' phải là true/false');
        this.data.settings[flag] = input[flag];
      }
    }
    this._persist();
    return this.getSettings();
  }

  /** Danh sách kết nối đang mở tab, để mở lại đúng chỗ đã dừng ở lần sau. */
  getWorkspace() {
    this._assertUnlocked();
    return { sessions: [...this.data.workspace.sessions] };
  }

  saveWorkspace(input) {
    this._assertUnlocked();
    const known = new Set(this.data.connections.map((conn) => conn.id));
    const sessions = Array.isArray(input && input.sessions) ? input.sessions : [];
    this.data.workspace.sessions = sessions.filter((id) => known.has(id)).slice(0, 20);
    this._persist();
    return this.getWorkspace();
  }

  async createEncryptedBackup(password, { includeCredentials = false } = {}) {
    this._assertUnlocked();
    if (!password || password.length < 12) {
      throw new Error('Mật khẩu backup phải từ 12 ký tự trở lên');
    }
    const salt = makeSalt();
    const key = await deriveKey(password, salt, SCRYPT_PARAMS);
    const data = structuredClone(this.data);
    if (!includeCredentials) {
      for (const conn of data.connections) {
        delete conn.password;
        delete conn.passphrase;
      }
    }
    const payload = {
      format: 'sshman-backup',
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      includesCredentials: Boolean(includeCredentials),
      data,
    };
    try {
      return JSON.stringify({
        format: 'sshman-backup-encrypted',
        version: BACKUP_VERSION,
        kdf: 'scrypt',
        params: { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p },
        salt: salt.toString('base64'),
        blob: encrypt(key, JSON.stringify(payload)),
      });
    } finally {
      wipe(key);
    }
  }

  async importEncryptedBackup(serialized, password) {
    this._assertUnlocked();
    if (!password || String(password).length < 12) {
      throw new Error('Mật khẩu backup phải từ 12 ký tự trở lên');
    }
    if (typeof serialized !== 'string' || serialized.length > 20 * 1024 * 1024) {
      throw new Error('File backup không hợp lệ hoặc quá lớn');
    }
    let envelope;
    try {
      envelope = JSON.parse(serialized);
    } catch {
      throw new Error('File backup không phải JSON hợp lệ');
    }
    if (envelope.format !== 'sshman-backup-encrypted' || envelope.version !== BACKUP_VERSION) {
      throw new Error('Phiên bản backup không được hỗ trợ');
    }
    const salt = Buffer.from(String(envelope.salt || ''), 'base64');
    const key = await deriveKey(password, salt, readParams(envelope.params));
    let payload;
    try {
      payload = JSON.parse(decrypt(key, envelope.blob));
    } catch {
      throw new Error('Sai mật khẩu backup hoặc file đã bị sửa');
    } finally {
      wipe(key);
    }
    if (payload.format !== 'sshman-backup' || payload.version !== BACKUP_VERSION) {
      throw new Error('Nội dung backup không hợp lệ');
    }

    const incoming = migratePayload(payload.data);
    const validatedConnections = incoming.connections.map((conn) => ({
      ...conn,
      sourceId: conn.id ? validateId(conn.id, 'Connection ID') : crypto.randomUUID(),
      name: cleanString(conn.name, 'Tên hiển thị', 120) || validateHost(conn.host),
      host: validateHost(conn.host),
      port: validatePort(conn.port),
      username: validateUsername(conn.username),
      authType: conn.authType === 'password' ? 'password' : 'key',
      privateKeyPath: cleanString(conn.privateKeyPath, 'Đường dẫn private key', 2048),
      group: cleanString(conn.group, 'Nhóm', 80),
      tags: (conn.tags || [])
        .map((tag) => cleanString(tag, 'Tag', 40))
        .filter(Boolean)
        .slice(0, 20),
      color: /^#[0-9a-f]{6}$/i.test(String(conn.color || '')) ? conn.color : '',
      defaultDirectory: cleanString(conn.defaultDirectory, 'Thư mục mặc định', 1024),
      notes: cleanString(conn.notes, 'Ghi chú', 4000, { trim: false }),
      onConnect: conn.onConnect ? inspectCommand(conn.onConnect).command : '',
      environment: normalizeEnvironment(conn.environment),
      password: conn.authType === 'password' ? normalizeSecret(conn.password, 'Mật khẩu') : undefined,
      passphrase: conn.authType !== 'password' ? normalizeSecret(conn.passphrase, 'Passphrase') : undefined,
    }));
    const endpointIds = new Map(
      this.data.connections.map((conn) => [`${conn.username}\u0000${conn.host}\u0000${conn.port}`, conn.id]),
    );
    const importedIds = new Map();
    const plannedEndpointIds = new Map(endpointIds);
    for (const conn of validatedConnections) {
      const endpoint = `${conn.username}\u0000${conn.host}\u0000${conn.port}`;
      const id = plannedEndpointIds.get(endpoint) || crypto.randomUUID();
      plannedEndpointIds.set(endpoint, id);
      importedIds.set(conn.sourceId, id);
    }
    let connectionsAdded = 0;
    for (const conn of validatedConnections) {
      const endpoint = `${conn.username}\u0000${conn.host}\u0000${conn.port}`;
      if (endpointIds.has(endpoint)) continue;
      const id = importedIds.get(conn.sourceId);
      const jumpHostId = conn.jumpHostId ? importedIds.get(conn.jumpHostId) || '' : '';
      const { sourceId, ...clean } = conn;
      this.data.connections.push({ ...clean, id, jumpHostId });
      endpointIds.set(endpoint, id);
      connectionsAdded += 1;
    }

    const snippetKeys = new Set(this.data.snippets.map((snippet) => `${snippet.name}\u0000${snippet.command}`));
    let snippetsAdded = 0;
    for (const item of incoming.snippets) {
      const inspected = inspectCommand(item.command);
      const snippet = {
        id: crypto.randomUUID(),
        name: cleanString(item.name, 'Tên snippet', 120) || 'Không tên',
        command: inspected.command,
        group: cleanString(item.group, 'Nhóm snippet', 80),
        autoRun: item.autoRun === true,
        dangerous: inspected.dangerous,
      };
      const keyName = `${snippet.name}\u0000${snippet.command}`;
      if (snippetKeys.has(keyName)) continue;
      snippetKeys.add(keyName);
      this.data.snippets.push(snippet);
      snippetsAdded += 1;
    }
    this._persist();
    return {
      connectionsAdded,
      snippetsAdded,
      includesCredentials: Boolean(payload.includesCredentials),
    };
  }

  /**
   * Đọc ~/.ssh/config và thêm các Host chưa có trong kho.
   * Bỏ qua các mục wildcard vì chúng là quy tắc, không phải máy cụ thể.
   */
  importSshConfig() {
    this._assertUnlocked();
    const file = currentPlatform.sshConfigPath();
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
    let skipped = 0;
    const errors = [];
    const importedByAlias = new Map();
    const proxyJumps = [];

    for (const { alias, fields } of entries) {
      if (!alias || alias.includes('*') || alias.includes('?')) continue;
      // Một mục sai định dạng không được phép làm hỏng cả lần nhập: ghi lại
      // rồi đi tiếp, và trả danh sách về cho người dùng xem mục nào trượt.
      try {
        const host = fields.hostname || alias;
        const username = fields.user || process.env.USERNAME || process.env.USER || '';
        const port = Number(fields.port) || 22;
        const duplicate = this.data.connections.find(
          (c) => c.host === host && c.username === username && c.port === port,
        );
        if (duplicate) {
          importedByAlias.set(alias, duplicate.id);
          skipped += 1;
          continue;
        }
        const keyPath = fields.identityfile ? currentPlatform.expandLocalPath(fields.identityfile) : '';
        const saved = this.saveConnection({
          name: alias,
          host,
          port,
          username,
          authType: 'key',
          privateKeyPath: keyPath,
          group: 'Imported',
        });
        importedByAlias.set(alias, saved.id);
        // ProxyJump chỉ giải được sau khi mọi alias đã có ID.
        const jump = (fields.proxyjump || '').split(',')[0].trim();
        if (jump) proxyJumps.push({ id: saved.id, alias: jump.replace(/^[^@]*@/, '').replace(/:\d+$/, '') });
        added += 1;
      } catch (err) {
        skipped += 1;
        errors.push({ alias, message: err && err.message ? String(err.message) : 'Không hợp lệ' });
      }
    }

    let jumpsLinked = 0;
    for (const { id, alias } of proxyJumps) {
      const target =
        importedByAlias.get(alias) ||
        (this.data.connections.find((conn) => conn.name === alias || conn.host === alias) || {}).id;
      const conn = this.data.connections.find((item) => item.id === id);
      if (!target || !conn || target === id) continue;
      conn.jumpHostId = target;
      jumpsLinked += 1;
    }
    if (added > 0 || jumpsLinked > 0) this._persist();
    return { added, skipped, jumpsLinked, scanned: entries.length, errors };
  }
}

module.exports = { Vault, migratePayload, PAYLOAD_SCHEMA_VERSION };
