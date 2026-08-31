// Dựng SSH server thật (ssh2.Server) trên 127.0.0.1 rồi cho SshManager kết nối vào,
// kiểm tra auth, cấp pty, chạy lệnh lúc kết nối, gõ lệnh và đổi kích thước.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const net = require('net');
const { execFileSync } = require('child_process');
const PROJECT = path.join(__dirname, '..');
const { Server } = require(path.join(PROJECT, 'node_modules', 'ssh2'));

const SRC = path.join(PROJECT, 'src', 'main');
const { SshManager, KnownHosts } = require(path.join(SRC, 'ssh-manager.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-net-'));
const hostKeyPath = path.join(tmpDir, 'host_ed25519');
const clientKeyPath = path.join(tmpDir, 'client_ed25519');
const protectedKeyPath = path.join(tmpDir, 'client_protected_ed25519');

execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q']);
execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', clientKeyPath, '-N', '', '-q']);
execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', protectedKeyPath, '-N', 'key-passphrase-123', '-q']);

const PASSWORD = 'mat-khau-cua-server';
const USERNAME = 'tester';
const clientPubKey = fs.readFileSync(clientKeyPath + '.pub', 'utf8').trim();

let passed = 0;
let failed = 0;
function check(label, cond, extra) {
  if (cond) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Server giả lập: nhận password hoặc publickey, cấp shell echo lại lệnh ---
const authLog = [];
const ptyLog = [];
const server = new Server({ hostKeys: [fs.readFileSync(hostKeyPath)] }, (client) => {
  client.on('authentication', (ctx) => {
    authLog.push(ctx.method);
    if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) {
      return ctx.accept();
    }
    if (ctx.method === 'publickey' && ctx.username === USERNAME) {
      return ctx.accept(); // đủ cho mục đích test đường đi của key
    }
    if (ctx.method === 'none') return ctx.reject(['password', 'publickey']);
    return ctx.reject();
  });

  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      session.on('pty', (accept, _reject, info) => {
        ptyLog.push({ cols: info.cols, rows: info.rows, term: info.term });
        accept && accept();
      });
      session.on('window-change', (accept, _reject, info) => {
        ptyLog.push({ resized: true, cols: info.cols, rows: info.rows });
        accept && accept();
      });
      session.on('shell', (accept) => {
        const stream = accept();
        stream.write('Chao mung den server test\r\n$ ');
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '');
            buffer = buffer.slice(idx + 1);
            if (line === 'exit') return stream.end();
            stream.write('BAN-GO[' + line + ']\r\n$ ');
          }
        });
      });
    });
  });
  client.on('error', () => {});
});

const jumpServer = new Server({ hostKeys: [fs.readFileSync(hostKeyPath)] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) ctx.accept();
    else ctx.reject(['password']);
  });
  client.on('ready', () => {
    client.on('tcpip', (accept, reject, info) => {
      const socket = net.connect(info.destPort, info.destIP);
      socket.once('connect', () => {
        const channel = accept();
        socket.pipe(channel).pipe(socket);
      });
      socket.once('error', () => reject());
    });
  });
  client.on('error', () => {});
});

function connectSession(manager, id, conn, size) {
  return new Promise((resolve) => {
    let output = '';
    const statuses = [];
    manager.connect(id, conn, size || { cols: 100, rows: 30 }, {
      onData: (d) => {
        output += d;
      },
      onStatus: (s) => {
        statuses.push(s);
        if (s.state === 'connected' || s.state === 'error') {
          setTimeout(
            () =>
              resolve({
                get output() {
                  return output;
                },
                statuses,
              }),
            300,
          );
        }
      },
      onClose: () => {},
    });
  });
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => jumpServer.listen(0, '127.0.0.1', resolve));
  const jumpPort = jumpServer.address().port;
  console.log('  (server test dang chay tai 127.0.0.1:' + port + ')\n');

  // --- 1. Host key lạ bị từ chối thì không kết nối ---
  const rejecting = new SshManager(new KnownHosts(path.join(tmpDir, 'kh-reject.json')), async () => false);
  const rejected = await connectSession(rejecting, 's-reject', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
    password: PASSWORD,
  });
  check(
    'người dùng từ chối host key thì kết nối bị chặn',
    rejected.statuses.some((s) => s.state === 'error'),
    rejected.statuses,
  );

  // --- 2. Chấp nhận host key, đăng nhập bằng mật khẩu ---
  const khPath = path.join(tmpDir, 'kh.json');
  let askedCount = 0;
  const manager = new SshManager(new KnownHosts(khPath), async (info) => {
    askedCount += 1;
    check(
      'vân tay host key đúng định dạng SHA256',
      /^SHA256:[A-Za-z0-9+/]{43}$/.test(info.fingerprint),
      info.fingerprint,
    );
    return true;
  });

  const s1 = await connectSession(manager, 's1', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
    password: PASSWORD,
  });
  check(
    'đăng nhập bằng mật khẩu thành công',
    s1.statuses.some((s) => s.state === 'connected'),
    s1.statuses,
  );
  check('nhận được banner từ server', s1.output.includes('Chao mung den server test'), s1.output);
  check('server ghi nhận auth bằng password', authLog.includes('password'), authLog);

  // --- 3. known_hosts được ghi và tái sử dụng ---
  check(
    'vân tay được ghi vào known_hosts',
    fs.existsSync(khPath) && !!JSON.parse(fs.readFileSync(khPath, 'utf8'))['127.0.0.1:' + port],
  );
  const s2 = await connectSession(manager, 's2', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
    password: PASSWORD,
  });
  check('lần sau không hỏi lại host key nữa', askedCount === 1, { askedCount });
  check(
    'phiên thứ hai chạy song song được',
    s2.statuses.some((s) => s.state === 'connected'),
  );

  // --- 4. Kích thước pty truyền đúng ---
  check(
    'pty được cấp đúng cols/rows và term',
    ptyLog[0] && ptyLog[0].cols === 100 && ptyLog[0].rows === 30 && ptyLog[0].term === 'xterm-256color',
    ptyLog[0],
  );

  manager.resize('s1', 132, 43);
  await wait(300);
  check(
    'đổi kích thước cửa sổ được gửi sang server',
    ptyLog.some((p) => p.resized && p.cols === 132 && p.rows === 43),
    ptyLog.filter((p) => p.resized),
  );

  // --- 5. Gõ lệnh và nhận kết quả ---
  manager.write('s1', 'uptime\n');
  await wait(400);
  check('gõ lệnh thì server nhận đúng nội dung', s1.output.includes('BAN-GO[uptime]'), s1.output.slice(-120));

  // --- 6. Lệnh chạy ngay khi kết nối ---
  const s3 = await connectSession(manager, 's3', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
    password: PASSWORD,
    defaultDirectory: "/srv/O'Reilly",
    onConnect: 'cd /var/www',
  });
  await wait(400);
  check(
    'thư mục mặc định được shell-quote an toàn và tự áp dụng',
    s3.output.includes(`BAN-GO[cd -- '/srv/O'"'"'Reilly']`),
    s3.output.slice(-180),
  );
  check('lệnh onConnect tự chạy sau khi vào shell', s3.output.includes('BAN-GO[cd /var/www]'), s3.output.slice(-120));

  const jumped = await connectSession(manager, 's-jump', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
    password: PASSWORD,
    jumpHost: {
      name: 'Bastion test',
      host: '127.0.0.1',
      port: jumpPort,
      username: USERNAME,
      authType: 'password',
      password: PASSWORD,
    },
  });
  check(
    'kết nối máy đích qua jump host một tầng thành công',
    jumped.statuses.some((s) => s.state === 'connected') && jumped.output.includes('Chao mung'),
    jumped.statuses,
  );

  // --- 7. Sai mật khẩu ---
  const bad = await connectSession(manager, 's-bad', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
    password: 'sai-be-bet',
  });
  check(
    'sai mật khẩu thì báo lỗi chứ không treo',
    bad.statuses.some((s) => s.state === 'error'),
    bad.statuses,
  );

  // --- 8. Đăng nhập bằng private key ---
  const s4 = await connectSession(manager, 's4', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'key',
    privateKeyPath: clientKeyPath,
  });
  check(
    'đăng nhập bằng SSH key thành công',
    s4.statuses.some((s) => s.state === 'connected'),
    s4.statuses,
  );
  check('server ghi nhận auth bằng publickey', authLog.includes('publickey'), authLog);

  const protectedKey = await connectSession(manager, 's-protected-key', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'key',
    privateKeyPath: protectedKeyPath,
    passphrase: 'key-passphrase-123',
  });
  check(
    'đăng nhập bằng private key có passphrase thành công',
    protectedKey.statuses.some((s) => s.state === 'connected'),
    protectedKey.statuses,
  );

  // --- 9. Cấu hình thiếu ---
  const noKey = await connectSession(manager, 's-nokey', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
  });
  check(
    'thiếu mật khẩu đã lưu thì báo lỗi rõ ràng',
    noKey.statuses.some((s) => s.state === 'error' && s.message.includes('chưa lưu mật khẩu')),
    noKey.statuses,
  );

  const missingKey = await connectSession(manager, 's-missingkey', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'key',
    privateKeyPath: path.join(tmpDir, 'khong-ton-tai'),
  });
  check(
    'private key không tồn tại thì báo lỗi rõ ràng',
    missingKey.statuses.some((s) => s.state === 'error' && s.message.includes('Không tìm thấy private key')),
    missingKey.statuses,
  );

  // --- 10. Cảnh báo khi host key đổi ---
  const changed = new KnownHosts(path.join(tmpDir, 'kh-changed.json'));
  const oldFingerprint = 'SHA256:' + 'A'.repeat(43);
  changed.set('127.0.0.1:' + port, oldFingerprint);
  let sawChange = null;
  const warnManager = new SshManager(changed, async (info) => {
    sawChange = info;
    return false;
  });
  const changedRun = await connectSession(warnManager, 's-changed', {
    host: '127.0.0.1',
    port,
    username: USERNAME,
    authType: 'password',
    password: PASSWORD,
  });
  check(
    'host key đổi thì được đánh dấu changed kèm vân tay cũ',
    sawChange && sawChange.changed === true && sawChange.previous === oldFingerprint,
    sawChange,
  );
  check(
    'host key đổi mà từ chối thì không kết nối',
    changedRun.statuses.some((s) => s.state === 'error'),
    changedRun.statuses,
  );
  check(
    'danh sách host key trả về fingerprint đã lưu',
    changed.list().some((entry) => entry.host === '127.0.0.1:' + port && entry.fingerprint === oldFingerprint),
    changed.list(),
  );
  changed.forget('127.0.0.1:' + port);
  check(
    'quên host key xoá cả trong bộ nhớ và file',
    changed.get('127.0.0.1:' + port) === null &&
      !JSON.parse(fs.readFileSync(path.join(tmpDir, 'kh-changed.json'), 'utf8'))['127.0.0.1:' + port],
  );

  // --- 11. Ngắt kết nối dọn sạch phiên ---
  manager.disconnect('s1');
  await wait(300);
  check('disconnect xoá phiên khỏi danh sách', !manager.has('s1'));
  manager.disconnectAll();
  await wait(300);
  check('disconnectAll đóng hết phiên còn lại', manager.sessions.size === 0, manager.sessions.size);

  server.close();
  jumpServer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + passed + ' PASS, ' + failed + ' FAIL');
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nNGOAI LE: ' + err.message);
  console.error(err.stack);
  try {
    server.close();
    jumpServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
