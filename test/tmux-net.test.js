// Phiên bền qua SSH thật: dựng ssh2.Server trên 127.0.0.1, ghi lại mọi lệnh
// `exec` mà SshManager gửi, rồi kiểm đường gắn tmux, đường lùi khi máy chủ không
// có tmux, và việc đổi kích thước trên channel exec.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const PROJECT = path.join(__dirname, '..');
const { Server } = require(path.join(PROJECT, 'node_modules', 'ssh2'));

const SRC = path.join(PROJECT, 'src', 'main');
const { SshManager, KnownHosts } = require(path.join(SRC, 'ssh-manager.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-tmux-'));
const hostKeyPath = path.join(tmpDir, 'host_ed25519');
execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q']);

const USERNAME = 'tester';
const PASSWORD = 'mat-khau-cua-server';

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

// Máy chủ giả: `hasTmux` quyết định probe trả về gì, để thử cả hai đường.
let hasTmux = true;
let existingSessions = [];
const execLog = [];
const ptyLog = [];
let shellOpened = 0;

const server = new Server({ hostKeys: [fs.readFileSync(hostKeyPath)] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USERNAME && ctx.password === PASSWORD) return ctx.accept();
    if (ctx.method === 'none') return ctx.reject(['password']);
    return ctx.reject();
  });

  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      let pty = null;
      session.on('pty', (accept, _reject, info) => {
        pty = { cols: info.cols, rows: info.rows, term: info.term };
        accept && accept();
      });
      session.on('window-change', (accept, _reject, info) => {
        ptyLog.push({ resized: true, cols: info.cols, rows: info.rows });
        accept && accept();
      });
      session.on('shell', (accept) => {
        shellOpened += 1;
        const stream = accept();
        stream.write('shell thuong\r\n$ ');
      });
      session.on('exec', (accept, _reject, info) => {
        execLog.push({ command: info.command, pty });
        const stream = accept();

        if (info.command.includes('command -v tmux')) {
          if (hasTmux) {
            stream.write('__sshman_tmux__\n');
            for (const item of existingSessions) stream.write(item + '\n');
          }
          stream.exit(0);
          return stream.end();
        }
        if (info.command.includes('kill-session')) {
          stream.exit(info.command.includes('khong-ton-tai') ? 1 : 0);
          return stream.end();
        }
        // Lệnh gắn phiên: giữ channel mở như một terminal thật.
        stream.write('da gan tmux\r\n');
      });
    });
  });
  client.on('error', () => {});
});

function connectSession(manager, id, conn) {
  return new Promise((resolve) => {
    let output = '';
    const statuses = [];
    manager.connect(id, conn, { cols: 100, rows: 30 }, {
      onData: (d) => {
        output += d;
      },
      onStatus: (s) => {
        statuses.push(s);
      },
      onClose: () => {},
    });
    setTimeout(() => resolve({ output, statuses }), 700);
  });
}

function baseConn(extra) {
  return {
    id: 'c1',
    name: 'web01',
    host: '127.0.0.1',
    port: server.address().port,
    username: USERNAME,
    authType: 'password',
    password: PASSWORD,
    ...extra,
  };
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const knownHosts = new KnownHosts(path.join(tmpDir, 'known_hosts.json'));
  const manager = new SshManager(knownHosts, async () => true);

  console.log('\n== Máy chủ có tmux ==');
  existingSessions = ['0 1 1700000000 sshman_web01'];
  const tmux = { enabled: true, name: 'sshman_web01', mouse: true, hideStatus: true, historyLimit: 50000 };
  const first = await connectSession(manager, 's1', baseConn({ tmux, defaultDirectory: '/var/www' }));

  const probe = execLog.find((item) => item.command.includes('command -v tmux'));
  check('probe được gửi đúng một lần cho cả kết nối', execLog.filter((i) => i.command.includes('command -v tmux')).length === 1);
  check('probe hỏi cả danh sách phiên', probe && probe.command.includes('ls -F'));
  // Tên phiên có dấu phải đọc đúng, không bị tmux thay bằng dấu gạch dưới.
  check('probe cũng ép UTF-8', probe && probe.command.includes('tmux -u ls'), probe && probe.command);

  const attach = execLog.find((item) => item.command.includes('attach-session'));
  check('lệnh gắn phiên được gửi qua exec', Boolean(attach));
  check('exec có cấp pty đúng cỡ', attach && attach.pty && attach.pty.cols === 100 && attach.pty.rows === 30, attach && attach.pty);
  check('pty đúng loại terminal', attach && attach.pty && attach.pty.term === 'xterm-256color');
  check('thư mục mặc định được bọc nháy đơn', attach && attach.command.includes("-c '/var/www'"));
  check('không mở shell thường khi đã có tmux', shellOpened === 0, shellOpened);
  check('dữ liệu từ phiên tmux tới được giao diện', first.output.includes('da gan tmux'), first.output);

  const tmuxStatus = first.statuses.find((s) => s.state === 'tmux');
  check('báo tên phiên cho giao diện', tmuxStatus && tmuxStatus.message === 'sshman_web01', tmuxStatus);
  check('báo là gắn lại phiên đang có', tmuxStatus && tmuxStatus.attached === true);

  // Đổi kích thước NGAY khi channel chưa mở: probe tmux tốn một round trip, và
  // giao diện thường fit xong trong khoảng đó. Bỏ qua resize lúc này thì pty kẹt
  // ở cỡ ban đầu và tmux gắn vào window 80x24 giữa một pane rộng gấp đôi.
  ptyLog.length = 0;
  const racing = connectSession(manager, 'race', baseConn({ tmux: { ...tmux, name: 'sshman_race' } }));
  manager.resize('race', 132, 43);
  await racing;
  check(
    'resize gửi trước khi channel mở vẫn tới được server',
    ptyLog.some((p) => p.cols === 132 && p.rows === 43),
    ptyLog,
  );
  const raceAttach = execLog.find((item) => item.command.includes('sshman_race'));
  check('pty ban đầu vẫn được cấp', Boolean(raceAttach && raceAttach.pty));
  manager.disconnect('race');
  await wait(200);

  // Resize phải tới được server trên channel exec, không chỉ trên channel shell.
  manager.resize('s1', 120, 40);
  await wait(200);
  check('đổi kích thước gửi được trên channel exec', ptyLog.some((p) => p.cols === 120 && p.rows === 40), ptyLog);

  console.log('\n== Liệt kê và kết thúc phiên ==');
  const listed = await manager.listTmuxSessions('s1');
  check('đọc được danh sách phiên', listed.available === true && listed.sessions.length === 1, listed);
  check('nhận ra phiên do app tạo', listed.sessions[0].owned === true);

  const killed = await manager.killTmuxSession('s1', 'sshman_web01');
  check('kết thúc phiên trả về thành công', killed === true);
  const killCmd = execLog.find((item) => item.command.includes('kill-session'));
  check('kill dùng so khớp chính xác', killCmd && killCmd.command.includes('-t =sshman_web01'), killCmd);
  check('kill cũng ép UTF-8', killCmd && killCmd.command.startsWith('tmux -u kill-session'), killCmd);

  let killFailed = false;
  try {
    await manager.killTmuxSession('s1', 'khong-ton-tai');
  } catch {
    killFailed = true;
  }
  check('kill thất bại thì báo lỗi chứ không im lặng', killFailed);
  check('tên xấu bị chặn trước khi ra khỏi main process', await (async () => {
    try {
      await manager.killTmuxSession('s1', 'a; reboot');
      return false;
    } catch {
      return true;
    }
  })());

  manager.disconnect('s1');
  await wait(200);

  console.log('\n== Máy chủ không có tmux ==');
  hasTmux = false;
  execLog.length = 0;
  const second = await connectSession(manager, 's2', baseConn({ tmux }));
  check('không gửi lệnh gắn phiên', !execLog.some((item) => item.command.includes('attach-session')));
  check('rơi về shell thường', shellOpened === 1, shellOpened);
  const notice = second.statuses.find((s) => s.state === 'notice');
  check('có cảnh báo cho người dùng', Boolean(notice), second.statuses.map((s) => s.state));
  check('không gắn badge tên phiên', !second.statuses.some((s) => s.state === 'tmux'));
  check('shell thường vẫn chạy bình thường', second.output.includes('shell thuong'), second.output);

  manager.disconnectAll();
  await wait(200);
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + passed + ' PASS, ' + failed + ' FAIL');
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nNGOAI LE: ' + err.message);
  console.error(err.stack);
  try {
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* thu muc tam co the da bi xoa */
  }
  process.exit(1);
});
