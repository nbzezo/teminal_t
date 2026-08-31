'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { Client } = require('ssh2');
const { collectServerMetrics } = require('./server-metrics');
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
          ([key, value]) => typeof key === 'string' && key.length <= 320 && /^SHA256:[A-Za-z0-9+/]{20,}$/.test(value),
        ),
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
    this.tunnels = new Map();
    this.cleanupHandlers = new Set();
  }

  has(sessionId) {
    return this.sessions.has(sessionId);
  }

  onCleanup(handler) {
    this.cleanupHandlers.add(handler);
    return () => this.cleanupHandlers.delete(handler);
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
    const entry = { client, stream: null, conn, remoteTunnels: new Map() };
    this.sessions.set(sessionId, entry);
    let finished = false;

    const fail = (message) => {
      if (finished) return;
      finished = true;
      onStatus({ state: 'error', message: safeErrorMessage({ message }) });
      this._cleanup(sessionId);
      onClose();
    };

    client.on('ready', () => {
      onStatus({
        state: 'connected',
        message: 'Đã kết nối ' + conn.username + '@' + conn.host,
      });
      client.shell(
        {
          term: 'xterm-256color',
          cols: size.cols || 80,
          rows: size.rows || 24,
        },
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
            if (finished) return;
            finished = true;
            onStatus({ state: 'closed', message: 'Phiên đã đóng' });
            this._cleanup(sessionId);
            onClose();
          });
          if (conn.defaultDirectory && conn.defaultDirectory.trim()) {
            const directory = conn.defaultDirectory.trim().replace(/'/g, `'"'"'`);
            stream.write("cd -- '" + directory + "'\n");
          }
          if (conn.onConnect && conn.onConnect.trim()) stream.write(conn.onConnect.trim() + '\n');
        },
      );
    });

    client.on('error', (err) => fail(safeErrorMessage(err)));
    client.on('end', () => onStatus({ state: 'ended', message: 'Máy chủ đã ngắt kết nối' }));
    client.on('tcp connection', (info, accept, reject) => {
      const tunnel =
        [...entry.remoteTunnels.values()].find(
          (item) => item.remotePort === info.destPort && item.bindHost === info.destIP,
        ) || [...entry.remoteTunnels.values()].find((item) => item.remotePort === info.destPort);
      if (!tunnel) return reject();
      const channel = accept();
      const socket = net.connect(tunnel.destinationPort, tunnel.destinationHost);
      tunnel.channels.add(channel);
      tunnel.sockets.add(socket);
      channel.on('close', () => tunnel.channels.delete(channel));
      socket.on('close', () => tunnel.sockets.delete(socket));
      channel.on('error', () => socket.destroy());
      socket.on('error', () => channel.destroy());
      socket.pipe(channel).pipe(socket);
    });

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

    if (!conn.jumpHost) {
      onStatus({
        state: 'connecting',
        message: 'Đang kết nối ' + conn.host + ':' + conn.port + '…',
      });
      client.connect(config);
      return;
    }

    const jumpClient = new Client();
    entry.jumpClient = jumpClient;
    let jumpConfig;
    try {
      jumpConfig = this._buildConfig(conn.jumpHost, size);
    } catch (err) {
      setImmediate(() => fail('Jump host: ' + err.message));
      return;
    }
    jumpClient.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      if (conn.jumpHost.password && prompts.length === 1 && /password/i.test(prompts[0].prompt)) {
        finish([conn.jumpHost.password]);
      } else finish([]);
    });
    jumpClient.once('error', (err) => fail('Jump host: ' + safeErrorMessage(err)));
    jumpClient.once('ready', () => {
      jumpClient.forwardOut('127.0.0.1', 0, config.host, config.port, (err, channel) => {
        if (err) return fail('Jump host không tới được máy đích: ' + err.message);
        config.sock = channel;
        onStatus({
          state: 'connecting',
          message: 'Đang kết nối máy đích qua ' + conn.jumpHost.name + '…',
        });
        client.connect(config);
      });
    });
    onStatus({
      state: 'connecting',
      message: 'Đang kết nối jump host ' + conn.jumpHost.host + ':' + conn.jumpHost.port + '…',
    });
    jumpClient.connect(jumpConfig);
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

  probeMetrics(sessionId) {
    sessionId = validateId(sessionId, 'Session ID');
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.stream) throw new Error('Phiên SSH chưa kết nối');
    return collectServerMetrics(entry.client);
  }

  startLocalTunnel(sessionId, input) {
    sessionId = validateId(sessionId, 'Session ID');
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.stream) throw new Error('Phiên SSH chưa kết nối');
    const id = input.id ? validateId(input.id, 'Tunnel ID') : crypto.randomUUID();
    if (this.tunnels.has(id)) throw new Error('Tunnel đã tồn tại');
    const bindHost = input.bindHost || '127.0.0.1';
    if (!['127.0.0.1', '::1'].includes(bindHost)) {
      throw new Error('Local tunnel chỉ được bind vào loopback');
    }
    const localPort = Number(input.localPort);
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      throw new Error('Local port phải từ 0 đến 65535');
    }
    const destinationHost = validateHost(input.destinationHost);
    const destinationPort = validatePort(input.destinationPort);
    const sockets = new Set();
    const channels = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      entry.client.forwardOut(
        socket.remoteAddress || '127.0.0.1',
        socket.remotePort || 0,
        destinationHost,
        destinationPort,
        (err, channel) => {
          if (err) return socket.destroy();
          channels.add(channel);
          channel.on('close', () => channels.delete(channel));
          channel.on('error', () => socket.destroy());
          socket.on('error', () => channel.destroy());
          socket.pipe(channel).pipe(socket);
        },
      );
    });

    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.close();
        reject(new Error('Không mở được local port: ' + err.message));
      };
      server.once('error', onError);
      server.listen({ host: bindHost, port: localPort, exclusive: true }, () => {
        server.removeListener('error', onError);
        server.on('error', () => this.stopTunnel(id));
        const address = server.address();
        const tunnel = {
          id,
          sessionId,
          type: 'local',
          bindHost,
          localPort: address.port,
          destinationHost,
          destinationPort,
          server,
          sockets,
          channels,
        };
        this.tunnels.set(id, tunnel);
        resolve(this._safeTunnel(tunnel));
      });
    });
  }

  startDynamicTunnel(sessionId, input) {
    sessionId = validateId(sessionId, 'Session ID');
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.stream) throw new Error('Phiên SSH chưa kết nối');
    const id = input.id ? validateId(input.id, 'Tunnel ID') : crypto.randomUUID();
    if (this.tunnels.has(id)) throw new Error('Tunnel đã tồn tại');
    const bindHost = input.bindHost || '127.0.0.1';
    if (!['127.0.0.1', '::1'].includes(bindHost)) {
      throw new Error('SOCKS proxy chỉ được bind vào loopback');
    }
    const localPort = Number(input.localPort);
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
      throw new Error('Local port phải từ 0 đến 65535');
    }
    const sockets = new Set();
    const channels = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = Buffer.alloc(0);
      let state = 'hello';
      const fail = (code = 1) => {
        if (!socket.destroyed && state === 'request') socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
      };
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 4096) return fail();
        if (state === 'hello') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 5) return socket.destroy();
          const count = buffer[1];
          if (buffer.length < 2 + count) return;
          const methods = buffer.subarray(2, 2 + count);
          buffer = buffer.subarray(2 + count);
          if (buffer[0] !== undefined && buffer[0] !== 5) return fail();
          if (!methods.includes(0)) {
            socket.end(Buffer.from([5, 255]));
            return;
          }
          socket.write(Buffer.from([5, 0]));
          state = 'request';
        }
        if (state !== 'request' || buffer.length < 4) return;
        if (buffer[0] !== 5 || buffer[1] !== 1) return fail(7);
        const addressType = buffer[3];
        let offset = 4;
        let destinationHost;
        if (addressType === 1) {
          if (buffer.length < 10) return;
          destinationHost = [...buffer.subarray(offset, offset + 4)].join('.');
          offset += 4;
        } else if (addressType === 3) {
          const length = buffer[offset];
          if (buffer.length < 7 + length) return;
          destinationHost = buffer.subarray(offset + 1, offset + 1 + length).toString('utf8');
          offset += 1 + length;
        } else if (addressType === 4) {
          if (buffer.length < 22) return;
          const parts = [];
          for (let index = 0; index < 16; index += 2) parts.push(buffer.readUInt16BE(offset + index).toString(16));
          destinationHost = parts.join(':');
          offset += 16;
        } else {
          return fail(8);
        }
        if (buffer.length < offset + 2) return;
        const destinationPort = buffer.readUInt16BE(offset);
        const leftover = buffer.subarray(offset + 2);
        try {
          destinationHost = validateHost(destinationHost);
          validatePort(destinationPort);
        } catch {
          return fail(4);
        }
        socket.removeListener('data', onData);
        entry.client.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          destinationHost,
          destinationPort,
          (err, channel) => {
            if (err) return fail(5);
            state = 'connected';
            channels.add(channel);
            channel.on('close', () => channels.delete(channel));
            channel.on('error', () => socket.destroy());
            socket.on('error', () => channel.destroy());
            socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            if (leftover.length) channel.write(leftover);
            socket.pipe(channel).pipe(socket);
          },
        );
      };
      socket.on('data', onData);
      socket.on('error', () => {});
    });
    return this._listenTunnel(
      server,
      {
        id,
        sessionId,
        type: 'dynamic',
        bindHost,
        localPort,
        server,
        sockets,
        channels,
      },
      'SOCKS proxy',
    );
  }

  startRemoteTunnel(sessionId, input) {
    sessionId = validateId(sessionId, 'Session ID');
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.stream) throw new Error('Phiên SSH chưa kết nối');
    const id = input.id ? validateId(input.id, 'Tunnel ID') : crypto.randomUUID();
    if (this.tunnels.has(id)) throw new Error('Tunnel đã tồn tại');
    const bindHost = input.bindHost || '127.0.0.1';
    if (!['127.0.0.1', '::1'].includes(bindHost)) {
      throw new Error('Remote tunnel chỉ được bind vào loopback của máy chủ');
    }
    const remotePort = Number(input.remotePort);
    if (!Number.isInteger(remotePort) || remotePort < 0 || remotePort > 65535) {
      throw new Error('Remote port phải từ 0 đến 65535');
    }
    const destinationHost = validateHost(input.destinationHost);
    const destinationPort = validatePort(input.destinationPort);
    const sockets = new Set();
    const channels = new Set();
    return new Promise((resolve, reject) => {
      entry.client.forwardIn(bindHost, remotePort, (err, assignedPort) => {
        if (err) return reject(new Error('Không mở được remote port: ' + err.message));
        const tunnel = {
          id,
          sessionId,
          type: 'remote',
          bindHost,
          remotePort: assignedPort || remotePort,
          destinationHost,
          destinationPort,
          sockets,
          channels,
          client: entry.client,
        };
        this.tunnels.set(id, tunnel);
        entry.remoteTunnels.set(id, tunnel);
        resolve(this._safeTunnel(tunnel));
      });
    });
  }

  _listenTunnel(server, tunnel, label) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.close();
        reject(new Error('Không mở được ' + label + ': ' + err.message));
      };
      server.once('error', onError);
      server.listen({ host: tunnel.bindHost, port: tunnel.localPort, exclusive: true }, () => {
        server.removeListener('error', onError);
        server.on('error', () => this.stopTunnel(tunnel.id));
        tunnel.localPort = server.address().port;
        this.tunnels.set(tunnel.id, tunnel);
        resolve(this._safeTunnel(tunnel));
      });
    });
  }

  startTunnel(sessionId, input) {
    if (input && input.type === 'dynamic') return this.startDynamicTunnel(sessionId, input);
    if (input && input.type === 'remote') return this.startRemoteTunnel(sessionId, input);
    return this.startLocalTunnel(sessionId, input || {});
  }

  _safeTunnel(tunnel) {
    return {
      id: tunnel.id,
      sessionId: tunnel.sessionId,
      type: tunnel.type,
      bindHost: tunnel.bindHost,
      localPort: tunnel.localPort,
      remotePort: tunnel.remotePort,
      destinationHost: tunnel.destinationHost,
      destinationPort: tunnel.destinationPort,
    };
  }

  listTunnels(sessionId) {
    return [...this.tunnels.values()]
      .filter((tunnel) => !sessionId || tunnel.sessionId === sessionId)
      .map((tunnel) => this._safeTunnel(tunnel));
  }

  stopTunnel(id) {
    id = validateId(id, 'Tunnel ID');
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return false;
    this.tunnels.delete(id);
    for (const socket of tunnel.sockets) socket.destroy();
    for (const channel of tunnel.channels) channel.destroy();
    if (tunnel.type === 'remote') {
      const entry = this.sessions.get(tunnel.sessionId);
      if (entry && entry.remoteTunnels) entry.remoteTunnels.delete(id);
      try {
        tunnel.client.unforwardIn(tunnel.bindHost, tunnel.remotePort, () => {});
      } catch {}
    } else {
      try {
        tunnel.server.close();
      } catch {}
    }
    return true;
  }

  stopSessionTunnels(sessionId) {
    for (const tunnel of [...this.tunnels.values()]) {
      if (tunnel.sessionId === sessionId) this.stopTunnel(tunnel.id);
    }
  }

  disconnect(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    try {
      if (entry.stream) entry.stream.end();
      entry.client.end();
      if (entry.jumpClient) entry.jumpClient.end();
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
    this.stopSessionTunnels(sessionId);
    for (const handler of this.cleanupHandlers) {
      try {
        handler(sessionId);
      } catch {}
    }
    // Xoá bản sao bí mật khỏi RAM khi phiên kết thúc
    if (entry.conn) {
      entry.conn.password = undefined;
      entry.conn.passphrase = undefined;
      if (entry.conn.jumpHost) {
        entry.conn.jumpHost.password = undefined;
        entry.conn.jumpHost.passphrase = undefined;
      }
    }
    try {
      if (entry.jumpClient) entry.jumpClient.end();
    } catch {}
    this.sessions.delete(sessionId);
  }
}

module.exports = { SshManager, KnownHosts, detectAgent };
