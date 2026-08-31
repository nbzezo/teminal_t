'use strict';

// Các lớp chạy nền của main process: ghi log phiên, điều tiết dòng dữ liệu
// terminal, nhớ vị trí cửa sổ, tham số KDF và nhật ký chẩn đoán.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { SessionLogs } = require('../src/main/session-logs');
const { OutputPump } = require('../src/main/output-pump');
const { readWindowState, writeWindowState } = require('../src/main/window-state');
const { readParams, SCRYPT_PARAMS } = require('../src/main/crypto');
const { DiagnosticLog } = require('../src/main/diagnostics');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-runtime-'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  /* ---------------------------------------------------------------- log ---- */

  // Đường dẫn từng làm sập cả main process: chọn một file log đã tồn tại.
  const existing = path.join(tmpDir, 'da-ton-tai.log');
  fs.writeFileSync(existing, 'noi dung cu');
  const failures = [];
  const logs = new SessionLogs((sessionId, message) => failures.push({ sessionId, message }));
  logs.start('s1', existing);
  logs.write('s1', 'xin chao\n');
  await wait(120);
  assert.deepStrictEqual(failures, []);
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'xin chao\n');
  ok('ghi log vào file đã tồn tại thì ghi đè, không ném lỗi không ai bắt');

  logs.stop('s1');
  assert.strictEqual(logs.has('s1'), false);
  ok('dừng ghi log gỡ stream khỏi registry');

  // Stream giả phát 'error' đúng như khi hết đĩa hoặc rút ổ ngoài.
  const broken = Object.assign(new EventEmitter(), {
    destroyed: false,
    write() {},
    end() {},
    destroy() {
      this.destroyed = true;
    },
  });
  const guarded = new SessionLogs(
    (sessionId, message) => failures.push({ sessionId, message }),
    () => broken,
  );
  guarded.start('s2', path.join(tmpDir, 'khong-quan-trong.log'));
  assert.strictEqual(guarded.has('s2'), true);
  broken.emit('error', new Error('ENOSPC: no space left on device'));
  assert.strictEqual(failures.length, 1);
  assert.strictEqual(failures[0].sessionId, 's2');
  assert.match(failures[0].message, /ENOSPC/);
  assert.strictEqual(guarded.has('s2'), false);
  assert.strictEqual(broken.destroyed, true);
  ok("lỗi ghi giữa chừng được báo về ứng dụng thay vì giết main process");

  guarded.write('s2', 'du lieu sau khi hong');
  assert.strictEqual(failures.length, 1);
  ok('ghi tiếp sau khi stream hỏng là thao tác im lặng, không lỗi thêm');

  /* --------------------------------------------------------------- pump ---- */

  const sent = [];
  const flow = [];
  const pump = new OutputPump(
    (chunk) => sent.push(chunk),
    (paused) => {
      flow.push(paused);
      return true;
    },
    { flushMs: 5, highWater: 100, lowWater: 40, stallMs: 60 },
  );

  pump.push('a');
  pump.push('b');
  pump.push('c');
  assert.deepStrictEqual(sent, []);
  await wait(30);
  assert.deepStrictEqual(sent, ['abc']);
  ok('nhiều mẩu dữ liệu trong một khung thời gian được gộp thành một message IPC');

  pump.push('x'.repeat(150));
  pump.flush();
  assert.deepStrictEqual(flow, [true]);
  ok('vượt ngưỡng cao thì phanh dòng SSH lại');

  pump.ack(150);
  assert.deepStrictEqual(flow, [true, false]);
  ok('renderer báo đã vẽ xong thì dòng dữ liệu chảy tiếp');

  pump.push('y'.repeat(150));
  pump.flush();
  assert.strictEqual(flow[flow.length - 1], true);
  await wait(120);
  assert.strictEqual(flow[flow.length - 1], false);
  ok('renderer im lặng quá lâu thì tự mở phanh, không treo phiên vĩnh viễn');

  pump.push('con lai');
  pump.dispose();
  assert.strictEqual(sent[sent.length - 1], 'con lai');
  pump.push('sau khi dispose');
  assert.strictEqual(sent[sent.length - 1], 'con lai');
  ok('dispose đẩy nốt phần còn lại rồi ngừng nhận dữ liệu mới');

  /* ------------------------------------------------------------- cửa sổ ---- */

  const statePath = path.join(tmpDir, 'window-state.json');
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  assert.deepStrictEqual(readWindowState(statePath, displays), {
    width: 1280,
    height: 820,
    maximized: false,
  });
  ok('chưa có file thì dùng kích thước mặc định');

  writeWindowState(statePath, { width: 1000, height: 700, x: 120, y: 80, maximized: true });
  const restored = readWindowState(statePath, displays);
  assert.strictEqual(restored.width, 1000);
  assert.strictEqual(restored.height, 700);
  assert.strictEqual(restored.x, 120);
  assert.strictEqual(restored.maximized, true);
  ok('kích thước, vị trí và trạng thái phóng to được nhớ lại');

  writeWindowState(statePath, { width: 100, height: 50, x: 0, y: 0, maximized: false });
  const clamped = readWindowState(statePath, displays);
  assert.strictEqual(clamped.width, 900);
  assert.strictEqual(clamped.height, 560);
  ok('kích thước nhỏ hơn mức tối thiểu bị kẹp lại');

  // Màn hình phụ đã rút ra: toạ độ cũ nằm ngoài mọi vùng nhìn thấy được.
  writeWindowState(statePath, { width: 1000, height: 700, x: 4000, y: 2200, maximized: false });
  const offscreen = readWindowState(statePath, displays);
  assert.strictEqual(offscreen.x, undefined);
  assert.strictEqual(offscreen.y, undefined);
  ok('toạ độ nằm ngoài mọi màn hình bị bỏ, cửa sổ không mở ra chỗ không nhìn thấy');

  fs.writeFileSync(statePath, 'khong phai json');
  assert.strictEqual(readWindowState(statePath, displays).width, 1280);
  ok('file trạng thái hỏng không làm hỏng việc dựng cửa sổ');

  /* ------------------------------------------------------------- scrypt ---- */

  assert.deepStrictEqual(readParams(undefined), { ...SCRYPT_PARAMS });
  ok('kho không ghi tham số KDF thì dùng mặc định');

  const older = readParams({ N: 16384, r: 8, p: 1 });
  assert.strictEqual(older.N, 16384);
  assert.ok(older.maxmem >= 256 * 16384 * 8);
  ok('tham số KDF của kho cũ được đọc lại nguyên vẹn kèm maxmem đủ dùng');

  for (const bad of [{ N: 3000, r: 8, p: 1 }, { N: 32768, r: 0, p: 1 }, { N: 32768, r: 8, p: 99 }]) {
    assert.throws(() => readParams(bad), /Tham số mã hoá/);
  }
  ok('tham số KDF vô lý bị từ chối thay vì âm thầm dẫn xuất sai khoá');

  /* -------------------------------------------------------- chẩn đoán ---- */

  const diagPath = path.join(tmpDir, 'diagnostic.log');
  const diag = new DiagnosticLog(diagPath);
  assert.strictEqual(diag.write('ssh', 'khong duoc ghi'), false);
  assert.strictEqual(fs.existsSync(diagPath), false);
  ok('nhật ký chẩn đoán mặc định tắt và không tạo file');

  diag.setEnabled(true);
  diag.write('ssh', new Error('login failed for password: sieu-bi-mat'));
  const body = fs.readFileSync(diagPath, 'utf8');
  assert.ok(body.includes('[ssh]'));
  assert.ok(!body.includes('sieu-bi-mat'));
  assert.ok(body.includes('[đã che]'));
  ok('nhật ký chẩn đoán che secret đúng như thông báo lỗi trả về giao diện');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => {
  console.error('\nFAIL: ' + err.message);
  console.error(err.stack);
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // thư mục tạm có thể đã bị xoá
  }
  process.exit(1);
});
