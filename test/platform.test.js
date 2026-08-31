'use strict';

const assert = require('assert');
const path = require('path');
const { createPlatform } = require('../src/main/platform');
const { OPENSSH_AGENT_PIPE } = require('../src/main/platform/windows');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

const winHome = path.resolve('C:\\Users\\Người Dùng');
const windows = createPlatform('win32', {
  env: {},
  homedir: () => winHome,
  existsSync: (candidate) => candidate === OPENSSH_AGENT_PIPE,
});
assert.strictEqual(windows.id, 'win32');
assert.strictEqual(windows.detectSshAgent(), OPENSSH_AGENT_PIPE);
ok('Windows phát hiện named pipe của OpenSSH Agent');

const configuredWindows = createPlatform('win32', {
  env: { SSH_AUTH_SOCK: '\\\\.\\pipe\\custom-agent' },
  homedir: () => winHome,
  existsSync: () => false,
});
assert.strictEqual(configuredWindows.detectSshAgent(), '\\\\.\\pipe\\custom-agent');
ok('SSH_AUTH_SOCK được ưu tiên trên Windows');

const linuxHome = path.resolve('/home/người dùng');
const linux = createPlatform('linux', {
  env: { SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh' },
  homedir: () => linuxHome,
});
assert.strictEqual(linux.id, 'linux');
assert.strictEqual(linux.detectSshAgent(), '/run/user/1000/keyring/ssh');
assert.strictEqual(linux.sshConfigPath(), path.join(linuxHome, '.ssh', 'config'));
ok('Linux dùng SSH_AUTH_SOCK và đường dẫn config theo home');

assert.strictEqual(linux.expandLocalPath('~/.ssh/id_ed25519'), path.join(linuxHome, '.ssh', 'id_ed25519'));
assert.strictEqual(linux.expandLocalPath('~\\.ssh\\khóa có dấu'), path.join(linuxHome, '.ssh', 'khóa có dấu'));
assert.strictEqual(linux.expandLocalPath('"/tmp/key có khoảng trắng"'), '/tmp/key có khoảng trắng');
ok('mở rộng đường dẫn home, Unicode, khoảng trắng và hai kiểu separator');

const unknown = createPlatform('freebsd', { env: {}, homedir: () => '/home/test' });
assert.strictEqual(unknown.id, 'unknown');
assert.strictEqual(unknown.detectSshAgent(), null);
ok('nền tảng ngoài phạm vi dùng fallback an toàn');

console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
