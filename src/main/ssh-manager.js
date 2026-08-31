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
    this._write();
  }

  forget(hostKey) {
    delete this.map[hostKey];
    this._write();
  }

  _write() {
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
 * Quản lý các phiên SSH đang mở.
 *
 * Một "host" là một kết nối SSH thật (một `ssh2.Client`). Một "session" là một
 * shell có pty chạy trên host đó — tức một pane trên giao diện. Chia pane không
 * mở kết nối mới mà xin thêm shell channel trên host sẵn có, nên bốn pane vẫn
 * chỉ tốn một lần bắt tay và một lần xác thực. Host bị đóng khi pane cuối cùng
 * của nó đóng.
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
    this.hosts = new Map();
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

  /** Host của một phiên; phiên do test dựng tay thì tự làm host của chính nó. */
  _hostIdOf(sessionId) {
    const entry = this.sessions.get(sessionId);
    return (entry && entry.hostId) || sessionId;
  }

  _attach(host, sessionId, handlers) {
    const entry = {
      client: host.client,
      stream: null,
      conn: host.conn,
      remoteTunnels: host.remoteTunnels,
      hostId: host.id,
      handlers,
      finished: false,
    };
    host.refs.add(sessionId);
    this.sessions.set(sessionId, entry);
    return entry;
  }

  _fail(sessionId, message) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.finished) return;
    entry.finished = true;
    entry.handlers.onStatus({ state: 'error', message: safeErrorMessage({ message }) });
    this._cleanup(sessionId);
    entry.handlers.onClose();
  }

  /** Lỗi ở tầng kết nối ảnh hưởng mọi pane đang chạy trên host đó. */
  _failHost(host, message) {
    for (const sessionId of [...host.refs]) this._fail(sessionId, message);
  }

  _finishSession(sessionId, state, message) {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.finished) return;
    entry.finished = true;
    entry.handlers.onStatus({ state, message });
    this._cleanup(sessionId);
    entry.handlers.onClose();
  }

  /**
   * Mở một phiên shell mới trên một kết nối SSH mới.
   * @param {string} sessionId
   * @param {object} conn bản ghi đầy đủ từ vault (có thể chứa bí mật)
   * @param {{cols: number, rows: number}} size
   * @param {{onData: Function, onStatus: Function, onClose: Function}} handlers
   */
  connect(sessionId, conn, size, handlers) {
    sessionId = validateId(sessionId, 'Session ID');
    size = clampTerminalSize(size);
    if (this.sessions.has(sessionId)) throw new Error('Phiên đã tồn tại');

    const client = new Client();
    const host = {
      id: 'host-' + crypto.randomUUID(),
      client,
      jumpClient: null,
      conn,
      refs: new Set(),
      remoteTunnels: new Map(),
    };
    this.hosts.set(host.id, host);
    const entry = this._attach(host, sessionId, handlers);

    client.on('ready', () => {
      handlers.onStatus({
        state: 'connected',
        message: 'Đã kết nối ' + conn.username + '@' + conn.host,
      });
      this._openShell(host, sessionId, entry, size, { runOnConnect: true });
    });

    client.on('error', (err) => this._failHost(host, safeErrorMessage(err)));
    client.on('end', () => {
      for (const id of [...host.refs]) {
        const item = this.sessions.get(id);
        if (item && !item.finished) item.handlers.onStatus({ state: 'ended', message: 'Máy chủ đã ngắt kết nối' });
      }
    });
    client.on('tcp connection', (info, accept, reject) => {
      const tunnel =
        [...host.remoteTunnels.values()].find(
          (item) => item.remotePort === info.destPort && item.bindHost === info.destIP,
        ) || [...host.remoteTunnels.values()].find((item) => item.remotePort === info.destPort);
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
      config = this._buildConfig(conn);
    } catch (err) {
      // Lỗi cấu hình (thiếu key...) phải báo bất đồng bộ để caller kịp đăng ký handler
      setImmediate(() => this._fail(sessionId, err.message));
      return;
    }

    if (!conn.jumpHost) {
      handlers.onStatus({
        state: 'connecting',
        message: 'Đang kết nối ' + conn.host + ':' + conn.port + '…',
      });
      client.connect(config);
      return;
    }

    const jumpClient = new Client();
    host.jumpClient = jumpClient;
    let jumpConfig;
    try {
      jumpConfig = this._buildConfig(conn.jumpHost);
    } catch (err) {
      setImmediate(() => this._fail(sessionId, 'Jump host: ' + err.message));
      return;
    }
    jumpClient.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      if (conn.jumpHost.password && prompts.length === 1 && /password/i.test(prompts[0].prompt)) {
        finish([conn.jumpHost.password]);
      } else finish([]);
    });
    jumpClient.once('error', (err) => this._failHost(host, 'Jump host: ' + safeErrorMessage(err)));
    jumpClient.once('ready', () => {
      jumpClient.forwardOut('127.0.0.1', 0, config.host, config.port, (err, channel) => {
        if (err) return this._failHost(host, 'Jump host không tới được máy đích: ' + err.message);
        config.sock = channel;
        handlers.onStatus({
          state: 'connecting',
          message: 'Đang kết nối máy đích qua ' + conn.jumpHost.name + '…',
        });
        client.connect(config);
      });
    });
    handlers.onStatus({
      state: 'connecting',
      message: 'Đang kết nối jump host ' + conn.jumpHost.host + ':' + conn.jumpHost.port + '…',
    });
    jumpClient.connect(jumpConfig);
  }

  /**
   * Thêm một pane trên chính kết nối SSH của một phiên đang chạy: một shell
   * channel nữa, không bắt tay lại, không xác thực lại, không hỏi host key lại.
   */
  openShell(sessionId, sourceSessionId, size, handlers) {
    sessionId = validateId(sessionId, 'Session ID');
    sourceSessionId = validateId(sourceSessionId, 'Session ID');
    if (this.sessions.has(sessionId)) throw new Error('Phiên đã tồn tại');
    const source = this.sessions.get(sourceSessionId);
    if (!source || !source.stream) throw new Error('Phiên gốc chưa kết nối');
    const host = this.hosts.get(source.hostId);
    if (!host) throw new Error('Kết nối gốc không còn tồn tại');

    const entry = this._attach(host, sessionId, handlers);
    handlers.onStatus({
      state: 'connected',
      message: 'Đã mở pane mới trên ' + host.conn.username + '@' + host.conn.host,
    });
    // Lệnh tự động chỉ chạy một lần cho cả kết nối, không lặp ở mỗi pane.
    this._openShell(host, sessionId, entry, clampTerminalSize(size), { runOnConnect: false });
    return { sessionId, hostId: host.id };
  }

  _openShell(host, sessionId, entry, size, { runOnConnect }) {
    const conn = host.conn;
    host.client.shell(
      {
        term: 'xterm-256color',
        cols: size.cols || 80,
        rows: size.rows || 24,
      },
      (err, stream) => {
        if (err) return this._fail(sessionId, 'Không mở được shell: ' + err.message);
        if (!this.sessions.has(sessionId)) {
          // Pane đã bị đóng trong lúc chờ server cấp channel.
          try {
            stream.end();
          } catch {
            // channel có thể đã hỏng, bỏ qua
          }
          return;
        }
        entry.stream = stream;

        // Ký tự tiếng Việt chiếm 2-3 byte UTF-8 và TCP có thể cắt gói vào giữa
        // một ký tự. StringDecoder giữ lại phần byte dở dang chờ mảnh kế tiếp,
        // thay vì giải mã từng mảnh rời rạc và sinh ra ký tự hỏng.
        const outDecoder = new StringDecoder('utf8');
        const errDecoder = new StringDecoder('utf8');
        stream.on('data', (chunk) => entry.handlers.onData(outDecoder.write(chunk)));
        stream.stderr.on('data', (chunk) => entry.handlers.onData(errDecoder.write(chunk)));
        stream.on('close', () => this._finishSession(sessionId, 'closed', 'Phiên đã đóng'));
        if (conn.defaultDirectory && conn.defaultDirectory.trim()) {
          const directory = conn.defaultDirectory.trim().replace(/'/g, `'"'"'`);
          stream.write("cd -- '" + directory + "'\n");
        }
        if (runOnConnect && conn.onConnect && conn.onConnect.trim()) stream.write(conn.onConnect.trim() + '\n');
      },
    );
  }

  _buildConfig(conn) {
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

  /**
   * Phanh dòng dữ liệu từ máy chủ khi giao diện chưa vẽ kịp. Không có nó thì
   * `cat` một file lớn sẽ nhồi IPC nhanh hơn xterm tiêu thụ.
   */
  setFlow(sessionId, paused) {
    const entry = this.sessions.get(sessionId);
    if (!entry || !entry.stream) return false;
    try {
      if (paused) entry.stream.pause();
      else entry.stream.resume();
    } catch {
      return false;
    }
    return true;
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

    return this._listenTunnel(
      server,
      {
        id,
        sessionId,
        hostId: this._hostIdOf(sessionId),
        type: 'local',
        bindHost,
        localPort,
        destinationHost,
        destinationPort,
        server,
        sockets,
        channels,
      },
      'local port',
    );
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
        hostId: this._hostIdOf(sessionId),
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
          hostId: this._hostIdOf(sessionId),
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

  /** Tunnel thuộc về kết nối SSH, nên mọi pane của cùng máy chủ đều thấy nó. */
  listTunnels(sessionId) {
    const hostId = sessionId ? this._hostIdOf(sessionId) : null;
    return [...this.tunnels.values()]
      .filter((tunnel) => !hostId || tunnel.hostId === hostId)
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
      const host = this.hosts.get(tunnel.hostId);
      if (host) host.remoteTunnels.delete(id);
      const entry = this.sessions.get(tunnel.sessionId);
      if (entry && entry.remoteTunnels) entry.remoteTunnels.delete(id);
      try {
        tunnel.client.unforwardIn(tunnel.bindHost, tunnel.remotePort, () => {});
      } catch {
        // client có thể đã đóng, forward tự tiêu khi kết nối kết thúc
      }
    } else {
      try {
        tunnel.server.close();
      } catch {
        // listener có thể đã đóng, bỏ qua
      }
    }
    return true;
  }

  stopHostTunnels(hostId) {
    for (const tunnel of [...this.tunnels.values()]) {
      if (tunnel.hostId === hostId) this.stopTunnel(tunnel.id);
    }
  }

  stopSessionTunnels(sessionId) {
    this.stopHostTunnels(this._hostIdOf(sessionId));
  }

  disconnect(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    try {
      if (entry.stream) entry.stream.end();
    } catch {
      // stream có thể đã đóng, bỏ qua
    }
    this._cleanup(sessionId);
  }

  disconnectAll() {
    for (const id of [...this.sessions.keys()]) this.disconnect(id);
  }

  _wipeSecrets(conn) {
    if (!conn) return;
    conn.password = undefined;
    conn.passphrase = undefined;
    if (conn.jumpHost) {
      conn.jumpHost.password = undefined;
      conn.jumpHost.passphrase = undefined;
    }
  }

  /**
   * Gỡ một pane. Kết nối SSH bên dưới chỉ bị đóng khi pane cuối cùng của nó
   * biến mất, nếu không thì đóng một pane sẽ giết luôn các pane anh em.
   */
  _cleanup(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    for (const handler of this.cleanupHandlers) {
      try {
        handler(sessionId);
      } catch {
        // handler dọn dẹp không được phép chặn việc đóng phiên
      }
    }

    const hostId = entry.hostId || sessionId;
    const host = this.hosts.get(hostId);
    if (host) {
      host.refs.delete(sessionId);
      if (host.refs.size > 0) return;
      this.hosts.delete(hostId);
    }
    this.stopHostTunnels(hostId);
    if (host) {
      try {
        host.client.end();
      } catch {
        // client có thể đã đóng, bỏ qua
      }
      try {
        if (host.jumpClient) host.jumpClient.end();
      } catch {
        // jump client có thể đã đóng, bỏ qua
      }
      // Xoá bản sao bí mật khỏi RAM khi kết nối kết thúc
      this._wipeSecrets(host.conn);
    }
  }
}

module.exports = { SshManager, KnownHosts, detectAgent };
