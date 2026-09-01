'use strict';

/* global Terminal, FitAddon, SearchAddon */

import {
  $,
  bridge,
  call,
  state,
  setStatus,
  showError,
  clearError,
  icon,
  openModal,
  askInput,
  showContextMenu,
  connectionById,
  activeSession,
  requireConnectedSession,
  formatBytes,
  formatUptime,
  TERM_THEME,
  TERMINAL_FONTS,
} from './core.js';
import { renderConnections } from './connections.js';
import { openPalette } from './palette.js';

const MAX_PANES = 4;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 28;

const SEARCH_DECORATIONS = {
  matchBackground: '#7a4a34',
  matchBorder: '#e95420',
  matchOverviewRuler: '#e95420',
  activeMatchBackground: '#e95420',
  activeMatchBorder: '#ffffff',
  activeMatchColorOverviewRuler: '#ffffff',
};

/* =========================================================================
 * Workspace và tab
 * ========================================================================= */

function panesOf(workspaceId) {
  return [...state.sessions.entries()].filter(([, session]) => session.workspaceId === workspaceId);
}

/** Tên mặc định của tab: tên máy chủ của pane đầu tiên. */
function defaultWorkspaceName(workspaceId) {
  const panes = panesOf(workspaceId);
  if (panes.length === 0) return 'Workspace';
  const conn = connectionById(panes[0][1].connId);
  return conn ? conn.name : panes[0][1].name;
}

/** Tab chưa được đặt tên riêng thì bám theo pane đầu tiên còn lại. */
function syncWorkspaceName(workspaceId) {
  const workspace = state.workspaces.get(workspaceId);
  if (!workspace || !workspace.autoName) return;
  workspace.name = defaultWorkspaceName(workspaceId);
}

function setWorkspaceLayout(workspaceId, direction) {
  const workspace = state.workspaces.get(workspaceId);
  if (workspace) workspace.layout = direction;
}

/** Số phiên đang mở của một kết nối, dùng để chấm xanh trong danh sách. */
export function liveCount(connId) {
  let n = 0;
  for (const session of state.sessions.values()) {
    if (session.connId === connId && session.status !== 'gone') n += 1;
  }
  return n;
}

/**
 * Ảnh chụp các tab để mở lại ở lần chạy sau. Mỗi tab là một công việc nên phải
 * lưu đủ cả danh sách pane — các pane có thể nằm ở những máy chủ khác nhau và
 * chỉ giữ máy chủ đầu tiên thì lần mở lại sẽ mất phần còn lại của công việc.
 */
function workspaceSnapshot() {
  const tabs = [];
  for (const [workspaceId, workspace] of state.workspaces) {
    const panes = panesOf(workspaceId);
    if (panes.length === 0) continue;
    tabs.push({
      // Tên tự suy ra thì để trống, lần sau tự lấy lại theo pane đầu tiên.
      name: workspace.autoName ? '' : workspace.name || '',
      layout: workspace.layout || 'vertical',
      connections: panes.map(([, session]) => session.connId),
    });
  }
  return tabs;
}

let workspaceSaveTimer = null;

function scheduleWorkspaceSave() {
  clearTimeout(workspaceSaveTimer);
  workspaceSaveTimer = setTimeout(() => {
    call(bridge.vault.saveWorkspace({ tabs: workspaceSnapshot() })).catch(() => {});
  }, 1000);
}

/* =========================================================================
 * Terminal
 * ========================================================================= */

/** Nhận diện URL trong scrollback để click mở được bằng trình duyệt hệ thống. */
function registerLinkProvider(term) {
  if (typeof term.registerLinkProvider !== 'function') return;
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const pattern = /(https?:\/\/|www\.)[^\s"'<>`]+/g;
      const links = [];
      let match = pattern.exec(text);
      while (match) {
        // Dấu câu cuối câu thường không thuộc URL.
        const raw = match[0].replace(/[.,;:!?)\]}>]+$/, '');
        const url = raw.startsWith('http') ? raw : 'https://' + raw;
        links.push({
          range: {
            start: { x: match.index + 1, y: lineNumber },
            end: { x: match.index + raw.length, y: lineNumber },
          },
          text: raw,
          activate: () => window.open(url, '_blank', 'noopener'),
        });
        match = pattern.exec(text);
      }
      callback(links.length ? links : undefined);
    },
  });
}

/**
 * Nối đầu vào xterm với SSH và bù cho trường hợp Chromium/UniKey gửi keyCode
 * 229 + InputEvent(insertText) nhưng xterm 5.x không phát onData. Bộ đếm đảm
 * bảo fallback chỉ chạy nếu xterm chưa tự gửi dữ liệu của chính lần nhấn phím.
 */
export function wireTerminalInput(term, sendInput) {
  let dataSerial = 0;
  let serialBeforeKeydown = null;
  let compositionActive = false;
  let compositionJustEnded = false;

  term.onData((data) => {
    dataSerial += 1;
    sendInput(data);
  });

  if (!term.textarea) return;
  term.textarea.addEventListener(
    'keydown',
    () => {
      serialBeforeKeydown = dataSerial;
    },
    true,
  );
  term.textarea.addEventListener(
    'compositionstart',
    () => {
      compositionActive = true;
      serialBeforeKeydown = null;
    },
    true,
  );
  term.textarea.addEventListener(
    'compositionend',
    () => {
      compositionActive = false;
      compositionJustEnded = true;
      setTimeout(() => {
        compositionJustEnded = false;
      }, 0);
    },
    true,
  );
  term.textarea.addEventListener(
    'input',
    (event) => {
      if (
        compositionActive ||
        compositionJustEnded ||
        event.isComposing ||
        event.inputType !== 'insertText' ||
        !event.data
      ) {
        return;
      }
      const baseline = serialBeforeKeydown ?? dataSerial;
      serialBeforeKeydown = null;
      const text = event.data;
      queueMicrotask(() => {
        if (dataSerial !== baseline) return;
        dataSerial += 1;
        sendInput(text);
      });
    },
    true,
  );
}

/** Lớp phủ trên pane khi phiên đã chết hoặc đang chờ người dùng bấm kết nối. */
function buildPaneOverlay(sessionId) {
  const overlay = document.createElement('div');
  overlay.className = 'pane-overlay';
  overlay.hidden = true;

  const message = document.createElement('p');
  message.className = 'pane-overlay-message';

  const actions = document.createElement('div');
  actions.className = 'pane-overlay-actions';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn btn-suggested';
  retry.appendChild(icon('reconnect', 15));
  retry.append(' Kết nối lại');
  retry.addEventListener('click', () => retrySession(sessionId));

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-flat';
  close.textContent = 'Đóng pane';
  close.addEventListener('click', () => closeSession(sessionId));

  actions.append(retry, close);
  overlay.append(message, actions);
  overlay._message = message;
  overlay._retry = retry;
  return overlay;
}

function setPaneState(session, kind, text) {
  const overlay = session.pane._overlay;
  if (!overlay) return;
  if (!kind) {
    overlay.hidden = true;
    return;
  }
  overlay._message.textContent = text;
  overlay._retry.textContent = '';
  overlay._retry.appendChild(icon('reconnect', 15));
  overlay._retry.append(kind === 'idle' ? ' Kết nối' : ' Kết nối lại');
  overlay.hidden = false;
}

/* =========================================================================
 * Phiên bền (tmux)
 * ========================================================================= */

/**
 * Số thứ tự tab của một máy chủ — chỗ trống nhỏ nhất, nên tên phiên đặc và đoán
 * được: đóng tab 2 rồi mở lại thì nó vẫn là tab 2 và gắn lại đúng việc cũ.
 *
 * Một tab là một công việc và có thể chứa pane của nhiều máy chủ khác nhau, nên
 * số này phải tính riêng cho từng máy chủ. Một số dùng chung cho cả tab sẽ làm
 * hai tab khác nhau trùng tên phiên trên cùng một máy chủ.
 */
function tabIndexFor(workspaceId, connId) {
  const workspace = state.workspaces.get(workspaceId);
  if (!workspace) return 1;
  if (!workspace.tabIndexByConn) workspace.tabIndexByConn = {};
  if (workspace.tabIndexByConn[connId]) return workspace.tabIndexByConn[connId];
  const used = new Set();
  for (const [id, other] of state.workspaces) {
    if (id === workspaceId) continue;
    const index = other.tabIndexByConn && other.tabIndexByConn[connId];
    if (index) used.add(index);
  }
  let index = 1;
  while (used.has(index)) index += 1;
  // Giữ lại cả khi pane cuối của máy chủ đó rời tab: mở lại trong đúng tab này
  // thì vẫn gắn về đúng phiên cũ.
  workspace.tabIndexByConn[connId] = index;
  return index;
}

/** Số pane cũng đếm riêng theo máy chủ, cùng lý do với số tab. */
function nextPaneIndex(workspaceId, connId) {
  const used = new Set(
    panesOf(workspaceId)
      .filter(([, session]) => session.connId === connId)
      .map(([, session]) => session.paneIndex),
  );
  let index = 1;
  while (used.has(index)) index += 1;
  return index;
}

/** Vị trí gửi sang main process để nó dựng tên phiên tmux. Chỉ gồm số. */
function slotOf(session) {
  return {
    tabIndex: tabIndexFor(session.workspaceId, session.connId),
    paneIndex: session.paneIndex || 1,
  };
}

/**
 * Dải gợi ý nổi ở đáy pane, với nút thật.
 *
 * Không vẽ nút bằng chữ trong terminal: tmux chạy trên alternate screen và xoá
 * sạch mọi thứ app tự ghi vào đó ở lần vẽ lại kế tiếp. Và banner phải là
 * `position: absolute` — chiếm chỗ theo chiều dọc thì FitAddon co terminal lại,
 * tmux nhận resize rồi vẽ lại toàn màn hình chỉ vì một lời gợi ý.
 */
function showPaneBanner(session, text, actions) {
  hidePaneBanner(session);
  const banner = document.createElement('div');
  banner.className = 'pane-banner';

  const message = document.createElement('span');
  message.className = 'pane-banner-text';
  message.textContent = text;
  banner.appendChild(message);

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm' + (action.suggested ? ' btn-suggested' : ' btn-flat');
    button.textContent = action.label;
    // Bấm nút không được kéo con trỏ ra khỏi terminal.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => {
      hidePaneBanner(session);
      action.onClick();
      session.term.focus();
    });
    banner.appendChild(button);
  }

  session.pane.appendChild(banner);
  session.banner = banner;
  session.bannerTimer = setTimeout(() => hidePaneBanner(session), 30000);
}

function hidePaneBanner(session) {
  clearTimeout(session.bannerTimer);
  session.bannerTimer = null;
  if (session.banner) {
    session.banner.remove();
    session.banner = null;
  }
}

/**
 * Tên phiên tmux hiện ở thanh tiêu đề, không phải trên pane.
 *
 * Bản đầu vẽ nó thành chip nổi ở góc pane và chip đó **che mất chữ của
 * terminal** — thấy rõ nhất ở pane hẹp sau khi chia đôi. Không có chỗ nào trên
 * mặt terminal là chỗ trống an toàn: mọi ô đều có thể có nội dung.
 */
function setPaneBadge(session, name, attached) {
  session.tmuxAttached = Boolean(attached);
  if (!name) session.tmuxName = '';
  renderHeader();
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 90) return 'vừa xong';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return minutes + ' phút trước';
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours + ' giờ trước';
  return Math.round(hours / 24) + ' ngày trước';
}

/**
 * Bảng "Phiên trên máy chủ". Bật phiên bền nghĩa là việc tích tụ vô hình trên
 * máy chủ; đây là chỗ nhìn thấy và dọn nó.
 */
export async function openTmuxSessions(sessionId) {
  const session = state.sessions.get(sessionId || state.activeSessionId);
  if (!session || session.status !== 'connected') {
    return setStatus('Cần một phiên đang kết nối để xem phiên trên máy chủ.', 'error');
  }
  openModal('tmux-modal');
  $('tmux-subtitle').textContent = session.name;
  await refreshTmuxSessions(session.id);
}

async function refreshTmuxSessions(sessionId) {
  const list = $('tmux-list');
  const empty = $('tmux-empty');
  list.textContent = '';
  empty.hidden = true;
  $('tmux-loading').hidden = false;

  let result;
  try {
    result = await call(bridge.ssh.tmuxList(sessionId));
  } catch (err) {
    $('tmux-loading').hidden = true;
    empty.hidden = false;
    empty.textContent = err.message;
    return;
  }
  $('tmux-loading').hidden = true;

  if (!result.available) {
    empty.hidden = false;
    empty.textContent = 'Máy chủ này chưa cài tmux.';
    return;
  }
  if (result.sessions.length === 0) {
    empty.hidden = false;
    empty.textContent = 'Không có phiên nào đang chạy trên máy chủ.';
    return;
  }

  // Phiên đang rời lên trước: đó là thứ người ta vào đây để tìm.
  const rows = [...result.sessions].sort((a, b) => Number(a.attached) - Number(b.attached));
  for (const item of rows) {
    const row = document.createElement('div');
    row.className = 'tmux-row';

    const main = document.createElement('div');
    main.className = 'tmux-row-main';
    const name = document.createElement('span');
    name.className = 'tmux-row-name';
    name.textContent = item.name;
    const meta = document.createElement('span');
    meta.className = 'dim tmux-row-meta';
    meta.textContent =
      (item.attached ? 'Đang gắn' : 'Đang rời') +
      ' · ' +
      item.windows +
      ' cửa sổ · ' +
      relativeTime(item.createdAt) +
      (item.owned ? '' : ' · tạo bằng tay');
    main.append(name, meta);

    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'btn btn-sm btn-destructive';
    kill.textContent = 'Kết thúc';
    kill.addEventListener('click', async () => {
      try {
        await call(bridge.ssh.tmuxKill(sessionId, item.name));
        setStatus('Đã kết thúc phiên ' + item.name, 'ok');
        await refreshTmuxSessions(sessionId);
      } catch (err) {
        setStatus(err.message, 'error');
      }
    });

    row.append(main, kill);
    list.appendChild(row);
  }
}

/* =========================================================================
 * Mở, kích hoạt và đóng phiên
 * ========================================================================= */

/**
 * Mở một pane. Không có `share` thì pane là một kết nối SSH độc lập của riêng
 * nó, kể cả khi trùng máy chủ với pane bên cạnh; `share` thì xin thêm shell
 * trên chính kết nối của `sourceSessionId`.
 * @param {string} connId
 * @param {{workspaceId?: string, direction?: string, share?: boolean,
 *          sourceSessionId?: string, idle?: boolean}} [options]
 */
export async function openSession(connId, options = {}) {
  const conn = connectionById(connId);
  if (!conn) return null;

  const sessionId = crypto.randomUUID();
  const workspaceId = options.workspaceId || sessionId;

  const pane = document.createElement('div');
  pane.className = 'term-pane';
  const overlay = buildPaneOverlay(sessionId);
  pane._overlay = overlay;
  // Các pane trong một tab có thể ở những máy chủ khác nhau, nên mỗi pane phải
  // tự nói mình đang ở đâu; thanh tiêu đề chỉ nói về pane đang focus.
  const paneLabel = document.createElement('span');
  paneLabel.className = 'pane-label';
  pane._label = paneLabel;
  $('terminals').appendChild(pane);

  const term = new Terminal({
    theme: { ...TERM_THEME, background: state.settings.terminalBackground || TERM_THEME.background },
    fontFamily: TERMINAL_FONTS[state.settings.terminalFontFamily] || TERMINAL_FONTS['ubuntu-mono'],
    fontSize: state.settings.terminalFontSize || 14,
    lineHeight: 1.1,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  const search = new SearchAddon.SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.open(pane);
  pane.appendChild(overlay);
  pane.appendChild(paneLabel);
  // xterm nhận văn bản từ textarea ẩn này. Nhường composition hoàn toàn cho
  // UniKey/Windows IME và không để trình duyệt tự sửa văn bản đầu vào.
  if (term.textarea) {
    term.textarea.lang = 'vi';
    term.textarea.spellcheck = false;
    term.textarea.setAttribute('autocapitalize', 'off');
    term.textarea.setAttribute('autocomplete', 'off');
    term.textarea.setAttribute('autocorrect', 'off');
  }
  fit.fit();

  registerLinkProvider(term);
  wireTerminalInput(term, (data) => bridge.ssh.input(sessionId, data));
  term.onResize(({ cols, rows }) => bridge.ssh.resize(sessionId, cols, rows));
  term.onSelectionChange(() => {
    if (!state.settings.copyOnSelect || !term.hasSelection()) return;
    const text = term.getSelection();
    if (text) call(bridge.clipboard.writeText(text)).catch(() => {});
  });

  const paneIndex = options.paneIndex || nextPaneIndex(workspaceId, connId);
  const session = {
    id: sessionId,
    connId,
    name: conn.name,
    paneIndex,
    term,
    fit,
    search,
    pane,
    status: options.idle ? 'idle' : 'connecting',
    manualClose: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    workspaceId,
    logging: false,
    searchQuery: '',
  };
  state.sessions.set(sessionId, session);
  if (!state.workspaces.has(workspaceId)) {
    // Tab là một workspace — một công việc — chứ không thuộc về máy chủ nào.
    // Tên chỉ mượn máy chủ đầu tiên cho tới khi người dùng đặt tên khác.
    state.workspaces.set(workspaceId, {
      layout: options.direction || 'vertical',
      activeSessionId: sessionId,
      name: conn.name,
      autoName: true,
      // Số tab dùng để đặt tên phiên tmux, tính riêng cho từng máy chủ vì một
      // tab có thể chứa pane của nhiều máy. Xem tabIndexFor.
      tabIndexByConn: {},
    });
  } else if (options.direction) {
    state.workspaces.get(workspaceId).layout = options.direction;
  }

  pane.addEventListener('mousedown', () => {
    if (state.activeSessionId !== sessionId) activateSession(sessionId);
  });
  pane.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    activateSession(sessionId);
    openTerminalMenu(event, sessionId);
  });

  if (typeof search.onDidChangeResults === 'function') {
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (state.activeSessionId !== sessionId) return;
      $('term-search-count').textContent =
        resultCount > 0 ? resultIndex + 1 + '/' + resultCount : session.searchQuery ? 'không có' : '';
    });
  }

  activateSession(sessionId);
  renderTabs();
  renderConnections();
  scheduleWorkspaceSave();

  if (options.idle) {
    setPaneState(session, 'idle', conn.name + ' — tab được mở lại từ phiên trước, chưa kết nối.');
    return sessionId;
  }

  term.writeln('\x1b[90mĐang kết nối tới ' + conn.username + '@' + conn.host + '…\x1b[0m');

  try {
    const slot = slotOf(session);
    if (options.share && options.sourceSessionId) {
      await call(
        bridge.ssh.split(sessionId, options.sourceSessionId, { cols: term.cols, rows: term.rows }, connId, slot),
      );
    } else {
      // Kết nối riêng: đi trọn đường ssh:open nên host key, cảnh báo Production
      // và xác nhận lệnh tự động đều được hỏi lại cho đúng pane này.
      await call(bridge.ssh.open(sessionId, connId, { cols: term.cols, rows: term.rows }, slot));
    }
  } catch (err) {
    session.status = 'gone';
    term.writeln('\r\n\x1b[31m✗ ' + err.message + '\x1b[0m');
    setPaneState(session, 'dead', err.message);
    setStatus(err.message, 'error');
    renderTabs();
  }
  return sessionId;
}

/** Đóng pane chết rồi mở lại đúng chỗ đó, đi qua đủ các bước xác nhận. */
async function retrySession(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  const { connId, workspaceId, paneIndex } = session;
  const workspace = state.workspaces.get(workspaceId);
  const direction = workspace ? workspace.layout : 'vertical';
  closeSession(sessionId, true);
  // Giữ nguyên vị trí: đổi số pane là gắn vào một phiên tmux khác. Số tab nằm
  // trong workspace nên tự nó đã đúng.
  await openSession(connId, { workspaceId, direction, paneIndex });
}

function activateSession(sessionId) {
  const selected = state.sessions.get(sessionId);
  if (!selected) return;
  state.activeSessionId = sessionId;
  const workspace = state.workspaces.get(selected.workspaceId);
  if (workspace) workspace.activeSessionId = sessionId;

  const visible = [];
  for (const [id, session] of state.sessions) {
    session.pane.hidden = session.workspaceId !== selected.workspaceId;
    session.pane.classList.toggle('active-pane', id === sessionId);
    if (!session.pane.hidden) visible.push(session);
  }
  const terminals = $('terminals');
  const direction = (workspace && workspace.layout) || 'vertical';
  terminals.className = 'terminals split-' + Math.min(MAX_PANES, visible.length) + ' split-' + direction;
  $('empty-state').hidden = state.sessions.size > 0;

  // Chờ trình duyệt vẽ xong grid rồi mới đo từng PTY.
  requestAnimationFrame(() => {
    for (const session of visible) session.fit.fit();
    if (selected.status === 'connected') selected.term.focus();
  });
  closeSearchBar();
  renderTabs();
}

function activateWorkspace(workspaceId) {
  const workspace = state.workspaces.get(workspaceId);
  const panes = panesOf(workspaceId);
  if (panes.length === 0) return;
  const target = workspace && state.sessions.has(workspace.activeSessionId) ? workspace.activeSessionId : panes[0][0];
  activateSession(target);
}

export function closeSession(sessionId, silent) {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  session.manualClose = true;
  clearTimeout(session.reconnectTimer);
  hidePaneBanner(session);
  if (!silent) noteDetach(session);
  bridge.ssh.close(sessionId);
  session.term.dispose();
  session.pane.remove();
  state.sessions.delete(sessionId);

  const remaining = panesOf(session.workspaceId);
  if (remaining.length === 0) state.workspaces.delete(session.workspaceId);
  else syncWorkspaceName(session.workspaceId);

  if (state.activeSessionId === sessionId) {
    const next = (remaining[0] || [...state.sessions.entries()][0] || [null])[0];
    state.activeSessionId = next;
    if (next) activateSession(next);
    else {
      $('terminals').className = 'terminals';
      $('empty-state').hidden = false;
    }
  } else {
    const active = state.sessions.get(state.activeSessionId);
    if (active && active.workspaceId === session.workspaceId) activateSession(state.activeSessionId);
  }
  $('empty-state').hidden = state.sessions.size > 0;
  if (!silent) {
    renderTabs();
    renderConnections();
    scheduleWorkspaceSave();
  }
}

/** Đóng mọi pane của một tab. */
function closeWorkspace(workspaceId) {
  for (const [id] of panesOf(workspaceId)) closeSession(id, true);
  renderTabs();
  renderConnections();
  scheduleWorkspaceSave();
}

export function closeActiveWorkspace() {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return;
  closeWorkspace(session.workspaceId);
}

/** Đổi tên tab theo công việc nó đang làm, không theo máy chủ. */
async function renameWorkspace(workspaceId) {
  const workspace = state.workspaces.get(workspaceId);
  if (!workspace) return;
  const answer = await askInput({
    title: 'Đổi tên tab',
    label: 'Tên công việc',
    value: workspace.name || '',
    placeholder: 'Ví dụ: Deploy hotfix',
    hint: 'Bỏ trống để quay lại lấy tên theo máy chủ của pane đầu tiên.',
    confirmLabel: 'Đổi tên',
  });
  if (answer === null) return;
  const name = answer.trim().slice(0, 60);
  workspace.autoName = !name;
  workspace.name = name || defaultWorkspaceName(workspaceId);
  renderTabs();
  scheduleWorkspaceSave();
}

/* =========================================================================
 * Thanh tab
 * ========================================================================= */

/** Cập nhật tiêu đề thanh trên theo phiên đang xem. */
function renderHeader() {
  const session = state.sessions.get(state.activeSessionId);
  const conn = session && connectionById(session.connId);
  if (session && conn) {
    $('hb-title').textContent = conn.name;
    const endpoint = conn.username + '@' + conn.host + (conn.port !== 22 ? ':' + conn.port : '');
    $('hb-subtitle').textContent = session.tmuxName ? endpoint + ' · ' + session.tmuxName : endpoint;
    // Vừa gắn lại việc cũ hay vừa mở phiên mới — hai trường hợp nhìn giống hệt
    // nhau trên màn hình, nên phải nói ra.
    $('hb-subtitle').title = session.tmuxName
      ? (session.tmuxAttached ? 'Đã gắn lại phiên đang chạy' : 'Phiên bền mới trên máy chủ') + ': ' + session.tmuxName
      : '';
  } else {
    $('hb-title').textContent = 'SSH Manager';
    $('hb-subtitle').textContent = state.sessions.size
      ? state.sessions.size + ' phiên đang mở'
      : 'Chưa có phiên nào';
  }
  const connected = Boolean(session && session.status === 'connected');
  // Mọi nút cần một phiên đã kết nối đều phải mờ đi cùng lúc, không để ba nút
  // vẫn sáng rồi chỉ trả về một toast lỗi khi bấm.
  for (const id of [
    'btn-terminal-copy',
    'btn-terminal-paste',
    'btn-dashboard',
    'btn-tmux',
    'btn-sftp',
    'btn-tunnels',
    'btn-session-log',
  ]) {
    $(id).disabled = !connected;
  }
  // Pane mới là kết nối độc lập nên không phụ thuộc pane hiện tại còn sống hay
  // không; chỉ cần đang có một tab để đặt nó vào.
  for (const id of ['btn-split-v', 'btn-split-h']) $(id).disabled = !session;
  const logButton = $('btn-session-log');
  const logging = Boolean(session && session.logging);
  logButton.classList.toggle('recording', logging);
  logButton.setAttribute('aria-pressed', logging ? 'true' : 'false');
  logButton.title = logging ? 'Đang ghi log phiên — bấm để dừng' : 'Bật ghi log phiên';
}

/** Mỗi pane tự khai máy chủ của nó; tên kết nối có thể đổi nên vẽ lại theo tab. */
function renderPaneLabels() {
  for (const session of state.sessions.values()) {
    if (!session.pane._label) continue;
    const conn = connectionById(session.connId);
    session.pane._label.textContent = conn
      ? conn.name + ' · ' + conn.username + '@' + conn.host
      : session.name;
  }
}

/** Tooltip của tab liệt kê máy chủ từng pane — tab trộn nhiều máy rất cần. */
function paneSummary(panes) {
  return panes
    .map(([, session]) => {
      const conn = connectionById(session.connId);
      return conn ? conn.name + ' — ' + conn.username + '@' + conn.host : session.name;
    })
    .join('\n');
}

export function renderTabs() {
  const bar = $('tabbar');
  bar.textContent = '';
  bar.setAttribute('role', 'tablist');

  for (const [workspaceId, workspace] of state.workspaces) {
    const panes = panesOf(workspaceId);
    if (panes.length === 0) continue;
    // Tab chưa đặt tên riêng thì theo kịp cả khi kết nối được đổi tên.
    syncWorkspaceName(workspaceId);
    const activeInWorkspace = panes.some(([id]) => id === state.activeSessionId);
    const anyConnected = panes.some(([, session]) => session.status === 'connected');
    const allDead = panes.every(([, session]) => session.status === 'gone');

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', activeInWorkspace ? 'true' : 'false');
    tab.tabIndex = activeInWorkspace ? 0 : -1;
    if (activeInWorkspace) tab.classList.add('active');
    if (anyConnected) tab.classList.add('connected');
    if (allDead) tab.classList.add('dead');

    const dot = document.createElement('span');
    dot.className = 'tab-dot';
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = (workspace.name || 'Workspace') + (panes.length > 1 ? ' · ' + panes.length + ' pane' : '');
    tab.title = paneSummary(panes) + '\n\nBấm đúp để đổi tên tab';

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.setAttribute('role', 'button');
    close.tabIndex = -1;
    close.appendChild(icon('close', 13));
    close.title = 'Đóng tab (Ctrl+W)';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeWorkspace(workspaceId);
    });

    tab.append(dot, label, close);
    tab.addEventListener('click', () => activateWorkspace(workspaceId));
    tab.addEventListener('dblclick', (event) => {
      event.preventDefault();
      renameWorkspace(workspaceId);
    });
    tab.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu({ x: event.clientX, y: event.clientY }, [
        { label: 'Đổi tên tab…', action: () => renameWorkspace(workspaceId) },
        { separator: true },
        { label: 'Đóng tab', action: () => closeWorkspace(workspaceId), destructive: true },
      ]);
    });
    tab.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const tabs = [...bar.querySelectorAll('.tab')];
      const index = tabs.indexOf(tab);
      const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      if (next) next.focus();
    });
    bar.appendChild(tab);
  }
  renderPaneLabels();
  renderHeader();
}

/* =========================================================================
 * Sự kiện từ main process
 * ========================================================================= */

export function initSessionEvents() {
  bridge.ssh.onData((sessionId, data) => {
    const session = state.sessions.get(sessionId);
    if (!session) return;
    // Báo lại số byte đã vẽ xong; main dùng con số này để biết khi nào phải
    // phanh dòng dữ liệu từ máy chủ.
    session.term.write(data, () => bridge.ssh.ack(sessionId, data.length));
  });

  bridge.ssh.onStatus((sessionId, status) => {
    const session = state.sessions.get(sessionId);
    if (!session) return;

    if (status.state === 'tmux') {
      // Tên phiên tới trước khi channel mở, nên badge sẵn sàng ngay khi có chữ.
      session.tmuxName = status.message;
      setPaneBadge(session, status.message, status.attached);
      // tmux sẽ vẽ lại toàn màn hình; dọn nền trước để nó không vẽ đè lên nội
      // dung cũ cùng mấy dòng thông báo kết nối lại.
      session.term.clear();
      return;
    }
    if (status.state === 'notice') {
      session.tmuxName = '';
      setPaneBadge(session, '');
      session.term.writeln('\r\n\x1b[33m— ' + status.message + ' —\x1b[0m');
      return;
    }

    if (status.state === 'connected') {
      session.status = 'connected';
      session.reconnectAttempts = 0;
      session.reconnectStartedAt = 0;
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
      setPaneState(session, null);
      setStatus(status.message, 'ok');
      if (state.activeSessionId === sessionId) requestAnimationFrame(() => session.fit.fit());
      offerPersistence(sessionId);
    } else if (status.state === 'error') {
      session.status = 'gone';
      session.logging = false;
      if (!session.tmuxName) session.lostWork = true;
      session.term.writeln('\r\n\x1b[31m✗ ' + status.message + '\x1b[0m');
      setPaneState(session, 'dead', status.message);
      setStatus(status.message, 'error');
      scheduleReconnect(sessionId);
    } else if (status.state === 'closed' || status.state === 'ended') {
      session.status = 'gone';
      session.logging = false;
      if (!session.tmuxName && !session.manualClose) session.lostWork = true;
      session.term.writeln('\r\n\x1b[90m— ' + status.message + ' —\x1b[0m');
      setPaneState(session, 'dead', status.message);
      setStatus(status.message);
      scheduleReconnect(sessionId);
    } else if (status.state === 'connecting') {
      setStatus(status.message);
    }
    renderTabs();
    renderConnections();
  });

  bridge.logs.onState((sessionId, active) => {
    const session = state.sessions.get(sessionId);
    if (!session) return;
    session.logging = Boolean(active);
    renderHeader();
  });

  // Đổi mạng xong thì gắn lại ngay, không bắt người dùng chờ hết backoff.
  window.addEventListener('online', () => {
    for (const [sessionId, session] of state.sessions) {
      if (session.status !== 'gone' || !session.reconnectTimer) continue;
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
      session.reconnectAttempts = 0;
      scheduleReconnect(sessionId);
    }
  });
}

/** Phiên bền đang bật cho máy chủ này hay không, tính cả mặc định chung. */
function persistenceOn(conn) {
  if (!conn) return false;
  return conn.persistentSession ? conn.persistentSession === 'on' : Boolean(state.settings.persistentSessionDefault);
}

/** Máy chủ nào người dùng đã hai lần từ chối thì thôi không mời nữa. */
const declinedPersistence = new Map();

// Không có phiên bền thì kết nối lại chỉ để lấy một shell trắng, nên thử ba lần
// rồi thôi. Có phiên bền thì gắn lại là idempotent và việc vẫn nằm nguyên trên
// máy chủ, nên kiên nhẫn hơn hẳn — đủ cho một lần đóng nắp laptop.
const BACKOFF_PLAIN = [1000, 2000, 4000];
const BACKOFF_PERSISTENT = [1000, 2000, 4000, 8000, 15000, 30000];
const PERSISTENT_RETRY_WINDOW_MS = 10 * 60 * 1000;

let detachHintsLeft = 3;

/**
 * Đóng pane khi có phiên bền là *rời phiên*, không phải kết thúc. Nói ba lần đầu
 * rồi thôi — đủ để học ngữ nghĩa mới mà không bị nhắc lại mãi.
 *
 * Nút chỉ mời được khi còn một pane khác trên cùng máy chủ để chạy lệnh; đóng
 * pane cuối là mất luôn kết nối SSH, không còn đường nào gửi `kill-session`.
 */
function noteDetach(session) {
  if (!session.tmuxName || detachHintsLeft <= 0) return;
  detachHintsLeft -= 1;
  const sibling = [...state.sessions].find(
    ([id, other]) => id !== session.id && other.connId === session.connId && other.status === 'connected',
  );
  const text = 'Phiên ' + session.tmuxName + ' vẫn chạy trên máy chủ.';
  if (sibling) setStatus(text, null, { label: 'Xem phiên', onClick: () => openTmuxSessions(sibling[0]) });
  else setStatus(text);
}

/** Mời bật phiên bền đúng lúc người dùng vừa mất việc — và chỉ lúc đó. */
function offerPersistence(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session || !session.lostWork) return;
  session.lostWork = false;
  const conn = connectionById(session.connId);
  if (!conn || persistenceOn(conn) || (declinedPersistence.get(conn.id) || 0) >= 2) return;

  showPaneBanner(session, 'Việc đang chạy đã mất khi rớt kết nối. Bật phiên bền cho ' + conn.name + '?', [
    {
      label: 'Bật',
      suggested: true,
      onClick: async () => {
        try {
          await call(bridge.connections.setPersistent(conn.id, 'on'));
          await renderConnections();
          setStatus('Đã bật phiên bền cho ' + conn.name + '.', 'ok');
        } catch (err) {
          setStatus(err.message, 'error');
        }
      },
    },
    {
      label: 'Bỏ qua',
      onClick: () => declinedPersistence.set(conn.id, (declinedPersistence.get(conn.id) || 0) + 1),
    },
  ]);
}

function scheduleReconnect(sessionId) {
  const session = state.sessions.get(sessionId);
  const conn = session && connectionById(session.connId);
  if (!session || !conn || !conn.autoReconnect || session.manualClose || session.reconnectTimer) return;

  const persistent = persistenceOn(conn);
  const backoff = persistent ? BACKOFF_PERSISTENT : BACKOFF_PLAIN;
  if (!session.reconnectStartedAt) session.reconnectStartedAt = Date.now();
  const exhausted = persistent
    ? Date.now() - session.reconnectStartedAt >= PERSISTENT_RETRY_WINDOW_MS
    : session.reconnectAttempts >= backoff.length;
  if (exhausted) {
    setStatus('Đã dừng tự kết nối lại.', 'error');
    return;
  }

  const delay = backoff[Math.min(session.reconnectAttempts, backoff.length - 1)];
  session.reconnectAttempts += 1;
  session.term.writeln(
    '\r\n\x1b[33m— Kết nối lại lần ' + session.reconnectAttempts + ' sau ' + delay / 1000 + ' giây —\x1b[0m',
  );
  session.reconnectTimer = setTimeout(async () => {
    session.reconnectTimer = null;
    if (session.manualClose || !state.sessions.has(sessionId)) return;
    session.status = 'connecting';
    setPaneState(session, null);
    renderTabs();
    try {
      await call(
        bridge.ssh.reconnect(
          sessionId,
          session.connId,
          { cols: session.term.cols, rows: session.term.rows },
          slotOf(session),
        ),
      );
    } catch (err) {
      session.status = 'gone';
      session.term.writeln('\r\n\x1b[31m✗ ' + err.message + '\x1b[0m');
      setPaneState(session, 'dead', err.message);
      scheduleReconnect(sessionId);
    }
  }, delay);
}

/* =========================================================================
 * Chia pane
 * ========================================================================= */

/**
 * Thêm pane vào tab đang xem. Mặc định pane mới là một kết nối SSH riêng — có
 * thể tới máy chủ khác — nên nó tự bắt tay, tự xác minh host key và chết một
 * mình khi rớt mạng. `share` giữ lối cũ: thêm shell trên chính kết nối của
 * pane hiện tại, nhanh và không hỏi lại, đổi lại cả nhóm chết cùng nhau.
 * @param {'vertical'|'horizontal'} direction
 * @param {{share?: boolean, connId?: string}} [options]
 */
export async function splitActiveSession(direction, options = {}) {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return setStatus('Chưa có tab nào để thêm pane.', 'error');
  const workspaceId = session.workspaceId;
  if (panesOf(workspaceId).length >= MAX_PANES) {
    return setStatus('Mỗi workspace hỗ trợ tối đa ' + MAX_PANES + ' pane.', 'error');
  }

  if (options.share) {
    if (session.status !== 'connected') {
      return setStatus('Pane dùng chung cần pane hiện tại đang kết nối.', 'error');
    }
    setWorkspaceLayout(workspaceId, direction);
    return openSession(session.connId, {
      workspaceId,
      direction,
      share: true,
      sourceSessionId: state.activeSessionId,
    });
  }

  const connId = options.connId || session.connId;
  if (!connectionById(connId)) return setStatus('Kết nối không còn tồn tại.', 'error');
  setWorkspaceLayout(workspaceId, direction);
  return openSession(connId, { workspaceId, direction });
}

/** Nhân bản pane hiện tại trên chính kết nối SSH đang mở, không xác thực lại. */
export function duplicateActivePane() {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return setStatus('Chưa có pane nào để nhân bản.', 'error');
  const workspace = state.workspaces.get(session.workspaceId);
  return splitActiveSession((workspace && workspace.layout) || 'vertical', { share: true });
}

/** Mở một máy chủ thành pane trong tab đang xem; chưa có tab nào thì mở tab mới. */
export function openConnectionAsPane(connId) {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return openSession(connId);
  const workspace = state.workspaces.get(session.workspaceId);
  return splitActiveSession((workspace && workspace.layout) || 'vertical', { connId });
}

export function focusPane(index) {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return;
  const panes = panesOf(session.workspaceId);
  const target = panes[index];
  if (target) activateSession(target[0]);
}

export function activateWorkspaceByIndex(index) {
  const ids = [...state.workspaces.keys()].filter((id) => panesOf(id).length > 0);
  if (ids[index]) activateWorkspace(ids[index]);
}

export function cycleWorkspace(delta) {
  const ids = [...state.workspaces.keys()].filter((id) => panesOf(id).length > 0);
  if (ids.length < 2) return;
  const session = state.sessions.get(state.activeSessionId);
  const current = session ? ids.indexOf(session.workspaceId) : -1;
  const next = (current + delta + ids.length) % ids.length;
  activateWorkspace(ids[next]);
}

/* =========================================================================
 * Clipboard và cỡ chữ
 * ========================================================================= */

export async function copyTerminalSelection() {
  const session = requireConnectedSession();
  if (!session) return;
  if (!session.term.hasSelection()) return setStatus('Hãy chọn nội dung trong terminal trước khi copy.', 'error');
  const copied = session.term.getSelection();
  try {
    await call(bridge.clipboard.writeText(copied));
    const clearAfter = Number(state.settings.clipboardClearSeconds) || 0;
    if (clearAfter > 0) {
      setTimeout(() => call(bridge.clipboard.clearIfMatches(copied)).catch(() => {}), clearAfter * 1000);
    }
    setStatus('Đã copy ' + [...copied].length + ' ký tự Unicode.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

export async function pasteTerminalClipboard() {
  const session = requireConnectedSession();
  if (!session) return;
  try {
    const text = await call(bridge.clipboard.readText());
    if (!text) return setStatus('Clipboard đang trống.', undefined);
    // xterm.paste giữ đúng UTF-8 và tự bọc bracketed-paste khi ứng dụng remote yêu cầu.
    session.term.paste(text);
    session.term.focus();
    setStatus('Đã paste ' + [...text].length + ' ký tự Unicode.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

/** Ctrl +/- đổi cỡ chữ mọi terminal và ghi lại vào cài đặt. */
export async function zoomTerminal(delta) {
  const current = Number(state.settings.terminalFontSize) || 14;
  const size = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + delta));
  if (size === current) return;
  applyTerminalAppearance({ ...state.settings, terminalFontSize: size });
  try {
    state.settings = await call(bridge.vault.saveSettings({ ...state.settings, terminalFontSize: size }));
  } catch (err) {
    setStatus(err.message, 'error');
  }
  setStatus('Cỡ chữ terminal: ' + size, 'ok');
}

/** Áp font, cỡ chữ và màu nền cho mọi terminal đang mở. */
export function applyTerminalAppearance(settings) {
  state.settings = { ...state.settings, ...settings };
  for (const session of state.sessions.values()) {
    session.term.options.fontFamily =
      TERMINAL_FONTS[state.settings.terminalFontFamily] || TERMINAL_FONTS['ubuntu-mono'];
    session.term.options.fontSize = state.settings.terminalFontSize;
    session.term.options.theme = { ...TERM_THEME, background: state.settings.terminalBackground };
    session.fit.fit();
  }
}

function openTerminalMenu(event, sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  const hasSelection = session.term.hasSelection();
  showContextMenu(
    { x: event.clientX, y: event.clientY },
    [
      { label: 'Sao chép', action: copyTerminalSelection, disabled: !hasSelection },
      { label: 'Dán', action: pasteTerminalClipboard, disabled: session.status !== 'connected' },
      { separator: true },
      { label: 'Tìm trong terminal', action: openSearchBar, disabled: session.status !== 'connected' },
      { label: 'Chọn tất cả', action: () => session.term.selectAll() },
      { separator: true },
      { label: 'Chia dọc — kết nối riêng', action: () => splitActiveSession('vertical') },
      { label: 'Chia ngang — kết nối riêng', action: () => splitActiveSession('horizontal') },
      { label: 'Chia với máy chủ khác…', action: () => openPalette({ mode: 'pane' }) },
      {
        label: 'Nhân bản trên cùng kết nối',
        action: duplicateActivePane,
        disabled: session.status !== 'connected',
      },
      { separator: true },
      {
        label: 'Phiên trên máy chủ…',
        action: () => openTmuxSessions(sessionId),
        disabled: session.status !== 'connected',
      },
      {
        label: 'Kết thúc phiên trên máy chủ',
        action: () => killOwnTmuxSession(sessionId),
        disabled: session.status !== 'connected' || !session.tmuxName,
        destructive: true,
      },
      { separator: true },
      { label: 'Đóng pane', action: () => closeSession(sessionId), destructive: true },
    ],
  );
}

/** Kết thúc hẳn phiên tmux của chính pane này, rồi đóng pane. */
async function killOwnTmuxSession(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session || !session.tmuxName) return;
  try {
    await call(bridge.ssh.tmuxKill(sessionId, session.tmuxName));
    session.tmuxName = '';
    setStatus('Đã kết thúc phiên trên máy chủ.', 'ok');
    closeSession(sessionId);
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

/* =========================================================================
 * Thanh tìm kiếm trong terminal
 * ========================================================================= */

/** clearDecorations chỉ có ở SearchAddon mới; đừng để thiếu nó thành lỗi runtime. */
function clearSearchDecorations(session) {
  if (session && typeof session.search.clearDecorations === 'function') session.search.clearDecorations();
}

function runSearch(direction) {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return;
  const query = $('term-search-input').value;
  session.searchQuery = query;
  if (!query) {
    clearSearchDecorations(session);
    $('term-search-count').textContent = '';
    return;
  }
  const options = {
    caseSensitive: $('term-search-case').getAttribute('aria-pressed') === 'true',
    decorations: SEARCH_DECORATIONS,
  };
  const found =
    direction < 0 ? session.search.findPrevious(query, options) : session.search.findNext(query, options);
  if (!found) $('term-search-count').textContent = 'không có';
}

export function openSearchBar() {
  const session = state.sessions.get(state.activeSessionId);
  if (!session) return setStatus('Chưa có phiên nào để tìm.', 'error');
  $('terminal-search').hidden = false;
  const input = $('term-search-input');
  input.value = session.searchQuery || '';
  input.focus();
  input.select();
  if (input.value) runSearch(1);
}

export function closeSearchBar() {
  if ($('terminal-search').hidden) return;
  $('terminal-search').hidden = true;
  $('term-search-count').textContent = '';
  const session = state.sessions.get(state.activeSessionId);
  if (session) {
    session.searchQuery = '';
    clearSearchDecorations(session);
    if (session.status === 'connected') session.term.focus();
  }
}

export function initSearchBar() {
  const input = $('term-search-input');
  input.addEventListener('input', () => runSearch(1));
  input.addEventListener('keydown', (event) => {
    // Bộ gõ tiếng Việt đang soạn thảo thì Enter/Escape thuộc về bộ gõ.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchBar();
    }
  });
  $('term-search-prev').addEventListener('click', () => runSearch(-1));
  $('term-search-next').addEventListener('click', () => runSearch(1));
  $('term-search-close').addEventListener('click', closeSearchBar);
  $('term-search-case').addEventListener('click', () => {
    const button = $('term-search-case');
    const next = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', next ? 'true' : 'false');
    runSearch(1);
  });
}

/* =========================================================================
 * Ghi log phiên
 * ========================================================================= */

export async function toggleSessionLog() {
  const session = requireConnectedSession();
  if (!session) return;
  const sessionId = state.activeSessionId;
  try {
    const active = await call(bridge.logs.status(sessionId));
    const changed = active ? await call(bridge.logs.stop(sessionId)) : await call(bridge.logs.start(sessionId));
    if (changed) {
      session.logging = !active;
      setStatus(active ? 'Đã dừng ghi log.' : 'Đang ghi log phiên.', 'ok');
    }
    renderHeader();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

/* =========================================================================
 * Dashboard
 * ========================================================================= */

export async function refreshDashboard() {
  if ($('dashboard-modal').hidden) return;
  const sessionId = state.activeSessionId;
  const session = activeSession();
  if (!session) {
    // Phiên chết trong lúc bảng còn mở: báo một lần trong bảng, không bắn toast
    // mỗi 10 giây cho tới khi người dùng tự đóng.
    showError('dashboard-error', 'Phiên đã ngắt kết nối. Kết nối lại rồi mở lại bảng này.');
    $('dashboard-loading').hidden = true;
    stopDashboardTimer();
    return;
  }
  clearError('dashboard-error');
  $('dashboard-loading').hidden = false;
  const conn = connectionById(session.connId);
  $('dashboard-subtitle').textContent = conn ? conn.username + '@' + conn.host : session.name;
  try {
    const metrics = await call(bridge.ssh.metrics(sessionId));
    if (state.activeSessionId !== sessionId || $('dashboard-modal').hidden) return;
    const memoryPercent = metrics.memoryTotal ? (metrics.memoryUsed / metrics.memoryTotal) * 100 : 0;
    const diskPercent = metrics.diskTotal ? (metrics.diskUsed / metrics.diskTotal) * 100 : 0;
    $('metric-cpu').textContent = metrics.cpuPercent.toFixed(1) + '%';
    $('metric-load').textContent = metrics.loadAverage.length ? 'Load: ' + metrics.loadAverage.join(' · ') : '';
    $('metric-memory').textContent = memoryPercent.toFixed(1) + '%';
    $('metric-memory-detail').textContent = formatBytes(metrics.memoryUsed) + ' / ' + formatBytes(metrics.memoryTotal);
    $('metric-disk').textContent = diskPercent.toFixed(1) + '%';
    $('metric-disk-detail').textContent = formatBytes(metrics.diskUsed) + ' / ' + formatBytes(metrics.diskTotal);
    $('metric-uptime').textContent = formatUptime(metrics.uptimeSeconds);
    $('metric-collected').textContent = 'Cập nhật ' + new Date(metrics.collectedAt).toLocaleTimeString('vi-VN');
    $('dashboard-grid').hidden = false;
  } catch (err) {
    showError('dashboard-error', err.message);
  } finally {
    $('dashboard-loading').hidden = true;
  }
}

export function stopDashboardTimer() {
  clearInterval(state.dashboardTimer);
  state.dashboardTimer = null;
}

export function openDashboard() {
  if (!requireConnectedSession()) return;
  clearError('dashboard-error');
  openModal('dashboard-modal');
  refreshDashboard();
  stopDashboardTimer();
  state.dashboardTimer = setInterval(() => {
    if ($('dashboard-modal').hidden) stopDashboardTimer();
    else refreshDashboard();
  }, 10000);
}

/* =========================================================================
 * Khôi phục phiên của lần chạy trước
 * ========================================================================= */

export async function restoreWorkspace() {
  if (!state.settings.restoreSessions) return;
  let saved;
  try {
    saved = await call(bridge.vault.workspace());
  } catch {
    return;
  }
  for (const tab of saved.tabs || []) {
    let workspaceId = null;
    for (const connId of tab.connections || []) {
      if (!connectionById(connId)) continue;
      const sessionId = await openSession(connId, { idle: true, workspaceId, direction: tab.layout });
      if (!sessionId || workspaceId) continue;
      // Pane đầu tiên tạo ra tab; các pane sau phải rơi vào đúng tab đó.
      workspaceId = state.sessions.get(sessionId).workspaceId;
      const workspace = state.workspaces.get(workspaceId);
      if (workspace && tab.name) {
        workspace.name = tab.name;
        workspace.autoName = false;
      }
    }
  }
}

/** Dùng khi kho bị khoá: dọn sạch mọi pane mà không ghi đè workspace đã lưu. */
export function closeAllSessions() {
  for (const id of [...state.sessions.keys()]) closeSession(id, true);
  state.workspaces.clear();
  renderTabs();
}
