'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { Client } = require('ssh2');
const { currentPlatform } = require('./platform');
const {
  validateHost,
  validatePort,
  validateUsername,
  validateId,
  clampTerminalSize,
  safeErrorMessage,
} = require('./validation');

/** Đường ống tới ssh-agent của hệ điều hành, nếu có. */
function detectAgent() {
  return currentPlatform.detectSshAgent();
}

function fingerprint(keyBuffer) {
  return 'SHA256:' + crypto.createHash('sha256').update(keyBuffer).digest('base64').replace(/=+$/, '');
}

/**
 * Sổ ghi nhớ host key theo mô hình TOFU (tin ở lần gặp đầu tiên).
 * Lần đầu kết nối sẽ hỏi người dùng; những lần sau vân tay phải khớp,
 * nếu lệch thì từ chối kết nối vì đó có thể là tấn công xen giữa.
 */
class KnownHosts {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      this.map = Object.fromEntries(
        Object.entries(parsed).filter(
          ([key, value]) =>
            typeof key === 'string' && key.length <= 320 && /^SHA256:[A-Za-z0-9+/]{20,}$/.test(value)
        )
      );
    } catch {
      this.map = {};
    }
  }

  get(hostKey) {
    return this.map[hostKey] || null;
  }

  set(hostKey, fp) {
    if (typeof hostKey !== 'string' || hostKey.length > 320) throw new Error('Host key ID không hợp lệ');
    if (!/^SHA256:[A-Za-z0-9+/]{20,}$/.test(fp)) throw new Error('Fingerprint không hợp lệ');
    this.map[hostKey] = fp;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.map, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  forget(hostKey) {
    delete this.map[hostKey];
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.map, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  list() {
    return Object.entries(this.map)
      .map(([host, fp]) => ({ host, fingerprint: fp }))
      .sort((a, b) => a.host.localeCompare(b.host));
  }
}

/**
 * Quản lý các phiên SSH đang mở. Mỗi phiên là một Client ssh2 kèm một shell
 * có cấp phát pty, dữ liệu được đẩy ngược lên renderer qua callback.
 */
class SshManager {
  /**
   * @param {KnownHosts} knownHosts
   * @param {(info: {host: string, port: number, fingerprint: string, changed: boolean, previous: string|null}) => Promise<boolean>} confirmHostKey
   *   Hỏi người dùng có tin host key này không.
   */
  constructor(knownHosts, confirmHostKey) {
    this.knownHosts = knownHosts;
    this.confirmHostKey = confirmHostKey;
    this.sessions = new Map();
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  /**
   * Mở một phiên shell mới.
   * @param {string} sessionId
   * @param {object} conn bản ghi đầy đủ từ vault (có thể chứa bí mật)
   * @param {{cols: number, rows: number}} size
   * @param {{onData: Function, onStatus: Function, onClose: Function}} handlers
   */
  connect(sessionId, conn, size, handlers) {
    sessionId = validateId(sessionId, 'Session ID');
    size = clampTerminalSize(size);
    if (this.sessions.has(sessionId)) throw new Error('Phiên đã tồn tại');

    const { onData, onStatus, onClose } = handlers;
    const client = new Client();
    const entry = { client, stream: null, conn };
    this.sessions.set(sessionId, entry);

    const fail = (message) => {
      onStatus({ state: 'error', message: safeErrorMessage({ message }) });
      this._cleanup(sessionId);
      onClose();
    };

    client.on('ready', () => {
      onStatus({ state: 'connected', message: 'Đã kết nối ' + conn.username + '@' + conn.host });
      client.shell(
        { term: 'xterm-256color', cols: size.cols || 80, rows: size.rows || 24 },
        (err, stream) => {
          if (err) return fail('Không mở được shell: ' + err.message);
          entry.stream = stream;

          // Ký tự tiếng Việt chiếm 2-3 byte UTF-8 và TCP có thể cắt gói vào giữa
          // một ký tự. StringDecoder giữ lại phần byte dở dang chờ mảnh kế tiếp,
          // thay vì giải mã từng mảnh rời rạc và sinh ra ký tự hỏng.
          const outDecoder = new StringDecoder('utf8');
          const errDecoder = new StringDecoder('utf8');
          stream.on('data', (chunk) => onData(outDecoder.write(chunk)));
          stream.stderr.on('data', (chunk) => onData(errDecoder.write(chunk)));
          stream.on('close', () => {
            onStatus({ state: 'closed', message: 'Phiên đã đóng' });
            this._cleanup(sessionId);
            onClose();
          });
          if (conn.onConnect && conn.onConnect.trim()) {
            stream.write(conn.onConnect.trim() + '\n');
          }
        }
      );
    });

    client.on('error', (err) => fail(safeErrorMessage(err)));
    client.on('end', () => onStatus({ state: 'ended', message: 'Máy chủ đã ngắt kết nối' }));

    // Máy chủ yêu cầu nhập tương tác (thường là mật khẩu hoặc OTP)
    client.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
      if (conn.password && prompts.length === 1 && /password/i.test(prompts[0].prompt)) {
        finish([conn.password]);
      } else {
        finish([]);
      }
    });

    let config;
    try {
      config = this._buildConfig(conn, size);
    } catch (err) {
      // Lỗi cấu hình (thiếu key...) phải báo bất đồng bộ để caller kịp đăng ký handler
      setImmediate(() => fail(err.message));
      return;
    }

    onStatus({ state: 'connecting', message: 'Đang kết nối ' + conn.host + ':' + conn.port + '…' });
    client.connect(config);
  }

  _buildConfig(conn, size) {
    const host = validateHost(conn.host);
    const port = validatePort(conn.port);
    const username = validateUsername(conn.username);
    const hostKeyId = host + ':' + port;

    const config = {
      host,
      port,
      username,
      readyTimeout: Number.isFinite(Number(conn.connectTimeout))
        ? Math.min(120000, Math.max(1000, Number(conn.connectTimeout)))
        : 20000,
      keepaliveInterval: Number.isFinite(Number(conn.keepaliveInterval))
        ? Math.min(120000, Math.max(0, Number(conn.keepaliveInterval)))
        : 20000,
      keepaliveCountMax: 3,
      tryKeyboard: true,
      hostVerifier: (keyBuffer, callback) => {
        const fp = fingerprint(keyBuffer);
        const known = this.knownHosts.get(hostKeyId);
        if (known === fp) return callback(true);
        this.confirmHostKey({
          host: conn.host,
          port: conn.port,
          fingerprint: fp,
          changed: Boolean(known),
          previous: known,
        })
          .then((accepted) => {
            if (accepted) this.knownHosts.set(hostKeyId, fp);
            callback(accepted);
          })
          .catch(() => callback(false));
      },
    };

    if (conn.authType === 'password') {
      if (!conn.password) throw new Error('Kết nối này chưa lưu mật khẩu');
      config.password = conn.password;
      return config;
    }

    if (conn.privateKeyPath) {
      const keyPath = currentPlatform.expandLocalPath(conn.privateKeyPath);
      if (!fs.existsSync(keyPath)) throw new Error('Không tìm thấy private key: ' + keyPath);
      const keyStat = fs.statSync(keyPath);
      if (!keyStat.isFile() || keyStat.size > 1024 * 1024) {
        throw new Error('Private key phải là file nhỏ hơn hoặc bằng 1 MB');
      }
      config.privateKey = fs.readFileSync(keyPath);
      if (conn.passphrase) config.passphrase = conn.passphrase;
      return config;
    }

    const agent = detectAgent();
    if (!agent) {
      throw new Error('Chưa chọn private key và không tìm thấy ssh-agent đang chạy');
    }
    config.agent = agent;
    return config;
  }

  write(sessionId, data) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.stream) entry.stream.write(data);
  }

  resize(sessionId, cols, rows) {
    const entry = this.sessions.get(sessionId);
    if (entry && entry.stream) entry.stream.setWindow(rows, cols, 0, 0);
  }

  disconnect(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    try {
      if (entry.stream) entry.stream.end();
      entry.client.end();
    } catch {
      // client có thể đã đóng, bỏ qua
    }
    this._cleanup(sessionId);
  }

  disconnectAll() {
    for (const id of [...this.sessions.keys()]) this.disconnect(id);
  }

  _cleanup(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // Xoá bản sao bí mật khỏi RAM khi phiên kết thúc
    if (entry.conn) {
      entry.conn.password = undefined;
      entry.conn.passphrase = undefined;
    }
    this.sessions.delete(sessionId);
  }
}

module.exports = { SshManager, KnownHosts, detectAgent };
