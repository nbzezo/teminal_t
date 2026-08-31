'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');
const { SftpService } = require('../src/main/sftp-service');
const { resolveRemotePath, safeRemoteName } = require('../src/main/remote-path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-sftp-'));
let passed = 0;
function ok(label) { passed += 1; console.log('  PASS  ' + label); }

function attrs(entry) {
  return {
    size: entry.data ? entry.data.length : 0,
    mode: entry.mode || 0o644,
    mtime: 1,
    isDirectory: () => entry.type === 'directory',
    isSymbolicLink: () => false,
  };
}

const remote = new Map([
  ['/home/test', { type: 'directory', mode: 0o755 }],
  ['/home/test/hello.txt', { type: 'file', data: Buffer.from('xin chào'), mode: 0o644 }],
]);
const fakeSftp = {
  readdir(dir, callback) {
    const prefix = dir.replace(/\/$/, '') + '/';
    const list = [...remote.entries()]
      .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
      .map(([name, entry]) => ({ filename: name.slice(prefix.length), attrs: attrs(entry) }));
    callback(null, list);
  },
  mkdir(target, callback) { remote.set(target, { type: 'directory', mode: 0o755 }); callback(); },
  rename(source, destination, callback) {
    const value = remote.get(source);
    if (!value) return callback(new Error('No such file'));
    remote.delete(source); remote.set(destination, value); callback();
  },
  unlink(target, callback) { remote.delete(target); callback(); },
  rmdir(target, callback) { remote.delete(target); callback(); },
  chmod(target, mode, callback) { remote.get(target).mode = mode; callback(); },
  stat(target, callback) {
    const value = remote.get(target);
    if (!value) { const error = new Error('No such file'); error.code = 2; return callback(error); }
    callback(null, attrs(value));
  },
  createReadStream(target) { return Readable.from(remote.get(target).data); },
  createWriteStream(target) {
    const chunks = [];
    return new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) { remote.set(target, { type: 'file', data: Buffer.concat(chunks), mode: 0o600 }); callback(); },
    });
  },
};

const manager = {
  sessions: new Map([['s1', { stream: {}, conn: { sftpRoot: '/home/test' }, client: { sftp: (callback) => callback(null, fakeSftp) } }]]),
  onCleanup(handler) { this.cleanup = handler; },
};
const service = new SftpService(manager);

(async () => {
  assert.strictEqual(resolveRemotePath('/home/test', 'docs'), '/home/test/docs');
  assert.throws(() => resolveRemotePath('/home/test', '/etc/passwd'), /ngoài SFTP root/);
  assert.throws(() => resolveRemotePath('/home/test', '../outside'), /ngoài SFTP root/);
  assert.throws(() => safeRemoteName('../bad'), /không hợp lệ/);
  ok('canonical path chặn traversal ra ngoài SFTP root');

  const listed = await service.list('s1', '/home/test');
  assert.strictEqual(listed.items[0].name, 'hello.txt');
  assert.strictEqual(listed.root, '/home/test');
  ok('liệt kê file remote trong đúng scope');

  await service.mkdir('s1', '/home/test', 'docs');
  assert.ok(remote.has('/home/test/docs'));
  await service.rename('s1', '/home/test/hello.txt', 'renamed.txt');
  assert.ok(remote.has('/home/test/renamed.txt'));
  await service.chmod('s1', '/home/test/renamed.txt', '600');
  assert.strictEqual(remote.get('/home/test/renamed.txt').mode, 0o600);
  ok('mkdir, rename và chmod dùng path đã kiểm tra');

  const uploadPath = path.join(tmpDir, 'upload.txt');
  fs.writeFileSync(uploadPath, 'dữ liệu upload', 'utf8');
  const progress = [];
  await service.upload('s1', uploadPath, '/home/test', (item) => progress.push(item));
  assert.strictEqual(remote.get('/home/test/upload.txt').data.toString('utf8'), 'dữ liệu upload');
  assert.ok(progress.length > 0);
  ok('upload stream có báo tiến độ');

  const downloadPath = path.join(tmpDir, 'download.txt');
  await service.download('s1', '/home/test/renamed.txt', downloadPath);
  assert.strictEqual(fs.readFileSync(downloadPath, 'utf8'), 'xin chào');
  ok('download ghi qua file tạm rồi đổi tên');

  await service.remove('s1', '/home/test/upload.txt', false);
  assert.ok(!remote.has('/home/test/upload.txt'));
  await assert.rejects(() => service.remove('s1', '/home/test', true), /Không được xoá SFTP root/);
  ok('xóa file hoạt động nhưng không cho xóa SFTP root');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => {
  console.error('\nTHAT BAI: ' + err.stack);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* thu muc tam co the da bi xoa */ }
  process.exit(1);
});
