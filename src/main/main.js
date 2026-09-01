'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard, screen } = require('electron');
const { Vault } = require('./vault');
const { SshManager, KnownHosts, detectAgent } = require('./ssh-manager');
const { currentPlatform } = require('./platform');
const {
  inspectCommand,
  safeErrorMessage,
  validateId,
  clampTerminalSize,
  validateTmuxName,
  buildTmuxSessionName,
} = require('./validation');
const { SftpService } = require('./sftp-service');
const { DiagnosticLog } = require('./diagnostics');
const { readWindowState, writeWindowState, captureWindowState } = require('./window-state');
const { SessionLogs } = require('./session-logs');
const { OutputPump } = require('./output-pump');

const isDev = process.argv.includes('--dev');

let mainWindow = null;
let vault = null;
let ssh = null;
let sftp = null;
let diagnostics = null;
let windowStatePath = null;
let quitConfirmed = false;
let windowStateTimer = null;

let sessionLogs = null;
const pumps = new Map();

function disposePump(sessionId) {
  const pump = pumps.get(sessionId);
  if (!pump) return;
  pumps.delete(sessionId);
  pump.dispose();
}

/* =========================================================================
 * Cửa sổ
 * ========================================================================= */

function notify(message, kind = 'error') {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:notice', { message, kind });
}

function scheduleWindowStateSave() {
  clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      writeWindowState(windowStatePath, captureWindowState(mainWindow));
    }
  }, 500);
}

function createWindow() {
  const displays = (() => {
    try {
      return screen.getAllDisplays();
    } catch {
      return [];
    }
  })();
  const saved = readWindowState(windowStatePath, displays);

  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(Number.isInteger(saved.x) && Number.isInteger(saved.y) ? { x: saved.x, y: saved.y } : {}),
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

  if (saved.maximized) mainWindow.maximize();
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
      mainWindow.webContents.send('win:state', {
        maximized: mainWindow.isMaximized(),
      });
    }
    scheduleWindowStateSave();
  };
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.on('resize', scheduleWindowStateSave);
  mainWindow.on('move', scheduleWindowStateSave);

  // Đóng cửa sổ khi còn phiên đang chạy là mất hết việc đang làm, kể cả lệnh
  // chạy dở — nên phải hỏi, trừ khi người dùng tự tắt xác nhận trong cài đặt.
  mainWindow.on('close', (event) => {
    writeWindowState(windowStatePath, captureWindowState(mainWindow));
    if (quitConfirmed) return;
    const liveSessions = ssh ? ssh.sessions.size : 0;
    if (liveSessions === 0 || !vault || !vault.unlocked) return;
    let confirmOnExit = true;
    try {
      confirmOnExit = vault.getSettings().confirmOnExit !== false;
    } catch {
      confirmOnExit = true;
    }
    if (!confirmOnExit) return;

    event.preventDefault();
    dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Còn phiên SSH đang mở',
        message:
          liveSessions === 1 ? 'Còn 1 phiên SSH đang mở' : 'Còn ' + liveSessions + ' phiên SSH đang mở',
        detail: 'Thoát bây giờ sẽ ngắt hết, kể cả lệnh đang chạy dở.',
        buttons: ['Ở lại', 'Thoát và ngắt kết nối'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) => {
        if (response !== 1) return;
        quitConfirmed = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      })
      .catch(() => {});
  });

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
      noteActivity();
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      if (diagnostics) diagnostics.write(channel, err);
      return { ok: false, error: safeErrorMessage(err) };
    }
  });
}

/* =========================================================================
 * Tự khoá kho
 * ========================================================================= */

let lastActivityAt = Date.now();
let autoLockTimer = null;

function noteActivity() {
  lastActivityAt = Date.now();
}

/**
 * Đồng hồ tự khoá nằm ở main process chứ không chỉ ở renderer: nếu trang treo
 * hoặc bị dừng, kho vẫn phải khoá đúng hạn.
 */
function startAutoLockWatch() {
  clearInterval(autoLockTimer);
  autoLockTimer = setInterval(() => {
    if (!vault || !vault.unlocked) return;
    let minutes = 15;
    try {
      minutes = Number(vault.getSettings().autoLockMinutes) || 15;
    } catch {
      minutes = 15;
    }
    if (Date.now() - lastActivityAt < minutes * 60 * 1000) return;
    lockVault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vault:locked');
  }, 15000);
}

function lockVault() {
  sessionLogs.stopAll();
  for (const sessionId of [...pumps.keys()]) disposePump(sessionId);
  ssh.disconnectAll();
  return vault.lock();
}

function applyTheme(theme) {
  if (['system', 'light', 'dark'].includes(theme)) nativeTheme.themeSource = theme;
}

/* =========================================================================
 * IPC
 * ========================================================================= */

// Phiên đang chờ người dùng xác nhận trong hộp thoại, và những phiên đã bị đóng
// trước khi kịp kết nối. Không có sổ này, đóng tab lúc hộp thoại còn mở sẽ để
// lại một kết nối SSH sống mà giao diện không còn cách nào chạm tới.
const pendingOpens = new Set();
const cancelledOpens = new Set();

function abortIfCancelled(sessionId) {
  if (!cancelledOpens.delete(sessionId)) return false;
  pendingOpens.delete(sessionId);
  return true;
}

function registerIpc() {
  const connectionForSsh = (connectionId, options = {}) => {
    const conn = vault.getConnectionFull(connectionId);
    if (!conn) throw new Error('Không tìm thấy kết nối');
    const copy = {
      ...conn,
      ...(options.clearOnConnect ? { onConnect: '' } : {}),
    };
    if (conn.jumpHostId) {
      if (conn.jumpHostId === conn.id) throw new Error('Một kết nối không thể tự làm jump host');
      const jump = vault.getConnectionFull(conn.jumpHostId);
      if (!jump) throw new Error('Jump host không còn tồn tại');
      if (jump.jumpHostId) throw new Error('Hiện chỉ hỗ trợ một tầng jump host');
      copy.jumpHost = { ...jump, onConnect: '', defaultDirectory: '' };
    }
    return copy;
  };

  /**
   * Phiên bền có bật cho pane này không, và tên tmux của nó.
   *
   * Tên do main process tự dựng từ tên máy chủ trong kho cộng vị trí tab/pane;
   * renderer chỉ gửi hai con số. Không có chuỗi nào từ renderer đi thẳng vào
   * lệnh chạy trên máy chủ.
   */
  const resolveTmux = (connectionId, slot = {}) => {
    const conn = vault.getConnectionFull(connectionId);
    if (!conn) throw new Error('Không tìm thấy kết nối');
    const settings = vault.getSettings();
    const mode = conn.persistentSession || (settings.persistentSessionDefault ? 'on' : 'off');
    if (mode !== 'on') return null;
    return {
      enabled: true,
      name: buildTmuxSessionName(conn.name, {
        tabIndex: slot && slot.tabIndex,
        paneIndex: slot && slot.paneIndex,
        base: conn.tmuxSessionName || '',
      }),
      mouse: settings.tmuxMouse,
      hideStatus: settings.tmuxHideStatus,
      historyLimit: settings.tmuxHistoryLimit,
    };
  };

  /** Bộ handler chung cho cả mở mới, mở lại và tách pane. */
  const sessionHandlers = (sessionId) => {
    disposePump(sessionId);
    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, sessionId, payload);
      }
    };
    const pump = new OutputPump(
      (chunk) => send('ssh:data', chunk),
      (paused) => ssh.setFlow(sessionId, paused),
    );
    pumps.set(sessionId, pump);
    return {
      onData: (data) => {
        pump.push(data);
        sessionLogs.write(sessionId, data);
      },
      onStatus: (status) => send('ssh:status', status),
      onClose: () => {
        disposePump(sessionId);
        sessionLogs.stop(sessionId);
        send('ssh:status', { state: 'gone' });
      },
    };
  };

  handle('app:info', () => ({
    version: app.getVersion(),
    vaultPath: vault.filePath,
    diagnosticPath: diagnostics.filePath,
    agent: detectAgent(),
    platform: currentPlatform.id,
    platformLabel: currentPlatform.label,
  }));
  handle('app:setTheme', (theme) => {
    applyTheme(String(theme));
    return nativeTheme.themeSource;
  });

  handle('clipboard:readText', async () => {
    if (!mainWindow || !mainWindow.isFocused()) throw new Error('Chỉ được paste khi ứng dụng đang được focus');
    const text = await clipboard.readText();
    return text.slice(0, 1024 * 1024);
  });
  handle('clipboard:writeText', async (text) => {
    if (!mainWindow || !mainWindow.isFocused()) throw new Error('Chỉ được copy khi ứng dụng đang được focus');
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Nội dung clipboard không hợp lệ');
    await clipboard.writeText(text);
    return true;
  });
  handle('clipboard:clearIfMatches', async (expected) => {
    if (typeof expected !== 'string' || expected.length > 1024 * 1024) return false;
    if ((await clipboard.readText()) !== expected) return false;
    clipboard.clear();
    return true;
  });

  handle('vault:status', () => vault.status());
  handle('vault:init', async (password) => {
    const status = await vault.init(password);
    diagnostics.setEnabled(vault.getSettings().diagnosticLog);
    return status;
  });
  handle('vault:unlock', async (password) => {
    const status = await vault.unlock(password);
    const settings = vault.getSettings();
    diagnostics.setEnabled(settings.diagnosticLog);
    // Chỉ ép themeSource khi người dùng đã chọn cụ thể; 'system' nghĩa là không
    // đụng vào, để Electron giữ nguyên hành vi theo hệ điều hành.
    if (settings.theme !== 'system') applyTheme(settings.theme);
    return status;
  });
  handle('vault:lock', () => lockVault());
  handle('vault:changePassword', (oldPw, newPw) => vault.changeMasterPassword(oldPw, newPw));
  handle('vault:importSshConfig', () => vault.importSshConfig());
  handle('vault:settings', () => vault.getSettings());
  handle('vault:saveSettings', (settings) => {
    const saved = vault.saveSettings(settings);
    diagnostics.setEnabled(saved.diagnosticLog);
    applyTheme(saved.theme);
    return saved;
  });
  handle('vault:workspace', () => vault.getWorkspace());
  handle('vault:saveWorkspace', (workspace) => vault.saveWorkspace(workspace));
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
    const imported = await vault.importEncryptedBackup(fs.readFileSync(result.filePaths[0], 'utf8'), password);
    return { canceled: false, ...imported };
  });

  handle('conn:list', () => vault.listConnections());
  handle('conn:save', (conn) => vault.saveConnection(conn));
  handle('conn:jumpUsers', (id) => vault.connectionsUsingJumpHost(id).map((conn) => conn.name));
  handle('conn:delete', (id) => vault.deleteConnection(id));
  handle('conn:duplicate', (id) => vault.duplicateConnection(id));
  handle('conn:setPersistent', (id, mode) => vault.setPersistentSession(validateId(id, 'Connection ID'), mode));
  handle('conn:saveTunnel', (connectionId, tunnel) => vault.saveTunnel(connectionId, tunnel));
  handle('conn:deleteTunnel', (connectionId, tunnelId) => vault.deleteTunnel(connectionId, tunnelId));

  handle('snip:list', () => vault.listSnippets());
  handle('snip:save', (snippet) => vault.saveSnippet(snippet));
  handle('snip:delete', (id) => vault.deleteSnippet(id));

  handle('ssh:open', async (sessionId, connectionId, size, slot) => {
    validateId(sessionId, 'Session ID');
    validateId(connectionId, 'Connection ID');
    const conn = connectionForSsh(connectionId);
    pendingOpens.add(sessionId);

    try {
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
      if (abortIfCancelled(sessionId)) throw new Error('Phiên đã được đóng trước khi kết nối');

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
      if (abortIfCancelled(sessionId)) throw new Error('Phiên đã được đóng trước khi kết nối');
    } finally {
      pendingOpens.delete(sessionId);
      cancelledOpens.delete(sessionId);
    }

    // Bản sao để SshManager có thể xoá bí mật khỏi RAM mà không đụng vault
    ssh.connect(
      sessionId,
      { ...conn, tmux: resolveTmux(connectionId, slot) },
      clampTerminalSize(size),
      sessionHandlers(sessionId),
    );
    vault.touchConnection(connectionId);
    return { sessionId };
  });

  handle('ssh:close', (sessionId) => {
    if (pendingOpens.has(sessionId)) cancelledOpens.add(sessionId);
    disposePump(sessionId);
    sessionLogs.stop(sessionId);
    ssh.disconnect(sessionId);
    return true;
  });
  handle('ssh:metrics', (sessionId) => ssh.probeMetrics(sessionId));

  handle('ssh:tmuxList', (sessionId) => {
    validateId(sessionId, 'Session ID');
    return ssh.listTmuxSessions(sessionId);
  });

  handle('ssh:tmuxKill', async (sessionId, name) => {
    validateId(sessionId, 'Session ID');
    const target = validateTmuxName(name);
    // Kết thúc phiên là giết mọi tiến trình đang chạy trong đó. Hỏi bằng hộp
    // thoại của hệ điều hành, cùng kiểu với cảnh báo Production.
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Kết thúc phiên trên máy chủ',
      message: 'Kết thúc hẳn phiên ' + target + '?',
      detail: 'Mọi tiến trình đang chạy trong phiên này sẽ bị dừng. Không khôi phục được.',
      buttons: ['Giữ lại', 'Kết thúc'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) throw new Error('Đã huỷ kết thúc phiên');
    return ssh.killTmuxSession(sessionId, target);
  });

  handle('ssh:split', (sessionId, sourceSessionId, size, connectionId, slot) => {
    validateId(sessionId, 'Session ID');
    validateId(sourceSessionId, 'Session ID');
    validateId(connectionId, 'Connection ID');
    return ssh.openShell(
      sessionId,
      sourceSessionId,
      clampTerminalSize(size),
      sessionHandlers(sessionId),
      resolveTmux(connectionId, slot),
    );
  });

  handle('ssh:reconnect', (sessionId, connectionId, size, slot) => {
    validateId(sessionId, 'Session ID');
    validateId(connectionId, 'Connection ID');
    const conn = connectionForSsh(connectionId, { clearOnConnect: true });
    // Chỉ dùng cho retry tự động. Kết nối lại do người dùng bấm đi qua `ssh:open`
    // để cảnh báo Production và xác nhận lệnh tự động vẫn được hiện đầy đủ.
    if (!conn || !conn.autoReconnect) throw new Error('Kết nối lại tự động chưa được bật');
    // Ngoại lệ có chủ đích của quy tắc "không chạy lại onConnect": gắn lại phiên
    // tmux là idempotent, và đây đúng là lúc người dùng cần lại việc đang chạy.
    ssh.connect(
      sessionId,
      { ...conn, tmux: resolveTmux(connectionId, slot) },
      clampTerminalSize(size),
      sessionHandlers(sessionId),
    );
    return { sessionId, reconnect: true };
  });

  ipcMain.on('ssh:input', (event, sessionId, data) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    try {
      validateId(sessionId, 'Session ID');
      if (typeof data !== 'string' || data.length > 1024 * 1024) return;
      noteActivity();
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
  ipcMain.on('ssh:ack', (event, sessionId, bytes) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const pump = pumps.get(sessionId);
    if (pump) pump.ack(bytes);
  });
  ipcMain.on('vault:activity', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    noteActivity();
  });

  handle('knownHosts:list', () => ssh.knownHosts.list());
  handle('knownHosts:forget', (host) => {
    ssh.knownHosts.forget(String(host));
    return true;
  });

  handle('sftp:list', (sessionId, remotePath) => sftp.list(sessionId, remotePath));
  handle('sftp:mkdir', (sessionId, parentPath, name) => sftp.mkdir(sessionId, parentPath, name));
  handle('sftp:rename', (sessionId, remotePath, newName) => sftp.rename(sessionId, remotePath, newName));
  handle('sftp:chmod', (sessionId, remotePath, mode) => sftp.chmod(sessionId, remotePath, mode));
  handle('sftp:remove', async (sessionId, remotePath, isDirectory) => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Xác nhận xoá remote',
      message: 'Xoá ' + (isDirectory ? 'thư mục' : 'file') + ' này?',
      detail: String(remotePath),
      buttons: ['Huỷ', 'Xoá'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return false;
    return sftp.remove(sessionId, remotePath, isDirectory);
  });
  const uploadOne = async (sessionId, remoteDirectory, localPath) => {
    const remotePath = path.posix.join(String(remoteDirectory), path.basename(localPath));
    const existing = await sftp.stat(sessionId, remotePath);
    let overwrite = false;
    if (existing.exists) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'File remote đã tồn tại',
        message: 'Ghi đè file remote?',
        detail: existing.path,
        buttons: ['Huỷ', 'Ghi đè'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return null;
      overwrite = true;
    }
    return sftp.upload(
      sessionId,
      localPath,
      remoteDirectory,
      (progress) => mainWindow && mainWindow.webContents.send('sftp:progress', progress),
      overwrite,
    );
  };
  handle('sftp:upload', async (sessionId, remoteDirectory) => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn file để upload',
      properties: ['openFile', 'multiSelections'],
    });
    if (picked.canceled || !picked.filePaths.length) return { canceled: true };
    let uploaded = 0;
    for (const localPath of picked.filePaths) {
      const result = await uploadOne(sessionId, remoteDirectory, localPath);
      if (result) uploaded += 1;
    }
    return { canceled: false, uploaded };
  });
  handle('sftp:download', async (sessionId, remotePath) => {
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Lưu file tải xuống',
      defaultPath: path.basename(String(remotePath)),
    });
    if (picked.canceled || !picked.filePath) return { canceled: true };
    const result = await sftp.download(
      sessionId,
      remotePath,
      picked.filePath,
      (progress) => mainWindow && mainWindow.webContents.send('sftp:progress', progress),
    );
    return { canceled: false, ...result };
  });
  handle('sftp:cancel', (transferId) => sftp.cancel(transferId));

  handle('tunnel:list', (sessionId) => ssh.listTunnels(sessionId));
  handle('tunnel:start', (sessionId, config) => ssh.startTunnel(sessionId, config));
  handle('tunnel:stop', (tunnelId) => ssh.stopTunnel(tunnelId));

  handle('log:status', (sessionId) => sessionLogs.has(validateId(sessionId, 'Session ID')));
  handle('log:start', async (sessionId) => {
    validateId(sessionId, 'Session ID');
    if (!ssh.has(sessionId)) throw new Error('Phiên SSH không tồn tại');
    if (sessionLogs.has(sessionId)) return true;
    const warning = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Ghi log phiên SSH',
      message: 'Log terminal có thể chứa mật khẩu, token hoặc dữ liệu nhạy cảm.',
      detail: 'Chỉ bật khi thật sự cần và tự bảo vệ file log sau khi sử dụng.',
      buttons: ['Huỷ', 'Tôi hiểu, chọn file'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (warning.response !== 1) return false;
    const picked = await dialog.showSaveDialog(mainWindow, {
      title: 'Lưu log phiên SSH',
      defaultPath: 'ssh-session-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log',
      filters: [{ name: 'Terminal log', extensions: ['log', 'txt'] }],
    });
    if (picked.canceled || !picked.filePath) return false;
    if (!ssh.has(sessionId)) throw new Error('Phiên SSH đã đóng trong lúc chọn file');
    return sessionLogs.start(sessionId, picked.filePath);
  });
  handle('log:stop', (sessionId) => sessionLogs.stop(validateId(sessionId, 'Session ID')));

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

/**
 * Lưới an toàn cuối cùng. Một lỗi ngoài dự kiến ở main process sẽ giết mọi
 * phiên SSH đang mở mà không để lại dấu vết; ở đây ta ít nhất ghi lại được nó
 * và báo cho người dùng thay vì biến mất lặng lẽ.
 */
function installCrashGuards() {
  process.on('uncaughtException', (err) => {
    if (diagnostics) diagnostics.write('uncaught', err);
    notify('Lỗi nội bộ: ' + safeErrorMessage(err) + '. Các phiên đang mở vẫn giữ nguyên.', 'error');
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (diagnostics) diagnostics.write('unhandled', err);
  });
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
    windowStatePath = path.join(userData, 'window-state.json');
    diagnostics = new DiagnosticLog(path.join(userData, 'diagnostic.log'));
    vault = new Vault(path.join(userData, 'vault.enc'));
    ssh = new SshManager(new KnownHosts(path.join(userData, 'known_hosts.json')), confirmHostKey);
    sftp = new SftpService(ssh);
    sessionLogs = new SessionLogs((sessionId, message) => {
      diagnostics.write('log', message);
      notify('Ghi log phiên đã dừng: ' + message, 'error');
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log:state', sessionId, false);
    });

    installCrashGuards();
    registerIpc();
    buildMenu();
    createWindow();
    startAutoLockWatch();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (sessionLogs) sessionLogs.stopAll();
    if (ssh) ssh.disconnectAll();
    if (vault) vault.lock();
    if (currentPlatform.shouldQuitOnWindowClose()) app.quit();
  });

  app.on('before-quit', () => {
    quitConfirmed = true;
    clearInterval(autoLockTimer);
    if (sessionLogs) sessionLogs.stopAll();
    for (const sessionId of [...pumps.keys()]) disposePump(sessionId);
    if (ssh) ssh.disconnectAll();
    if (vault) vault.lock();
  });
}
