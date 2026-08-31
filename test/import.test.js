// Kiểm tra bộ đọc ~/.ssh/config bằng cách trỏ HOME sang một thư mục tạm
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-home-'));
process.env.USERPROFILE = fakeHome; // Windows
process.env.HOME = fakeHome; // POSIX

fs.mkdirSync(path.join(fakeHome, '.ssh'));
fs.writeFileSync(
  path.join(fakeHome, '.ssh', 'config'),
  [
    '# Cấu hình thử nghiệm',
    '',
    'Host web-prod',
    '    HostName 203.0.113.10',
    '    User deploy',
    '    Port 2222',
    '    IdentityFile ~/.ssh/id_ed25519',
    '',
    'Host db',
    '  HostName db.internal',
    '  User postgres',
    '',
    'Host *.example.com',
    '  User wildcard-phai-bo-qua',
    '',
    'Host alias-khong-hostname',
    '  User minhtu',
    '',
    // Một mục hỏng không được phép làm hỏng cả lần nhập
    'Host host-sai',
    '  HostName khong hop le/tí nào',
    '  User deploy',
    '',
    'Host sau-muc-hong',
    '  HostName sau-muc-hong.internal',
    '  User deploy',
    '  ProxyJump deploy@web-prod:2222',
    '',
  ].join('\n'),
  'utf8'
);

const { Vault } = require(path.join(__dirname, '..', 'src', 'main', 'vault.js'));

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

(async () => {
  const vaultPath = path.join(fakeHome, 'vault.enc');
  const vault = new Vault(vaultPath);
  await vault.init('master-password-1');

  const result = vault.importSshConfig();
  const list = vault.listConnections();

  assert.strictEqual(result.added, 4);
  ok('nhập đúng 4 mục hợp lệ, bỏ qua Host wildcard');

  // Trước đây một mục sai định dạng ném lỗi ra giữa vòng lặp và giết cả lần nhập.
  assert.strictEqual(result.errors.length, 1);
  assert.strictEqual(result.errors[0].alias, 'host-sai');
  assert.ok(list.some((c) => c.name === 'sau-muc-hong'));
  ok('mục sai định dạng bị bỏ qua kèm lý do, các mục sau vẫn được nhập');

  const jumped = list.find((c) => c.name === 'sau-muc-hong');
  const bastion = list.find((c) => c.name === 'web-prod');
  assert.strictEqual(result.jumpsLinked, 1);
  assert.strictEqual(jumped.jumpHostId, bastion.id);
  ok('ProxyJump được nối vào đúng kết nối làm jump host');

  const web = list.find((c) => c.name === 'web-prod');
  assert.strictEqual(web.host, '203.0.113.10');
  assert.strictEqual(web.username, 'deploy');
  assert.strictEqual(web.port, 2222);
  assert.strictEqual(web.authType, 'key');
  ok('đọc đúng HostName, User và Port');

  assert.ok(web.privateKeyPath.includes('id_ed25519'));
  assert.ok(!web.privateKeyPath.startsWith('~'), 'dấu ~ phải được mở rộng');
  ok('IdentityFile được mở rộng từ ~ thành đường dẫn thật');

  const db = list.find((c) => c.name === 'db');
  assert.strictEqual(db.port, 22);
  assert.strictEqual(db.host, 'db.internal');
  ok('thiếu Port thì mặc định 22');

  const alias = list.find((c) => c.name === 'alias-khong-hostname');
  assert.strictEqual(alias.host, 'alias-khong-hostname');
  ok('không có HostName thì dùng chính alias làm host');

  assert.ok(list.every((c) => c.group === 'Imported'));
  ok('các mục nhập vào được gom nhóm Imported');

  const again = vault.importSshConfig();
  assert.strictEqual(again.added, 0);
  assert.strictEqual(again.skipped, 5);
  assert.strictEqual(vault.listConnections().length, 4);
  ok('nhập lại lần nữa không tạo bản trùng');

  fs.rmSync(fakeHome, { recursive: true, force: true });
  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => {
  console.error('\nTHAT BAI: ' + err.message);
  console.error(err.stack);
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* thu muc tam co the da bi xoa */ }
  process.exit(1);
});
