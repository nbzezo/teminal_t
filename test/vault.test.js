// Kiểm thử nhanh lớp vault/crypto mà không cần Electron
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'src', 'main');
const { Vault } = require(path.join(SRC, 'vault.js'));
const { encrypt, decrypt, deriveKey, makeSalt } = require(path.join(SRC, 'crypto.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-test-'));
const vaultPath = path.join(tmpDir, 'vault.enc');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

(async () => {
  // --- crypto ---
  const salt = makeSalt();
  const key = await deriveKey('master-password-1', salt);
  const blob = encrypt(key, 'bí mật cần giữ');
  assert.strictEqual(decrypt(key, blob), 'bí mật cần giữ');
  ok('encrypt/decrypt round-trip giữ nguyên UTF-8');

  const wrongKey = await deriveKey('master-password-2', salt);
  assert.throws(() => decrypt(wrongKey, blob));
  ok('sai khoá thì decrypt ném lỗi');

  const tampered = blob.slice(0, -4) + 'AAAA';
  assert.throws(() => decrypt(key, tampered));
  ok('sửa ciphertext thì GCM phát hiện và ném lỗi');

  // --- vault: khởi tạo ---
  const vault = new Vault(vaultPath);
  assert.strictEqual(vault.exists(), false);
  await assert.rejects(() => vault.init('ngan'), /8 ký tự/);
  ok('từ chối master password ngắn hơn 8 ký tự');

  await vault.init('master-password-1');
  assert.strictEqual(vault.exists(), true);
  assert.strictEqual(vault.unlocked, true);
  ok('init tạo được kho và mở khoá luôn');

  // --- vault: lưu kết nối ---
  const saved = vault.saveConnection({
    name: 'Web prod',
    host: '10.0.0.5',
    port: 2222,
    username: 'deploy',
    authType: 'password',
    password: 'super-secret',
    group: 'Production',
    onConnect: 'cd /var/www',
    keepaliveInterval: 0,
    autoReconnect: true,
  });
  assert.strictEqual(saved.password, undefined);
  assert.strictEqual(saved.hasPassword, true);
  ok('bản ghi trả về renderer không kèm mật khẩu');

  assert.strictEqual(vault.getConnectionFull(saved.id).password, 'super-secret');
  assert.strictEqual(vault.getConnectionFull(saved.id).keepaliveInterval, 0);
  assert.strictEqual(vault.getConnectionFull(saved.id).autoReconnect, true);
  ok('main process vẫn đọc được mật khẩu đầy đủ');

  assert.throws(() => vault.saveConnection({ host: 'x' }), /Thiếu username/);
  assert.throws(() => vault.saveConnection({ username: 'x' }), /Thiếu host/);
  ok('bắt buộc host và username');

  // --- vault: giữ bí mật khi sửa mà để trống ô mật khẩu ---
  vault.saveConnection({ id: saved.id, name: 'Web prod v2', host: '10.0.0.5', username: 'deploy', authType: 'password', password: '' });
  assert.strictEqual(vault.getConnectionFull(saved.id).password, 'super-secret');
  assert.strictEqual(vault.getConnectionFull(saved.id).name, 'Web prod v2');
  ok('sửa mà để trống ô mật khẩu thì giữ nguyên mật khẩu cũ');

  // --- vault: đổi sang key thì xoá mật khẩu ---
  const keyConn = vault.saveConnection({
    name: 'DB', host: 'db.internal', username: 'root',
    authType: 'key', privateKeyPath: '~/.ssh/id_ed25519', passphrase: 'pp',
  });
  assert.strictEqual(vault.getConnectionFull(keyConn.id).password, undefined);
  assert.strictEqual(vault.getConnectionFull(keyConn.id).passphrase, 'pp');
  ok('kết nối dùng key không giữ trường mật khẩu');

  // --- snippets ---
  vault.saveSnippet({ name: 'Xem log', command: 'tail -f /var/log/syslog' });
  assert.strictEqual(vault.listSnippets().length, 1);
  assert.strictEqual(vault.listSnippets()[0].autoRun, false);
  ok('lưu được lệnh nhanh, mặc định an toàn không tự chạy');

  vault.touchConnection(saved.id);
  assert.strictEqual(vault.getConnectionFull(saved.id).useCount, 1);
  ok('touchConnection tăng bộ đếm lần dùng');

  vault.saveSettings({ autoLockMinutes: 30 });
  assert.strictEqual(vault.getSettings().autoLockMinutes, 30);
  assert.throws(() => vault.saveSettings({ autoLockMinutes: 0 }), /1 đến 240/);
  ok('cấu hình tự khoá được validate và lưu trong vault');

  // --- khoá / mở lại từ đĩa ---
  vault.lock();
  assert.strictEqual(vault.unlocked, false);
  assert.throws(() => vault.listConnections(), /Kho đang khoá/);
  ok('sau khi khoá thì không đọc được dữ liệu');

  const onDisk = fs.readFileSync(vaultPath, 'utf8');
  assert.ok(!onDisk.includes('super-secret'), 'mật khẩu bị rò ra file!');
  assert.ok(!onDisk.includes('10.0.0.5'), 'host bị rò ra file!');
  ok('file trên đĩa không lộ mật khẩu lẫn tên host');

  const reopened = new Vault(vaultPath);
  await assert.rejects(() => reopened.unlock('sai-mat-khau-roi'), /Sai master password/);
  ok('sai master password thì không mở được');

  await reopened.unlock('master-password-1');
  assert.strictEqual(reopened.listConnections().length, 2);
  assert.strictEqual(reopened.getConnectionFull(saved.id).password, 'super-secret');
  ok('mở lại từ đĩa khôi phục đủ dữ liệu và bí mật');

  // --- đổi master password ---
  await assert.rejects(() => reopened.changeMasterPassword('sai', 'master-password-2'), /cũ không đúng/);
  ok('đổi mật khẩu với mật khẩu cũ sai thì bị từ chối');

  await reopened.changeMasterPassword('master-password-1', 'master-password-2');
  reopened.lock();
  const final = new Vault(vaultPath);
  await assert.rejects(() => final.unlock('master-password-1'), /Sai master password/);
  await final.unlock('master-password-2');
  assert.strictEqual(final.getConnectionFull(saved.id).password, 'super-secret');
  ok('đổi master password xong mở bằng mật khẩu mới, dữ liệu nguyên vẹn');

  assert.strictEqual(final.getSettings().autoLockMinutes, 30);
  ok('migration/schema giữ nguyên cấu hình tự khoá sau khi mở lại');

  const duplicate = final.duplicateConnection(saved.id);
  assert.notStrictEqual(duplicate.id, saved.id);
  assert.ok(duplicate.name.includes('bản sao'));
  assert.strictEqual(final.getConnectionFull(duplicate.id).password, 'super-secret');
  final.deleteConnection(duplicate.id);
  ok('sao chép kết nối giữ credential trong vault nhưng dùng ID mới');

  // --- xoá ---
  final.deleteConnection(saved.id);
  assert.strictEqual(final.listConnections().length, 1);
  ok('xoá kết nối hoạt động');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => {
  console.error('\nTHAT BAI: ' + err.message);
  console.error(err.stack);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
