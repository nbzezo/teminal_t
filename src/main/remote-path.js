'use strict';

const path = require('path');

function normalizeRemoteRoot(value) {
  const raw = String(value || '/').trim();
  if (!raw.startsWith('/') || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('SFTP root phải là đường dẫn tuyệt đối hợp lệ');
  }
  return path.posix.normalize(raw);
}

function resolveRemotePath(rootValue, candidateValue) {
  const root = normalizeRemoteRoot(rootValue);
  const candidate = String(candidateValue == null ? root : candidateValue).trim();
  if (!candidate || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new Error('Đường dẫn remote không hợp lệ');
  }
  const resolved = path.posix.normalize(
    candidate.startsWith('/') ? candidate : path.posix.join(root, candidate)
  );
  if (root !== '/' && resolved !== root && !resolved.startsWith(root + '/')) {
    throw new Error('Đường dẫn nằm ngoài SFTP root được phép');
  }
  return resolved;
}

function safeRemoteName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('Tên file/thư mục remote không hợp lệ');
  }
  if (/[\u0000-\u001f\u007f]/.test(name) || name.length > 255) {
    throw new Error('Tên file/thư mục remote không hợp lệ');
  }
  return name;
}

module.exports = { normalizeRemoteRoot, resolveRemotePath, safeRemoteName };
