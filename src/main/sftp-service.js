'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateId } = require('./validation');
const { resolveRemotePath, safeRemoteName } = require('./remote-path');

class SftpService {
  constructor(sshManager) {
    this.sshManager = sshManager;
    this.transfers = new Map();
    this.sshManager.onCleanup((sessionId) => this.closeSession(sessionId));
  }

  _entry(sessionId) {
    validateId(sessionId, 'Session ID');
    const entry = this.sshManager.sessions.get(sessionId);
    if (!entry || !entry.stream) throw new Error('Phiên SSH chưa kết nối');
    return entry;
  }

  _remote(entry, candidate) {
    return resolveRemotePath(entry.conn.sftpRoot || '/', candidate);
  }

  _sftp(sessionId) {
    const entry = this._entry(sessionId);
    if (!entry.sftpPromise) {
      entry.sftpPromise = new Promise((resolve, reject) => {
        entry.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
      }).catch((err) => {
        entry.sftpPromise = null;
        throw err;
      });
    }
    return entry.sftpPromise;
  }

  async list(sessionId, remotePath) {
    const entry = this._entry(sessionId);
    const target = this._remote(entry, remotePath);
    const sftp = await this._sftp(sessionId);
    const items = await new Promise((resolve, reject) => {
      sftp.readdir(target, (err, list) => (err ? reject(err) : resolve(list || [])));
    });
    return {
      path: target,
      root: resolveRemotePath(entry.conn.sftpRoot || '/', entry.conn.sftpRoot || '/'),
      items: items.map((item) => ({
        name: item.filename,
        size: Number(item.attrs && item.attrs.size) || 0,
        mode: Number(item.attrs && item.attrs.mode) || 0,
        mtime: Number(item.attrs && item.attrs.mtime) || 0,
        type: item.attrs && item.attrs.isDirectory() ? 'directory' : item.attrs && item.attrs.isSymbolicLink() ? 'symlink' : 'file',
      })),
    };
  }

  async stat(sessionId, remotePath) {
    const entry = this._entry(sessionId);
    const target = this._remote(entry, remotePath);
    const sftp = await this._sftp(sessionId);
    try {
      const attrs = await new Promise((resolve, reject) => sftp.stat(target, (err, value) => (err ? reject(err) : resolve(value))));
      return { exists: true, path: target, size: Number(attrs.size) || 0, directory: attrs.isDirectory() };
    } catch (err) {
      if (err && (err.code === 2 || /no such/i.test(err.message))) return { exists: false, path: target };
      throw err;
    }
  }

  async mkdir(sessionId, parentPath, name) {
    const entry = this._entry(sessionId);
    const target = this._remote(entry, path.posix.join(parentPath, safeRemoteName(name)));
    const sftp = await this._sftp(sessionId);
    await new Promise((resolve, reject) => sftp.mkdir(target, (err) => (err ? reject(err) : resolve())));
    return target;
  }

  async rename(sessionId, sourcePath, newName) {
    const entry = this._entry(sessionId);
    const source = this._remote(entry, sourcePath);
    const destination = this._remote(entry, path.posix.join(path.posix.dirname(source), safeRemoteName(newName)));
    const sftp = await this._sftp(sessionId);
    await new Promise((resolve, reject) => sftp.rename(source, destination, (err) => (err ? reject(err) : resolve())));
    return destination;
  }

  async remove(sessionId, remotePath, isDirectory) {
    const entry = this._entry(sessionId);
    const target = this._remote(entry, remotePath);
    const root = resolveRemotePath(entry.conn.sftpRoot || '/', entry.conn.sftpRoot || '/');
    if (target === root) throw new Error('Không được xoá SFTP root');
    const sftp = await this._sftp(sessionId);
    const method = isDirectory ? 'rmdir' : 'unlink';
    await new Promise((resolve, reject) => sftp[method](target, (err) => (err ? reject(err) : resolve())));
    return true;
  }

  async chmod(sessionId, remotePath, mode) {
    const entry = this._entry(sessionId);
    const target = this._remote(entry, remotePath);
    const parsed = typeof mode === 'string' ? Number.parseInt(mode, 8) : Number(mode);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0o7777) throw new Error('Permission không hợp lệ');
    const sftp = await this._sftp(sessionId);
    await new Promise((resolve, reject) => sftp.chmod(target, parsed, (err) => (err ? reject(err) : resolve())));
    return true;
  }

  async upload(sessionId, localPath, remoteDirectory, onProgress, overwrite = false) {
    const entry = this._entry(sessionId);
    const stat = fs.statSync(localPath);
    if (!stat.isFile()) throw new Error('Nguồn upload phải là file');
    const target = this._remote(entry, path.posix.join(remoteDirectory, safeRemoteName(path.basename(localPath))));
    const sftp = await this._sftp(sessionId);
    const temporary = target + '.upload-' + crypto.randomUUID();
    const result = await this._pipeTransfer({
      sessionId,
      total: stat.size,
      source: fs.createReadStream(localPath),
      destination: sftp.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      onProgress,
      result: { remotePath: target },
    });
    const rename = (source, destination) =>
      new Promise((resolve, reject) => sftp.rename(source, destination, (err) => (err ? reject(err) : resolve())));
    const unlink = (file) =>
      new Promise((resolve, reject) => sftp.unlink(file, (err) => (err ? reject(err) : resolve())));
    let backup = null;
    try {
      if (overwrite) {
        backup = target + '.previous-' + crypto.randomUUID();
        await rename(target, backup);
      }
      await rename(temporary, target);
      if (backup) await unlink(backup);
      return result;
    } catch (err) {
      try { await unlink(temporary); } catch {}
      if (backup) {
        try { await rename(backup, target); } catch {}
      }
      throw err;
    }
  }

  async download(sessionId, remotePath, localPath, onProgress) {
    const entry = this._entry(sessionId);
    const target = this._remote(entry, remotePath);
    const sftp = await this._sftp(sessionId);
    const attrs = await new Promise((resolve, reject) => sftp.stat(target, (err, value) => (err ? reject(err) : resolve(value))));
    const tmp = localPath + '.part-' + crypto.randomUUID();
    try {
      const result = await this._pipeTransfer({
        sessionId,
        total: Number(attrs.size) || 0,
        source: sftp.createReadStream(target),
        destination: fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
        onProgress,
        result: { localPath },
      });
      const backup = localPath + '.previous-' + crypto.randomUUID();
      const existed = fs.existsSync(localPath);
      if (existed) fs.renameSync(localPath, backup);
      try {
        fs.renameSync(tmp, localPath);
        if (existed) fs.unlinkSync(backup);
      } catch (err) {
        if (existed && fs.existsSync(backup)) fs.renameSync(backup, localPath);
        throw err;
      }
      return result;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  _pipeTransfer({ sessionId, total, source, destination, onProgress, result }) {
    const transferId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let transferred = 0;
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        this.transfers.delete(transferId);
        if (err) reject(err);
        else resolve({ transferId, transferred, total, ...result });
      };
      source.on('data', (chunk) => {
        transferred += chunk.length;
        if (onProgress) onProgress({ transferId, sessionId, transferred, total });
      });
      source.on('error', finish);
      destination.on('error', finish);
      destination.on('finish', () => finish());
      this.transfers.set(transferId, { sessionId, source, destination });
      source.pipe(destination);
    });
  }

  cancel(transferId) {
    validateId(transferId, 'Transfer ID');
    const transfer = this.transfers.get(transferId);
    if (!transfer) return false;
    const error = new Error('Tác vụ SFTP đã bị huỷ');
    transfer.source.destroy(error);
    transfer.destination.destroy(error);
    this.transfers.delete(transferId);
    return true;
  }

  closeSession(sessionId) {
    for (const [id, transfer] of this.transfers) {
      if (transfer.sessionId === sessionId) this.cancel(id);
    }
  }
}

module.exports = { SftpService };
