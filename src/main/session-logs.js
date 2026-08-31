'use strict';

const fs = require('fs');
const { safeErrorMessage } = require('./validation');

/**
 * Log terminal ghi ra đĩa.
 *
 * Mọi lỗi của stream đều phải có người nhận: một sự kiện 'error' không listener
 * trên WriteStream sẽ ném uncaught exception và giết cả main process — kéo theo
 * mọi phiên SSH đang mở. Đây từng là đường dẫn làm sập ứng dụng chỉ vì người
 * dùng chọn một file log đã tồn tại.
 */
class SessionLogs {
  /**
   * @param {(sessionId: string, message: string) => void} onFailure
   * @param {typeof fs.createWriteStream} [createWriteStream] để test tiêm stream giả
   */
  constructor(onFailure, createWriteStream = fs.createWriteStream) {
    this.streams = new Map();
    this.onFailure = onFailure;
    this.createWriteStream = createWriteStream;
  }

  has(sessionId) {
    return this.streams.has(sessionId);
  }

  list() {
    return [...this.streams.keys()];
  }

  start(sessionId, filePath) {
    if (this.streams.has(sessionId)) return true;
    // Hộp thoại lưu file đã hỏi ghi đè rồi, nên 'w' mới là cờ đúng; 'wx' sẽ
    // thất bại đúng với file người dùng vừa chủ động chọn.
    const stream = this.createWriteStream(filePath, { flags: 'w', mode: 0o600 });
    stream.on('error', (err) => this._fail(sessionId, stream, err));
    this.streams.set(sessionId, stream);
    return true;
  }

  _fail(sessionId, stream, err) {
    if (this.streams.get(sessionId) === stream) this.streams.delete(sessionId);
    try {
      stream.destroy();
    } catch {
      // stream đã hỏng, không còn gì để dọn
    }
    this.onFailure(sessionId, safeErrorMessage(err));
  }

  write(sessionId, data) {
    const stream = this.streams.get(sessionId);
    if (!stream || stream.destroyed) return;
    try {
      stream.write(data);
    } catch (err) {
      this._fail(sessionId, stream, err);
    }
  }

  stop(sessionId) {
    const stream = this.streams.get(sessionId);
    if (!stream) return false;
    this.streams.delete(sessionId);
    try {
      stream.end();
    } catch {
      // stream có thể đã đóng, bỏ qua
    }
    return true;
  }

  stopAll() {
    for (const sessionId of [...this.streams.keys()]) this.stop(sessionId);
  }
}

module.exports = { SessionLogs };
