'use strict';

const fs = require('fs');
const path = require('path');
const { safeErrorMessage } = require('./validation');

const MAX_BYTES = 1024 * 1024;

/**
 * Nhật ký chẩn đoán, mặc định tắt.
 *
 * Thông báo lỗi trả về giao diện bị cắt ngắn và che secret — đúng cho bảo mật
 * nhưng khiến việc gỡ một lỗi kết nối thật gần như bất khả thi. Nhật ký này là
 * lối thoát: người dùng tự bật khi cần, nội dung đi qua đúng bộ lọc che secret
 * như mọi thông báo khác, và file tự xoay vòng ở 1 MB để không phình vô hạn.
 */
class DiagnosticLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.enabled = false;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled) this.write('app', 'Bật nhật ký chẩn đoán');
    return this.enabled;
  }

  /**
   * @param {string} scope vùng phát sinh (ssh, sftp, vault…)
   * @param {unknown} message chuỗi hoặc Error
   */
  write(scope, message) {
    if (!this.enabled) return false;
    const text = message instanceof Error ? safeErrorMessage(message) : safeErrorMessage({ message: String(message) });
    const line = new Date().toISOString() + '  [' + String(scope).slice(0, 24) + ']  ' + text + '\n';
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > MAX_BYTES) {
        fs.renameSync(this.filePath, this.filePath + '.1');
      }
      fs.appendFileSync(this.filePath, line, { mode: 0o600 });
      return true;
    } catch {
      // Nhật ký hỏng không bao giờ được phép làm hỏng thao tác đang chạy.
      return false;
    }
  }
}

module.exports = { DiagnosticLog };
