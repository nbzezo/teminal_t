'use strict';

const assert = require('assert');
const { PassThrough } = require('stream');
const { METRICS_COMMAND, parseLinuxMetrics, collectServerMetrics } = require('../src/main/server-metrics');

const SAMPLE = `__CPU1__
cpu 100 0 100 800 0 0 0 0
__CPU2__
cpu 150 0 150 900 0 0 0 0
__UPTIME__
90061.25 0.00
__LOAD__
0.12 0.34 0.56 1/100 42
__MEM__
MemTotal:       1000000 kB
MemAvailable:    400000 kB
__DISK__
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/root 2000000 500000 1500000 25% /
`;

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

(async () => {
  const parsed = parseLinuxMetrics(SAMPLE);
  assert.strictEqual(parsed.cpuPercent, 50);
  assert.strictEqual(parsed.memoryUsed, 600000 * 1024);
  assert.strictEqual(parsed.memoryTotal, 1000000 * 1024);
  assert.strictEqual(parsed.diskUsed, 500000 * 1024);
  assert.strictEqual(parsed.diskTotal, 2000000 * 1024);
  assert.strictEqual(parsed.uptimeSeconds, 90061);
  assert.deepStrictEqual(parsed.loadAverage, [0.12, 0.34, 0.56]);
  ok('parser tính đúng CPU/RAM/disk/uptime/load từ Linux procfs');

  assert.throws(() => parseLinuxMetrics('__CPU1__\ninvalid'), /không cung cấp Linux/);
  ok('parser từ chối dữ liệu thiếu hoặc hệ điều hành không hỗ trợ');

  let commandSeen = '';
  const client = {
    exec(command, callback) {
      commandSeen = command;
      const stream = new PassThrough();
      callback(null, stream);
      setImmediate(() => stream.end(SAMPLE));
    },
  };
  const collected = await collectServerMetrics(client);
  assert.strictEqual(collected.cpuPercent, 50);
  assert.strictEqual(commandSeen, METRICS_COMMAND);
  assert.ok(!commandSeen.includes('${'));
  ok('collector chỉ chạy command cố định và giới hạn parser đầu ra');

  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => {
  console.error('\nTHAT BAI: ' + err.stack);
  process.exit(1);
});
