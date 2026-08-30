'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('ssh2');

const WINDOWS_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/** Đường ống tới ssh-agent của hệ điều hành, nếu có. */
function detectAgent() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  if (process.platform === 'win32' && fs.existsSync(WINDOWS_AGENT_PIPE)) return WINDOWS_AGENT_PIPE;
  return null;
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
      this.map = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      this.map = {};
    }
  }

  get(hostKey) {
    return this.map[hostKey] || null;
  }

  set(hostKey, fp) {
    this.map[hostKey] = fp;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.map, null, 2), { mode: 0o600 });
  }

  forget(hostKey) {
    delete this.map[hostKey];
    fs.writeFileSync(this.filePath, JSON.stringify(this.map, null, 2), { mode: 0o600 });
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
    if (this.sessions.has(sessionId)) throw new Error('Phiên đã tồn tại');

    const { onData, onStatus, onClose } = handlers;
    const client = new Client();
    const entry = { client, stream: null, conn };
    this.sessions.set(sessionId, entry);

    const fail = (message) => {
      onStatus({ state: 'error', message });
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
          stream.on('data', (chunk) => onData(chunk.toString('utf8')));
          stream.stderr.on('data', (chunk) => onData(chunk.toString('utf8')));
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

    client.on('error', (err) => fail(err.message));
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
    const hostKeyId = conn.host + ':' + conn.port;

    const config = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      readyTimeout: 20000,
      keepaliveInterval: 20000,
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
      const keyPath = conn.privateKeyPath.replace(/^~/, os.homedir());
      if (!fs.existsSync(keyPath)) throw new Error('Không tìm thấy private key: ' + keyPath);
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
