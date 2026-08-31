'use strict';

const METRICS_COMMAND = [
  "printf '__CPU1__\\n'",
  'head -n 1 /proc/stat 2>/dev/null',
  'sleep 0.2',
  "printf '__CPU2__\\n'",
  'head -n 1 /proc/stat 2>/dev/null',
  "printf '__UPTIME__\\n'",
  'cat /proc/uptime 2>/dev/null',
  "printf '__LOAD__\\n'",
  'cat /proc/loadavg 2>/dev/null',
  "printf '__MEM__\\n'",
  "grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null",
  "printf '__DISK__\\n'",
  'df -Pk / 2>/dev/null',
].join('; ');

function lineAfter(text, marker) {
  const lines = String(text).split(/\r?\n/);
  const index = lines.indexOf(marker);
  return index >= 0 ? lines[index + 1] || '' : '';
}

function cpuSnapshot(line) {
  const parts = String(line).trim().split(/\s+/);
  if (parts[0] !== 'cpu' || parts.length < 5) return null;
  const values = parts.slice(1, 9).map(Number);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return { total: values.reduce((sum, value) => sum + value, 0), idle: values[3] + (values[4] || 0) };
}

function parseLinuxMetrics(output) {
  output = String(output).replace(/\r\n/g, '\n');
  const first = cpuSnapshot(lineAfter(output, '__CPU1__'));
  const second = cpuSnapshot(lineAfter(output, '__CPU2__'));
  const uptimeSeconds = Math.floor(Number.parseFloat(lineAfter(output, '__UPTIME__')));
  const load = lineAfter(output, '__LOAD__')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(Number);
  const memorySection = String(output).split('__MEM__\n')[1]?.split('__DISK__\n')[0] || '';
  const totalMatch = memorySection.match(/^MemTotal:\s+(\d+)\s+kB/im);
  const availableMatch = memorySection.match(/^MemAvailable:\s+(\d+)\s+kB/im);
  const diskLines = String(output).split('__DISK__\n')[1]?.trim().split(/\r?\n/) || [];
  const diskParts = (diskLines[1] || '').trim().split(/\s+/);
  if (
    !first ||
    !second ||
    !Number.isFinite(uptimeSeconds) ||
    !totalMatch ||
    !availableMatch ||
    diskParts.length < 6 ||
    !Number.isFinite(Number(diskParts[1])) ||
    !Number.isFinite(Number(diskParts[2]))
  ) {
    throw new Error('Máy chủ không cung cấp Linux /proc hoặc dữ liệu giám sát không đầy đủ');
  }
  const deltaTotal = second.total - first.total;
  const deltaIdle = second.idle - first.idle;
  const memoryTotal = Number(totalMatch[1]) * 1024;
  const memoryAvailable = Number(availableMatch[1]) * 1024;
  return {
    platform: 'linux',
    cpuPercent: deltaTotal > 0 ? Math.max(0, Math.min(100, Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 1000) / 10)) : 0,
    memoryUsed: memoryTotal - memoryAvailable,
    memoryTotal,
    diskUsed: Number(diskParts[2]) * 1024,
    diskTotal: Number(diskParts[1]) * 1024,
    uptimeSeconds,
    loadAverage: load.every(Number.isFinite) ? load : [],
    collectedAt: new Date().toISOString(),
  };
}

function collectServerMetrics(client, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    let channel = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error('Dashboard hết thời gian chờ máy chủ'));
      try { if (channel) channel.destroy(); } catch {}
    }, timeoutMs);
    client.exec(METRICS_COMMAND, (err, stream) => {
      if (err) return finish(new Error('Không chạy được probe giám sát chỉ đọc'));
      channel = stream;
      stream.on('data', (chunk) => {
        output += chunk.toString('utf8');
        if (output.length > 64 * 1024) {
          try { stream.destroy(); } catch {}
          finish(new Error('Dữ liệu dashboard vượt giới hạn'));
        }
      });
      stream.on('error', () => finish(new Error('Mất kênh dashboard')));
      if (stream.stderr) stream.stderr.on('data', () => {});
      stream.on('close', () => {
        try { finish(null, parseLinuxMetrics(output)); }
        catch (parseError) { finish(parseError); }
      });
    });
  });
}

module.exports = { METRICS_COMMAND, parseLinuxMetrics, collectServerMetrics };
