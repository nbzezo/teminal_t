'use strict';

import {
  $,
  bridge,
  call,
  state,
  setStatus,
  showError,
  clearError,
  openModal,
  connectionById,
  requireConnectedSession,
  refreshAll,
} from './core.js';

function describe(config) {
  if (config.type === 'dynamic') return 'SOCKS5 127.0.0.1:' + config.localPort;
  if (config.type === 'remote') {
    return 'R 127.0.0.1:' + config.remotePort + ' → local ' + config.destinationHost + ':' + config.destinationPort;
  }
  return 'L 127.0.0.1:' + config.localPort + ' → remote ' + config.destinationHost + ':' + config.destinationPort;
}

async function renderTunnels() {
  const session = requireConnectedSession();
  if (!session) return;
  const conn = connectionById(session.connId);
  const active = await call(bridge.tunnels.list(state.activeSessionId));
  const activeById = new Map(active.map((item) => [item.id, item]));
  const configs = [...((conn && conn.tunnels) || [])];
  for (const item of active) if (!configs.some((saved) => saved.id === item.id)) configs.push(item);

  const list = $('tunnel-list');
  list.textContent = '';
  if (configs.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'row-note dim';
    empty.textContent = 'Chưa có tunnel nào cho máy chủ này.';
    list.appendChild(empty);
    return;
  }
  for (const config of configs) {
    const running = activeById.has(config.id);
    const row = document.createElement('div');
    row.className = 'row';

    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = describe(running ? activeById.get(config.id) : config);

    const status = document.createElement('span');
    status.className = 'tunnel-state' + (running ? ' on' : '');
    status.textContent = running ? 'đang chạy' : 'đã tắt';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-flat btn-sm';
    toggle.textContent = running ? 'Dừng' : 'Bật';
    toggle.addEventListener('click', async () => {
      clearError('tunnel-error');
      try {
        if (running) await call(bridge.tunnels.stop(config.id));
        else await call(bridge.tunnels.start(state.activeSessionId, config));
        await renderTunnels();
      } catch (err) {
        showError('tunnel-error', err.message);
      }
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-destructive btn-sm';
    remove.textContent = 'Xoá';
    remove.addEventListener('click', async () => {
      clearError('tunnel-error');
      try {
        if (running) await call(bridge.tunnels.stop(config.id));
        await call(bridge.connections.deleteTunnel(session.connId, config.id));
        await refreshAll();
        await renderTunnels();
      } catch (err) {
        showError('tunnel-error', err.message);
      }
    });

    row.append(label, status, toggle, remove);
    list.appendChild(row);
  }
}

export function initTunnels() {
  $('btn-tunnels').addEventListener('click', async () => {
    if (!requireConnectedSession()) return;
    clearError('tunnel-error');
    openModal('tunnel-modal');
    await renderTunnels();
  });

  $('t-type').addEventListener('change', () => {
    const type = $('t-type').value;
    $('t-port-label').textContent = type === 'remote' ? 'Remote port' : 'Local port';
    $('t-dest-host-row').hidden = type === 'dynamic';
    $('t-dest-port-row').hidden = type === 'dynamic';
    $('t-dest-host').required = type !== 'dynamic';
    $('t-dest-port').required = type !== 'dynamic';
  });

  $('tunnel-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = requireConnectedSession();
    if (!session) return;
    clearError('tunnel-error');
    const type = $('t-type').value;
    const config = { type, name: type + ' ' + $('t-local-port').value };
    if (type === 'remote') config.remotePort = Number($('t-local-port').value);
    else config.localPort = Number($('t-local-port').value);
    if (type !== 'dynamic') {
      config.destinationHost = $('t-dest-host').value;
      config.destinationPort = Number($('t-dest-port').value);
    }
    try {
      const started = await call(bridge.tunnels.start(state.activeSessionId, config));
      // Cổng 0 để hệ điều hành tự cấp; lưu lại cổng thật đã được cấp.
      await call(
        bridge.connections.saveTunnel(session.connId, {
          ...config,
          ...(type === 'remote' ? { remotePort: started.remotePort } : { localPort: started.localPort }),
          id: started.id,
        }),
      );
      await refreshAll();
      await renderTunnels();
      setStatus('Đã mở ' + (type === 'dynamic' ? 'SOCKS5 proxy.' : type + ' tunnel.'), 'ok');
    } catch (err) {
      showError('tunnel-error', err.message);
    }
  });
}
