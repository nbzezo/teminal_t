'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Cầu nối duy nhất giữa renderer và main process.
 * Renderer không bao giờ chạm tới Node, tới file vault hay tới mật khẩu đã lưu:
 * nó chỉ gửi id kết nối, còn bí mật do main process tự tra và dùng.
 */
const api = {
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    init: (password) => ipcRenderer.invoke('vault:init', password),
    unlock: (password) => ipcRenderer.invoke('vault:unlock', password),
    lock: () => ipcRenderer.invoke('vault:lock'),
    changePassword: (oldPw, newPw) => ipcRenderer.invoke('vault:changePassword', oldPw, newPw),
    importSshConfig: () => ipcRenderer.invoke('vault:importSshConfig'),
    settings: () => ipcRenderer.invoke('vault:settings'),
    saveSettings: (settings) => ipcRenderer.invoke('vault:saveSettings', settings),
    exportBackup: (password, options) =>
      ipcRenderer.invoke('vault:exportBackup', password, options),
    importBackup: (password) => ipcRenderer.invoke('vault:importBackup', password),
  },

  connections: {
    list: () => ipcRenderer.invoke('conn:list'),
    save: (conn) => ipcRenderer.invoke('conn:save', conn),
    remove: (id) => ipcRenderer.invoke('conn:delete', id),
    duplicate: (id) => ipcRenderer.invoke('conn:duplicate', id),
    saveTunnel: (connectionId, tunnel) => ipcRenderer.invoke('conn:saveTunnel', connectionId, tunnel),
    deleteTunnel: (connectionId, tunnelId) => ipcRenderer.invoke('conn:deleteTunnel', connectionId, tunnelId),
  },

  snippets: {
    list: () => ipcRenderer.invoke('snip:list'),
    save: (snippet) => ipcRenderer.invoke('snip:save', snippet),
    remove: (id) => ipcRenderer.invoke('snip:delete', id),
  },

  ssh: {
    open: (sessionId, connectionId, size) =>
      ipcRenderer.invoke('ssh:open', sessionId, connectionId, size),
    reconnect: (sessionId, connectionId, size) =>
      ipcRenderer.invoke('ssh:reconnect', sessionId, connectionId, size),
    input: (sessionId, data) => ipcRenderer.send('ssh:input', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    close: (sessionId) => ipcRenderer.invoke('ssh:close', sessionId),
    metrics: (sessionId) => ipcRenderer.invoke('ssh:metrics', sessionId),

    onData: (handler) => {
      const listener = (_event, sessionId, data) => handler(sessionId, data);
      ipcRenderer.on('ssh:data', listener);
      return () => ipcRenderer.removeListener('ssh:data', listener);
    },
    onStatus: (handler) => {
      const listener = (_event, sessionId, status) => handler(sessionId, status);
      ipcRenderer.on('ssh:status', listener);
      return () => ipcRenderer.removeListener('ssh:status', listener);
    },
  },

  dialogs: {
    pickPrivateKey: () => ipcRenderer.invoke('dialog:pickPrivateKey'),
    confirm: (message, detail) => ipcRenderer.invoke('dialog:confirm', message, detail),
  },

  knownHosts: {
    list: () => ipcRenderer.invoke('knownHosts:list'),
    forget: (host) => ipcRenderer.invoke('knownHosts:forget', host),
  },

  sftp: {
    list: (sessionId, remotePath) => ipcRenderer.invoke('sftp:list', sessionId, remotePath),
    mkdir: (sessionId, parentPath, name) => ipcRenderer.invoke('sftp:mkdir', sessionId, parentPath, name),
    rename: (sessionId, remotePath, newName) => ipcRenderer.invoke('sftp:rename', sessionId, remotePath, newName),
    remove: (sessionId, remotePath, isDirectory) => ipcRenderer.invoke('sftp:remove', sessionId, remotePath, isDirectory),
    chmod: (sessionId, remotePath, mode) => ipcRenderer.invoke('sftp:chmod', sessionId, remotePath, mode),
    upload: (sessionId, remoteDirectory) => ipcRenderer.invoke('sftp:upload', sessionId, remoteDirectory),
    download: (sessionId, remotePath) => ipcRenderer.invoke('sftp:download', sessionId, remotePath),
    cancel: (transferId) => ipcRenderer.invoke('sftp:cancel', transferId),
    onProgress: (handler) => {
      const listener = (_event, progress) => handler(progress);
      ipcRenderer.on('sftp:progress', listener);
      return () => ipcRenderer.removeListener('sftp:progress', listener);
    },
  },

  tunnels: {
    list: (sessionId) => ipcRenderer.invoke('tunnel:list', sessionId),
    start: (sessionId, config) => ipcRenderer.invoke('tunnel:start', sessionId, config),
    stop: (tunnelId) => ipcRenderer.invoke('tunnel:stop', tunnelId),
  },

  logs: {
    status: (sessionId) => ipcRenderer.invoke('log:status', sessionId),
    start: (sessionId) => ipcRenderer.invoke('log:start', sessionId),
    stop: (sessionId) => ipcRenderer.invoke('log:stop', sessionId),
  },

  // Cửa sổ không khung: trang tự vẽ nút thu nhỏ / phóng to / đóng
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win:toggleMaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onStateChange: (handler) => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on('win:state', listener);
      return () => ipcRenderer.removeListener('win:state', listener);
    },
  },

  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },

  clipboard: {
    readText: () => ipcRenderer.invoke('clipboard:readText'),
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
    clearIfMatches: (expected) => ipcRenderer.invoke('clipboard:clearIfMatches', expected),
  },
};

contextBridge.exposeInMainWorld('api', api);
