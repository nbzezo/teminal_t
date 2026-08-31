// Kiểm tra tiếng Việt đi trọn vẹn qua đường SSH theo cả hai chiều.
// Điểm dễ hỏng: ký tự tiếng Việt chiếm 2-3 byte UTF-8, nếu TCP cắt gói vào
// giữa một ký tự thì việc giải mã từng mảnh riêng lẻ sẽ sinh ra ký tự thay thế.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const PROJECT = path.join(__dirname, '..');
const { Server } = require(path.join(PROJECT, 'node_modules', 'ssh2'));
const { SshManager, KnownHosts } = require(path.join(PROJECT, 'src', 'main', 'ssh-manager.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-utf8-'));
const hostKeyPath = path.join(tmpDir, 'host_ed25519');
execFileSync('ssh-keygen', ['-t', 'ed25519', '-f', hostKeyPath, '-N', '', '-q']);

const USERNAME = 'tester';
const PASSWORD = 'mat-khau';

// Chuỗi phủ đủ các loại dấu tiếng Việt, kể cả ký tự 3 byte như ế, ữ, ợ
const VIETNAMESE = 'Tiếng Việt: đường dẫn ổ đĩa, cấu hình đã lưu, kiểm thử hoàn tất!';

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

const received = [];
let shellStream = null;

const server = new Server({ hostKeys: [fs.readFileSync(hostKeyPath)] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.password === PASSWORD) return ctx.accept();
    if (ctx.method === 'none') return ctx.reject(['password']);
    return ctx.reject();
  });
  client.on('ready', () => {
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      session.on('pty', (accept) => accept && accept());
      session.on('shell', (accept) => {
        const stream = accept();
        shellStream = stream;
        stream.on('data', (chunk) => received.push(chunk));
      });
    });
  });
  client.on('error', () => {});
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const manager = new SshManager(new KnownHosts(path.join(tmpDir, 'kh.json')), async () => true);

  let output = '';
  await new Promise((resolve) => {
    manager.connect(
      'utf8-session',
      { host: '127.0.0.1', port, username: USERNAME, authType: 'password', password: PASSWORD },
      { cols: 80, rows: 24 },
      {
        onData: (d) => {
          output += d;
        },
        onStatus: (s) => {
          if (s.state === 'connected') setTimeout(resolve, 300);
          if (s.state === 'error') throw new Error(s.message);
        },
        onClose: () => {},
      }
    );
  });

  // --- Chiều server -> app: gửi nguyên khối ---
  shellStream.write(VIETNAMESE + '\n');
  await wait(400);
  check('nhận đúng tiếng Việt khi server gửi nguyên khối', output.includes(VIETNAMESE), output.slice(-90));

  // --- Chiều server -> app: cắt gói vào GIỮA một ký tự nhiều byte ---
  output = '';
  const bytes = Buffer.from(VIETNAMESE, 'utf8');
  // Tìm một vị trí cắt rơi vào giữa ký tự (byte tiếp theo là byte nối 10xxxxxx)
  let splitAt = -1;
  for (let i = 1; i < bytes.length; i += 1) {
    if ((bytes[i] & 0xc0) === 0x80) {
      splitAt = i;
      break;
    }
  }
  assert.ok(splitAt > 0, 'khong tim duoc vi tri cat giua ky tu');

  shellStream.write(bytes.subarray(0, splitAt));
  await wait(150); // đủ lâu để nửa đầu tới nơi thành một sự kiện data riêng
  shellStream.write(bytes.subarray(splitAt));
  await wait(400);
  check(
    'nhận đúng tiếng Việt khi gói tin bị cắt giữa ký tự (byte ' + splitAt + ')',
    output.includes(VIETNAMESE) && !output.includes('�'),
    { nhanDuoc: output.slice(0, 90), coKyTuHong: output.includes('�') }
  );

  // --- Cắt thành từng byte một: trường hợp khắc nghiệt nhất ---
  output = '';
  for (const byte of bytes) {
    shellStream.write(Buffer.from([byte]));
  }
  await wait(600);
  check(
    'nhận đúng tiếng Việt khi server nhỏ giọt từng byte',
    output.includes(VIETNAMESE) && !output.includes('�'),
    { nhanDuoc: output.slice(0, 90) }
  );

  // --- Chiều app -> server: gõ tiếng Việt vào terminal ---
  received.length = 0;
  manager.write('utf8-session', VIETNAMESE + '\n');
  await wait(400);
  const serverGot = Buffer.concat(received).toString('utf8');
  check('server nhận đúng tiếng Việt do người dùng gõ', serverGot.includes(VIETNAMESE), serverGot);

  manager.disconnectAll();
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + passed + ' PASS, ' + failed + ' FAIL');
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nNGOAI LE: ' + err.message);
  console.error(err.stack);
  try { server.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* thu muc tam co the da bi xoa */ }
  process.exit(1);
});
