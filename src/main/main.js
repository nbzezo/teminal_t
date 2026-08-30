'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const { Vault } = require('./vault');
const { SshManager, KnownHosts, detectAgent } = require('./ssh-manager');

const isDev = process.argv.includes('--dev');

let mainWindow = null;
let vault = null;
let ssh = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    // Không dùng khung của hệ điều hành: thanh tiêu đề do trang tự vẽ theo
    // kiểu GNOME. thickFrame vẫn bật nên kéo cạnh để đổi kích thước và snap
    // của Windows vẫn hoạt động bình thường.
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#242424' : '#fafafa',
    show: false,
    title: 'SSH Manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload cần require('electron') và các module cục bộ
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Không cho trang mở cửa sổ hay điều hướng ra ngoài; link ngoài giao cho trình duyệt
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  // Trang tự vẽ nút phóng to nên cần biết cửa sổ đang ở trạng thái nào
  const sendWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('win:state', { maximized: mainWindow.isMaximized() });
    }
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Hộp thoại xác nhận host key khi kết nối lần đầu hoặc khi vân tay đổi. */
async function confirmHostKey({ host, port, fingerprint, changed, previous }) {
  if (!mainWindow) return false;

  if (changed) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'HOST KEY ĐÃ THAY ĐỔI',
      message: 'Vân tay host key của ' + host + ':' + port + ' khác lần trước!',
      detail:
        'Đã lưu:\n  ' +
        previous +
        '\n\nMáy chủ vừa gửi:\n  ' +
        fingerprint +
        '\n\nĐiều này có thể do máy chủ được cài lại, NHƯNG cũng có thể là dấu hiệu ' +
        'bị nghe lén (man-in-the-middle). Chỉ chấp nhận nếu bạn tự tay đổi máy chủ ' +
        'và đã đối chiếu vân tay này với quản trị viên.',
      buttons: ['Huỷ kết nối', 'Tôi đã xác minh, vẫn tin'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: 'Máy chủ lạ',
    message: 'Kết nối lần đầu tới ' + host + ':' + port,
    detail:
      'Vân tay host key:\n  ' +
      fingerprint +
      '\n\nHãy đối chiếu với vân tay thật của máy chủ trước khi chấp nhận. ' +
      'Sau khi tin, vân tay sẽ được ghi nhớ và mọi thay đổi về sau đều bị cảnh báo.',
    buttons: ['Huỷ', 'Tin máy chủ này'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}

/** Bọc handler IPC để lỗi trả về renderer dưới dạng dữ liệu, không phải exception. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    vaultPath: vault.filePath,
    agent: detectAgent(),
    platform: process.platform,
  }));

  handle('vault:status', () => vault.status());
  handle('vault:init', (password) => vault.init(password));
  handle('vault:unlock', (password) => vault.unlock(password));
  handle('vault:lock', () => {
    ssh.disconnectAll();
    return vault.lock();
  });
  handle('vault:changePassword', (oldPw, newPw) => vault.changeMasterPassword(oldPw, newPw));
  handle('vault:importSshConfig', () => vault.importSshConfig());

  handle('conn:list', () => vault.listConnections());
  handle('conn:save', (conn) => vault.saveConnection(conn));
  handle('conn:delete', (id) => vault.deleteConnection(id));

  handle('snip:list', () => vault.listSnippets());
  handle('snip:save', (snippet) => vault.saveSnippet(snippet));
  handle('snip:delete', (id) => vault.deleteSnippet(id));

  handle('ssh:open', (sessionId, connectionId, size) => {
    const conn = vault.getConnectionFull(connectionId);
    if (!conn) throw new Error('Không tìm thấy kết nối');

    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, sessionId, payload);
      }
    };

    // Bản sao để SshManager có thể xoá bí mật khỏi RAM mà không đụng vault
    ssh.connect(
      sessionId,
      { ...conn },
      size || {},
      {
        onData: (data) => send('ssh:data', data),
        onStatus: (status) => send('ssh:status', status),
        onClose: () => send('ssh:status', { state: 'gone' }),
      }
    );
    vault.touchConnection(connectionId);
    return { sessionId };
  });

  handle('ssh:close', (sessionId) => {
    ssh.disconnect(sessionId);
    return true;
  });

  ipcMain.on('ssh:input', (_event, sessionId, data) => ssh.write(sessionId, data));
  ipcMain.on('ssh:resize', (_event, sessionId, cols, rows) => ssh.resize(sessionId, cols, rows));

  handle('dialog:pickPrivateKey', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('win:minimize', () => {
    if (mainWindow) mainWindow.minimize();
    return true;
  });

  handle('win:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });

  handle('win:close', () => {
    if (mainWindow) mainWindow.close();
    return true;
  });

  handle('win:isMaximized', () => Boolean(mainWindow && mainWindow.isMaximized()));

  handle('dialog:confirm', async (message, detail) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      message,
      detail,
      buttons: ['Huỷ', 'Đồng ý'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  });
}

/**
 * Cửa sổ không có khung nên phải bỏ hẳn menu: nếu còn menu, Electron sẽ vẽ
 * thanh menu vào trong vùng nội dung và đè lên thanh tiêu đề tự vẽ.
 * Phím tắt do renderer tự xử lý.
 */
function buildMenu() {
  Menu.setApplicationMenu(null);
}

// Chỉ cho phép một tiến trình, tránh hai cửa sổ ghi đè vault của nhau
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    const userData = app.getPath('userData');
    vault = new Vault(path.join(userData, 'vault.enc'));
    ssh = new SshManager(new KnownHosts(path.join(userData, 'known_hosts.json')), confirmHostKey);

    registerIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (ssh) ssh.disconnectAll();
    if (vault) vault.lock();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    if (ssh) ssh.disconnectAll();
    if (vault) vault.lock();
  });
}
