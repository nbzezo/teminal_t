'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = { width: 1280, height: 820 };
const MIN = { width: 900, height: 560 };

/**
 * Kích thước và vị trí cửa sổ, lưu cạnh kho nhưng KHÔNG nằm trong kho: cửa sổ
 * phải dựng được trước khi người dùng nhập master password. Toạ độ cửa sổ không
 * phải bí mật, còn tên máy chủ thì có — nên hai thứ nằm ở hai file khác nhau.
 */
function readWindowState(filePath, displays = []) {
  const state = { ...DEFAULTS, maximized: false };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return state;
  }
  if (!saved || typeof saved !== 'object') return state;

  if (Number.isInteger(saved.width)) state.width = Math.max(MIN.width, Math.min(10000, saved.width));
  if (Number.isInteger(saved.height)) state.height = Math.max(MIN.height, Math.min(10000, saved.height));
  state.maximized = saved.maximized === true;

  // Màn hình có thể đã bị rút ra kể từ lần chạy trước; khôi phục cửa sổ vào một
  // toạ độ không còn tồn tại sẽ khiến app mở ra ngoài vùng nhìn thấy.
  if (Number.isInteger(saved.x) && Number.isInteger(saved.y)) {
    const visible = displays.some((display) => {
      const area = display.workArea || display.bounds;
      if (!area) return false;
      return (
        saved.x + state.width > area.x &&
        saved.x < area.x + area.width &&
        saved.y + 40 > area.y &&
        saved.y < area.y + area.height
      );
    });
    if (visible) {
      state.x = saved.x;
      state.y = saved.y;
    }
  }
  return state;
}

function writeWindowState(filePath, state) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    // Không nhớ được vị trí cửa sổ là phiền, không phải lỗi đáng dừng app.
    return false;
  }
}

/** Trạng thái hiện tại của một BrowserWindow, ở dạng lưu được. */
function captureWindowState(win) {
  const maximized = win.isMaximized();
  // Khi đang phóng to, getBounds() trả kích thước toàn màn hình; cái cần nhớ là
  // kích thước lúc chưa phóng to để nút khôi phục về đúng chỗ cũ.
  const bounds = maximized || win.isMinimized() ? win.getNormalBounds() : win.getBounds();
  return {
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    maximized,
  };
}

module.exports = { readWindowState, writeWindowState, captureWindowState, DEFAULTS, MIN };
