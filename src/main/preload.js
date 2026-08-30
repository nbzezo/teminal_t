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
  },

  connections: {
    list: () => ipcRenderer.invoke('conn:list'),
    save: (conn) => ipcRenderer.invoke('conn:save', conn),
    remove: (id) => ipcRenderer.invoke('conn:delete', id),
  },

  snippets: {
    list: () => ipcRenderer.invoke('snip:list'),
    save: (snippet) => ipcRenderer.invoke('snip:save', snippet),
    remove: (id) => ipcRenderer.invoke('snip:delete', id),
  },

  ssh: {
    open: (sessionId, connectionId, size) =>
      ipcRenderer.invoke('ssh:open', sessionId, connectionId, size),
    input: (sessionId, data) => ipcRenderer.send('ssh:input', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    close: (sessionId) => ipcRenderer.invoke('ssh:close', sessionId),

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

  app: {
    info: () => ipcRenderer.invoke('app:info'),
  },
};

contextBridge.exposeInMainWorld('api', api);
