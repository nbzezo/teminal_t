'use strict';

const FLUSH_MS = 16;
const HIGH_WATER = 512 * 1024;
const LOW_WATER = 128 * 1024;
const STALL_MS = 3000;

/**
 * Gom dữ liệu terminal theo khung ~16ms rồi mới đẩy qua IPC, và tạm dừng dòng
 * SSH khi giao diện chưa vẽ kịp.
 *
 * Không có nó, `cat` một file lớn sẽ bơm hàng chục nghìn message IPC nhanh hơn
 * xterm tiêu thụ: RAM phình và cửa sổ đứng. Renderer báo lại số byte đã vẽ
 * (`ack`), và chỉ khi lượng chưa vẽ tụt xuống dưới mức thấp thì dòng mới chảy
 * tiếp. Nếu renderer im lặng quá lâu thì tự mở phanh, để một cái ack không bao
 * giờ tới không treo phiên vĩnh viễn.
 */
class OutputPump {
  /**
   * @param {(chunk: string) => void} send đẩy một khối dữ liệu sang renderer
   * @param {(paused: boolean) => boolean} setFlow phanh/nhả dòng SSH
   * @param {{flushMs?: number, highWater?: number, lowWater?: number, stallMs?: number}} [options]
   */
  constructor(send, setFlow, options = {}) {
    this.send = send;
    this.setFlow = setFlow;
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.highWater = options.highWater ?? HIGH_WATER;
    this.lowWater = options.lowWater ?? LOW_WATER;
    this.stallMs = options.stallMs ?? STALL_MS;
    this.buffer = '';
    this.timer = null;
    this.inFlight = 0;
    this.paused = false;
    this.stallTimer = null;
    this.disposed = false;
  }

  push(text) {
    if (this.disposed || !text) return;
    this.buffer += text;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || !this.buffer) return;
    const chunk = this.buffer;
    this.buffer = '';
    this.inFlight += chunk.length;
    this.send(chunk);
    if (!this.paused && this.inFlight > this.highWater) {
      this.paused = Boolean(this.setFlow(true));
      if (this.paused) {
        this.stallTimer = setTimeout(() => this.resume(), this.stallMs);
        if (typeof this.stallTimer.unref === 'function') this.stallTimer.unref();
      }
    }
  }

  ack(bytes) {
    if (this.disposed) return;
    this.inFlight = Math.max(0, this.inFlight - (Number(bytes) || 0));
    if (this.paused && this.inFlight <= this.lowWater) this.resume();
  }

  resume() {
    clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (!this.paused) return;
    this.paused = false;
    this.inFlight = 0;
    this.setFlow(false);
  }

  dispose() {
    this.flush();
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.stallTimer);
    this.timer = null;
    this.stallTimer = null;
  }
}

module.exports = { OutputPump, FLUSH_MS, HIGH_WATER, LOW_WATER };
