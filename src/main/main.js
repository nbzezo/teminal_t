'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const { Vault } = require('./vault');
const { SshManager, KnownHosts, detectAgent } = require('./ssh-manager');
const { currentPlatform } = require('./platform');
const { inspectCommand, safeErrorMessage, validateId, clampTerminalSize } = require('./validation');

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
      sandbox: true,
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
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!mainWindow || event.sender !== mainWindow.webContents) {
        throw new Error('Nguồn IPC không được phép');
      }
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: safeErrorMessage(err) };
    }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    vaultPath: vault.filePath,
    agent: detectAgent(),
    platform: currentPlatform.id,
    platformLabel: currentPlatform.label,
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
  handle('vault:settings', () => vault.getSettings());
  handle('vault:saveSettings', (settings) => vault.saveSettings(settings));
  handle('vault:exportBackup', async (password, options) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Xuất backup SSH Manager đã mã hoá',
      defaultPath: 'ssh-manager-backup.sshman',
      filters: [{ name: 'SSH Manager encrypted backup', extensions: ['sshman'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const serialized = await vault.createEncryptedBackup(password, options || {});
    const tmp = result.filePath + '.tmp';
    fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, result.filePath);
    return { canceled: false, path: result.filePath };
  });
  handle('vault:importBackup', async (password) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Nhập backup SSH Manager đã mã hoá',
      filters: [{ name: 'SSH Manager encrypted backup', extensions: ['sshman'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const stat = fs.statSync(result.filePaths[0]);
    if (stat.size > 20 * 1024 * 1024) throw new Error('File backup vượt quá giới hạn 20 MB');
    const imported = await vault.importEncryptedBackup(
      fs.readFileSync(result.filePaths[0], 'utf8'),
      password
    );
    return { canceled: false, ...imported };
  });

  handle('conn:list', () => vault.listConnections());
  handle('conn:save', (conn) => vault.saveConnection(conn));
  handle('conn:delete', (id) => vault.deleteConnection(id));
  handle('conn:duplicate', (id) => vault.duplicateConnection(id));

  handle('snip:list', () => vault.listSnippets());
  handle('snip:save', (snippet) => vault.saveSnippet(snippet));
  handle('snip:delete', (id) => vault.deleteSnippet(id));

  handle('ssh:open', async (sessionId, connectionId, size) => {
    validateId(sessionId, 'Session ID');
    validateId(connectionId, 'Connection ID');
    const conn = vault.getConnectionFull(connectionId);
    if (!conn) throw new Error('Không tìm thấy kết nối');

    if (conn.environment === 'production') {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Xác nhận kết nối Production',
        message: 'Bạn sắp kết nối tới môi trường Production',
        detail: conn.name + '\n' + conn.username + '@' + conn.host + ':' + conn.port,
        buttons: ['Huỷ kết nối', 'Tiếp tục'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) throw new Error('Đã huỷ kết nối Production');
    }

    if (conn.onConnect && conn.onConnect.trim()) {
      const inspected = inspectCommand(conn.onConnect);
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: inspected.dangerous ? 'warning' : 'question',
        title: inspected.dangerous ? 'Lệnh có rủi ro cao' : 'Xác nhận lệnh khi kết nối',
        message: 'Lệnh sau sẽ được gửi sau khi SSH kết nối thành công:',
        detail: inspected.command,
        buttons: ['Huỷ kết nối', 'Kết nối và chạy lệnh'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) throw new Error('Đã huỷ lệnh tự động');
    }

    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, sessionId, payload);
      }
    };

    // Bản sao để SshManager có thể xoá bí mật khỏi RAM mà không đụng vault
    ssh.connect(
      sessionId,
      { ...conn },
      clampTerminalSize(size),
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

  ipcMain.on('ssh:input', (event, sessionId, data) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    try {
      validateId(sessionId, 'Session ID');
      if (typeof data !== 'string' || data.length > 1024 * 1024) return;
      ssh.write(sessionId, data);
    } catch {
      // Bỏ qua IPC không hợp lệ; không phản chiếu dữ liệu nhạy cảm về renderer.
    }
  });
  ipcMain.on('ssh:resize', (event, sessionId, cols, rows) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    try {
      validateId(sessionId, 'Session ID');
      const size = clampTerminalSize({ cols, rows });
      ssh.resize(sessionId, size.cols, size.rows);
    } catch {
      // Bỏ qua IPC không hợp lệ.
    }
  });

  handle('knownHosts:list', () => ssh.knownHosts.list());
  handle('knownHosts:forget', (host) => {
    ssh.knownHosts.forget(String(host));
    return true;
  });

  handle('dialog:pickPrivateKey', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn private key',
      defaultPath: currentPlatform.sshDirectory(),
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
    if (currentPlatform.shouldQuitOnWindowClose()) app.quit();
  });

  app.on('before-quit', () => {
    if (ssh) ssh.disconnectAll();
    if (vault) vault.lock();
  });
}
