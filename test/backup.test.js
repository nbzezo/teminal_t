'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Vault, migratePayload, PAYLOAD_SCHEMA_VERSION } = require(
  path.join(__dirname, '..', 'src', 'main', 'vault.js')
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-backup-'));
let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

(async () => {
  const migrated = migratePayload({
    connections: [{ id: 'old', host: 'old.example', port: 22, username: 'root' }],
    snippets: [],
  });
  assert.strictEqual(migrated.schemaVersion, PAYLOAD_SCHEMA_VERSION);
  assert.strictEqual(migrated.connections[0].environment, 'development');
  assert.strictEqual(migrated.settings.autoLockMinutes, 15);
  ok('migration bổ sung schema, environment và cấu hình tự khoá');

  const source = new Vault(path.join(tmpDir, 'source.enc'));
  await source.init('master-password-source');
  const bastion = source.saveConnection({
    name: 'Bastion',
    host: 'bastion.example.com',
    port: 22,
    username: 'jump',
    authType: 'key',
    privateKeyPath: '~/.ssh/id_ed25519',
  });
  const production = source.saveConnection({
    name: 'Production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    password: 'credential-never-plain',
    environment: 'production',
    jumpHostId: bastion.id,
  });
  source.saveTunnel(production.id, { type: 'dynamic', name: 'SOCKS', localPort: 1080 });
  source.saveSnippet({ name: 'Uptime', command: 'uptime', autoRun: false });

  await assert.rejects(() => source.createEncryptedBackup('too-short'), /12 ký tự/);
  ok('backup yêu cầu mật khẩu riêng đủ dài');

  const withoutSecrets = await source.createEncryptedBackup('backup-password-123', {
    includeCredentials: false,
  });
  assert.ok(!withoutSecrets.includes('prod.example.com'));
  assert.ok(!withoutSecrets.includes('credential-never-plain'));
  ok('backup mã hoá không lộ host hoặc credential trên đĩa');

  const target = new Vault(path.join(tmpDir, 'target.enc'));
  await target.init('master-password-target');
  await assert.rejects(
    () => target.importEncryptedBackup(withoutSecrets, 'wrong-backup-password'),
    /Sai mật khẩu backup/
  );
  assert.strictEqual(target.listConnections().length, 0);
  ok('sai mật khẩu/tamper bị từ chối mà không thay đổi dữ liệu');

  const imported = await target.importEncryptedBackup(withoutSecrets, 'backup-password-123');
  assert.deepStrictEqual(
    { connectionsAdded: imported.connectionsAdded, snippetsAdded: imported.snippetsAdded },
    { connectionsAdded: 2, snippetsAdded: 1 }
  );
  const importedProduction = target.listConnections().find((conn) => conn.host === 'prod.example.com');
  const importedBastion = target.listConnections().find((conn) => conn.host === 'bastion.example.com');
  assert.strictEqual(target.getConnectionFull(importedProduction.id).password, undefined);
  assert.strictEqual(importedProduction.environment, 'production');
  assert.strictEqual(importedProduction.jumpHostId, importedBastion.id);
  assert.strictEqual(importedProduction.tunnels[0].type, 'dynamic');
  ok('import khôi phục dữ liệu, không tự nhập credential đã loại trừ');

  const again = await target.importEncryptedBackup(withoutSecrets, 'backup-password-123');
  assert.strictEqual(again.connectionsAdded, 0);
  assert.strictEqual(again.snippetsAdded, 0);
  ok('import lặp lại không ghi đè hoặc tạo bản trùng');

  const withSecrets = await source.createEncryptedBackup('backup-password-456', {
    includeCredentials: true,
  });
  const secretTarget = new Vault(path.join(tmpDir, 'secret-target.enc'));
  await secretTarget.init('master-password-secret-target');
  await secretTarget.importEncryptedBackup(withSecrets, 'backup-password-456');
  assert.strictEqual(
    secretTarget.getConnectionFull(secretTarget.listConnections().find((conn) => conn.host === 'prod.example.com').id)
      .password,
    'credential-never-plain'
  );
  ok('credential chỉ được khôi phục khi người dùng chủ động chọn xuất kèm');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => {
  console.error('\nTHAT BAI: ' + err.message);
  console.error(err.stack);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* thu muc tam co the da bi xoa */ }
  process.exit(1);
});
