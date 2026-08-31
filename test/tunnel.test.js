'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const { SshManager, KnownHosts } = require('../src/main/ssh-manager');

let passed = 0;
function ok(label) { passed += 1; console.log('  PASS  ' + label); }

const manager = new SshManager(new KnownHosts(path.join(__dirname, 'missing-known-hosts.json')), async () => true);
manager.sessions.set('s1', {
  stream: {},
  conn: {},
  client: {
    forwardOut(_sourceHost, _sourcePort, destinationHost, destinationPort, callback) {
      assert.strictEqual(destinationHost, '127.0.0.1');
      assert.strictEqual(destinationPort, 8080);
      callback(null, new Transform({
        transform(chunk, _encoding, done) { done(null, Buffer.concat([Buffer.from('REMOTE:'), chunk])); },
      }));
    },
  },
});

(async () => {
  const tunnel = await manager.startLocalTunnel('s1', {
    localPort: 0,
    destinationHost: '127.0.0.1',
    destinationPort: 8080,
  });
  assert.strictEqual(tunnel.bindHost, '127.0.0.1');
  assert.ok(tunnel.localPort > 0);
  assert.strictEqual(manager.listTunnels('s1').length, 1);
  ok('local tunnel bind loopback và xuất hiện trong registry');

  const response = await new Promise((resolve, reject) => {
    const socket = net.connect(tunnel.localPort, '127.0.0.1', () => socket.write('ping'));
    socket.once('data', (data) => { resolve(data.toString()); socket.destroy(); });
    socket.once('error', reject);
  });
  assert.strictEqual(response, 'REMOTE:ping');
  ok('dữ liệu TCP đi qua ssh forwardOut hai chiều');

  await assert.rejects(
    () => manager.startLocalTunnel('s1', { localPort: tunnel.localPort, destinationHost: '127.0.0.1', destinationPort: 8080 }),
    /Không mở được local port/
  );
  ok('phát hiện local port bị trùng');

  assert.strictEqual(manager.stopTunnel(tunnel.id), true);
  assert.strictEqual(manager.listTunnels('s1').length, 0);
  ok('dừng tunnel đóng listener và dọn registry');

  const second = await manager.startLocalTunnel('s1', { localPort: 0, destinationHost: '127.0.0.1', destinationPort: 8080 });
  manager._cleanup('s1');
  assert.strictEqual(manager.listTunnels().length, 0);
  assert.strictEqual(manager.stopTunnel(second.id), false);
  ok('đóng phiên SSH tự động đóng mọi tunnel liên quan');

  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => { console.error('\nTHAT BAI: ' + err.stack); process.exit(1); });
