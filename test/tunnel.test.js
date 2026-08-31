'use strict';

const assert = require('assert');
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const { SshManager, KnownHosts } = require('../src/main/ssh-manager');

let passed = 0;
function ok(label) {
  passed += 1;
  console.log('  PASS  ' + label);
}

const manager = new SshManager(new KnownHosts(path.join(__dirname, 'missing-known-hosts.json')), async () => true);
let remoteStopped = false;
manager.sessions.set('s1', {
  stream: {},
  conn: {},
  remoteTunnels: new Map(),
  client: {
    forwardOut(_sourceHost, _sourcePort, destinationHost, destinationPort, callback) {
      assert.strictEqual(destinationHost, '127.0.0.1');
      assert.strictEqual(destinationPort, 8080);
      callback(
        null,
        new Transform({
          transform(chunk, _encoding, done) {
            done(null, Buffer.concat([Buffer.from('REMOTE:'), chunk]));
          },
        }),
      );
    },
    forwardIn(_bindHost, remotePort, callback) {
      callback(null, remotePort);
    },
    unforwardIn(_bindHost, _remotePort, callback) {
      remoteStopped = true;
      callback();
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
    socket.once('data', (data) => {
      resolve(data.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });
  assert.strictEqual(response, 'REMOTE:ping');
  ok('dữ liệu TCP đi qua ssh forwardOut hai chiều');

  await assert.rejects(
    () =>
      manager.startLocalTunnel('s1', {
        localPort: tunnel.localPort,
        destinationHost: '127.0.0.1',
        destinationPort: 8080,
      }),
    /Không mở được local port/,
  );
  ok('phát hiện local port bị trùng');

  assert.strictEqual(manager.stopTunnel(tunnel.id), true);
  assert.strictEqual(manager.listTunnels('s1').length, 0);
  ok('dừng tunnel đóng listener và dọn registry');

  const dynamic = await manager.startDynamicTunnel('s1', { localPort: 0 });
  const socksResponse = await new Promise((resolve, reject) => {
    const socket = net.connect(dynamic.localPort, '127.0.0.1');
    let output = Buffer.alloc(0);
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (data) => {
      output = Buffer.concat([output, data]);
      if (output.length === 2) {
        assert.deepStrictEqual([...output], [5, 0]);
        socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0x1f, 0x90, 112, 105, 110, 103]));
      } else if (output.includes(Buffer.from('REMOTE:ping'))) {
        resolve(output);
        socket.destroy();
      }
    });
    socket.once('error', reject);
  });
  assert.deepStrictEqual([...socksResponse.subarray(2, 12)], [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(manager.stopTunnel(dynamic.id), true);
  ok('SOCKS5 no-auth chuyển tiếp CONNECT và dữ liệu đầu tiên');

  const remote = await manager.startRemoteTunnel('s1', {
    remotePort: 9022,
    destinationHost: '127.0.0.1',
    destinationPort: 8080,
  });
  assert.strictEqual(remote.type, 'remote');
  assert.strictEqual(remote.remotePort, 9022);
  assert.strictEqual(manager.sessions.get('s1').remoteTunnels.has(remote.id), true);
  assert.strictEqual(manager.stopTunnel(remote.id), true);
  assert.strictEqual(remoteStopped, true);
  ok('remote forwarding đăng ký và huỷ forward trên SSH client');

  assert.throws(
    () =>
      manager.startDynamicTunnel('s1', {
        bindHost: '0.0.0.0',
        localPort: 1080,
      }),
    /loopback/,
  );
  assert.throws(
    () =>
      manager.startRemoteTunnel('s1', {
        bindHost: '0.0.0.0',
        remotePort: 9000,
        destinationHost: '127.0.0.1',
        destinationPort: 8080,
      }),
    /loopback/,
  );
  ok('dynamic và remote tunnel chặn bind public');

  const second = await manager.startLocalTunnel('s1', {
    localPort: 0,
    destinationHost: '127.0.0.1',
    destinationPort: 8080,
  });
  manager._cleanup('s1');
  assert.strictEqual(manager.listTunnels().length, 0);
  assert.strictEqual(manager.stopTunnel(second.id), false);
  ok('đóng phiên SSH tự động đóng mọi tunnel liên quan');

  console.log('\n' + passed + '/' + passed + ' phép kiểm tra đã qua.');
})().catch((err) => {
  console.error('\nTHAT BAI: ' + err.stack);
  process.exit(1);
});
