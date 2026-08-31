// Chạy app thật trong Electron trên một userData tạm rồi điều khiển giao diện
// bằng executeJavaScript để xác minh preload, xterm và luồng tạo kho.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-e2e-'));
app.setPath('userData', tmpDir); // phải đặt TRƯỚC khi main.js đọc đường dẫn

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const errors = [];
let passed = 0;
let failed = 0;

function check(label, condition, extra) {
  if (condition) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    console.log('  FAIL  ' + label + (extra ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWindow() {
  for (let i = 0; i < 100; i += 1) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0) {
      const win = wins[0];
      if (!win.webContents.isLoading()) return win;
    }
    await wait(100);
  }
  throw new Error('Cua so khong xuat hien');
}

app.whenReady().then(async () => {
  try {
    const win = await getWindow();
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message);
    });
    await wait(600);
    const run = (code) => win.webContents.executeJavaScript(code, true);

    // --- 0. window.prompt() không tồn tại trong Electron ---
    // Năm tính năng từng chết im lặng vì gọi nó. Chặn ở cả hai đầu: xác nhận
    // Electron thật sự ném lỗi, và không còn chỗ nào trong renderer gọi tới.
    const promptSupport = await run(
      `(() => { try { window.prompt('a','b'); return 'HO_TRO'; } catch (e) { return 'NEM_LOI'; } })()`
    );
    check('Electron vẫn không hỗ trợ window.prompt', promptSupport === 'NEM_LOI', promptSupport);

    const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
    const promptCallers = fs
      .readdirSync(rendererDir)
      .filter((name) => name.endsWith('.js'))
      .filter((name) => /(?:^|[^.\w])prompt\s*\(/.test(fs.readFileSync(path.join(rendererDir, name), 'utf8')));
    check('không module renderer nào còn gọi prompt()', promptCallers.length === 0, promptCallers);

    // --- 1. Cầu nối preload và thư viện terminal ---
    const env = await run(`({
      api: typeof window.api,
      vaultApi: typeof window.api?.vault?.unlock,
      sshApi: typeof window.api?.ssh?.open,
      metricsApi: typeof window.api?.ssh?.metrics,
      clipboardApi: typeof window.api?.clipboard?.writeText,
      nodeLeak: typeof window.require,
      processLeak: typeof window.process,
      terminal: typeof Terminal,
      fitAddon: typeof FitAddon?.FitAddon,
      xtermCss: !!document.querySelector('link[href*="xterm.css"]')
    })`);
    check('preload lộ đúng window.api', env.api === 'object' && env.vaultApi === 'function' && env.sshApi === 'function', env);
    check('preload chỉ expose dashboard metrics chuyên biệt', env.metricsApi === 'function', env);
    check('preload expose clipboard native có giới hạn', env.clipboardApi === 'function', env);
    check('renderer KHÔNG chạm được vào Node', env.nodeLeak === 'undefined' && env.processLeak === 'undefined', env);
    check('xterm + addon-fit nạp được từ node_modules', env.terminal === 'function' && env.fitAddon === 'function' && env.xtermCss, env);
    const advancedControls = await run(`({
      splitVertical: !!document.getElementById('btn-split-v'),
      splitHorizontal: !!document.getElementById('btn-split-h'),
      dashboard: !!document.getElementById('btn-dashboard'),
      dashboardModal: !!document.getElementById('dashboard-modal')
    })`);
    check('giao diện có điều khiển split nhiều pane và dashboard', Object.values(advancedControls).every(Boolean), advancedControls);
    const windowHitRegions = await run(`(() => {
      const controls = document.querySelector('.window-controls');
      const lockDrag = document.querySelector('.lock-drag');
      const header = document.querySelector('.headerbar');
      const controlRect = controls.getBoundingClientRect();
      const dragRect = lockDrag.getBoundingClientRect();
      const region = (element) => {
        const style = getComputedStyle(element);
        return style.webkitAppRegion || style.getPropertyValue('-webkit-app-region');
      };
      return {
        controls: region(controls),
        header: region(header),
        overlap: dragRect.right > controlRect.left
      };
    })()`);
    check(
      'vùng kéo cửa sổ không chồng hit-test của ba nút',
      windowHitRegions.controls === 'no-drag' && windowHitRegions.header === 'no-drag' && !windowHitRegions.overlap,
      windowHitRegions,
    );
    // Clipboard chỉ mở khi cửa sổ đang được focus — rào chắn có chủ ý, chặn
    // renderer đọc trộm clipboard lúc ứng dụng chạy nền. xvfb trên CI không có
    // window manager nên cửa sổ có thể không bao giờ được focus; ở môi trường đó
    // kiểm chính rào chắn thay vì kiểm vòng round-trip, chứ không nới rào chắn
    // ra chỉ để CI xanh.
    win.focus();
    await wait(300);
    const windowFocusable = win.isFocused();
    const clipboardRoundTrip = await run(`(async () => {
      const sample = 'Tiếng Việt: Trường Sa — 日本語 — 😀';
      const written = await window.api.clipboard.writeText(sample);
      const read = await window.api.clipboard.readText();
      await window.api.clipboard.clearIfMatches(sample);
      return { written: written.ok, error: written.error, read: read.data, sample };
    })()`);
    if (windowFocusable) {
      check(
        'clipboard native copy/paste giữ nguyên Unicode',
        clipboardRoundTrip.written && clipboardRoundTrip.read === clipboardRoundTrip.sample,
        clipboardRoundTrip,
      );
    } else {
      check(
        'cửa sổ không được focus thì clipboard bị chặn đúng như thiết kế',
        clipboardRoundTrip.written === false && /focus/i.test(clipboardRoundTrip.error || ''),
        clipboardRoundTrip,
      );
    }
    const terminalImeIsolation = await run(`(() => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;width:400px;height:200px;left:-1000px;top:0';
      document.body.appendChild(host);
      const terminal = new Terminal();
      terminal.open(host);
      const textarea = terminal.textarea;
      const style = getComputedStyle(textarea);
      const result = {
        helper: textarea.classList.contains('xterm-helper-textarea'),
        border: style.borderStyle
      };
      terminal.dispose();
      host.remove();
      return result;
    })()`);
    check(
      'textarea IME của xterm không bị CSS biểu mẫu ghi đè',
      terminalImeIsolation.helper && terminalImeIsolation.border === 'none',
      terminalImeIsolation,
    );
    const unikeyFallback = await run(`(async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;width:400px;height:200px;left:-1000px;top:0';
      document.body.appendChild(host);
      const terminal = new Terminal();
      terminal.open(host);
      const sent = [];
      const { wireTerminalInput } = await import('./sessions.js');
      wireTerminalInput(terminal, (data) => sent.push(data));
      const keydown = new KeyboardEvent('keydown', {key:'Process', code:'KeyD', bubbles:true});
      Object.defineProperty(keydown, 'keyCode', {value: 229});
      terminal.textarea.dispatchEvent(keydown);
      terminal.textarea.dispatchEvent(new InputEvent('input', {
        data: 'đ', inputType: 'insertText', bubbles: true, composed: true
      }));
      await Promise.resolve();
      terminal.dispose();
      host.remove();
      return sent;
    })()`);
    check(
      'UniKey keyCode 229 gửi đúng một ký tự Unicode vào PTY',
      unikeyFallback.length === 1 && unikeyFallback[0] === 'đ',
      unikeyFallback,
    );

    // --- 2. Màn hình khoá ở chế độ tạo kho mới ---
    const lock = await run(`({
      visible: !document.getElementById('lock-screen').hidden,
      title: document.getElementById('lock-title').textContent,
      confirmShown: !document.getElementById('lock-password-confirm').hidden,
      submit: document.getElementById('lock-submit').textContent
    })`);
    check('vault trống thì hiện màn hình "Tạo kho"', lock.visible && lock.title.includes('Tạo kho') && lock.confirmShown, lock);

    // --- 3. Từ chối mật khẩu không khớp ---
    await run(`(() => {
      document.getElementById('lock-password').value = 'test-password-123';
      document.getElementById('lock-password-confirm').value = 'khac-hoan-toan';
      document.getElementById('lock-form').requestSubmit();
    })()`);
    await wait(400);
    const mismatch = await run(`({
      err: document.getElementById('lock-error').textContent,
      stillLocked: !document.getElementById('lock-screen').hidden
    })`);
    check('hai mật khẩu không khớp thì báo lỗi và vẫn khoá', mismatch.stillLocked && mismatch.err.includes('không khớp'), mismatch);

    // --- 4. Tạo kho thành công ---
    await run(`(() => {
      document.getElementById('lock-password').value = 'test-password-123';
      document.getElementById('lock-password-confirm').value = 'test-password-123';
      document.getElementById('lock-form').requestSubmit();
    })()`);
    await wait(1500); // scrypt mất vài trăm ms
    const unlocked = await run(`({
      appShown: !document.getElementById('app').hidden,
      lockHidden: document.getElementById('lock-screen').hidden,
      emptyList: document.getElementById('conn-list').textContent
    })`);
    check('tạo kho xong thì vào được giao diện chính', unlocked.appShown && unlocked.lockHidden, unlocked);
    check('danh sách rỗng hiển thị hướng dẫn', unlocked.emptyList.includes('Chưa có máy chủ nào'), unlocked.emptyList);

    // Header phải giữ ba vùng tách biệt ngay tại kích thước cửa sổ tối thiểu.
    win.setSize(900, 600);
    await wait(150);
    const compactHeader = await run(`(() => {
      const title = document.querySelector('.hb-titles').getBoundingClientRect();
      const actions = document.querySelector('.hb-actions-right').getBoundingClientRect();
      const controls = document.querySelector('.window-controls').getBoundingClientRect();
      return {
        titleRight: title.right,
        actionsLeft: actions.left,
        actionsRight: actions.right,
        controlsLeft: controls.left,
        titleWidth: title.width
      };
    })()`);
    check(
      'header thu nhỏ không chồng tên, icon công cụ và nút cửa sổ',
      compactHeader.titleWidth > 0 &&
        compactHeader.titleRight <= compactHeader.actionsLeft &&
        compactHeader.actionsRight <= compactHeader.controlsLeft,
      compactHeader,
    );
    win.setSize(1280, 820);
    await wait(150);

    // --- 5. Thêm kết nối qua form ---
    await run(`(() => {
      document.getElementById('btn-new').click();
      document.getElementById('f-name').value = 'Máy thử nghiệm';
      document.getElementById('f-host').value = 'example.internal';
      document.getElementById('f-username').value = 'deploy';
      document.getElementById('f-port').value = '2222';
      document.getElementById('f-group').value = 'Staging';
      document.getElementById('conn-form').requestSubmit();
    })()`);
    await wait(900);
    const added = await run(`({
      modalClosed: document.getElementById('conn-modal').hidden,
      names: [...document.querySelectorAll('.conn-name')].map(n => n.textContent),
      subs: [...document.querySelectorAll('.conn-sub')].map(n => n.textContent),
      groups: [...document.querySelectorAll('.group-title')].map(n => n.textContent)
    })`);
    check('lưu xong thì đóng form', added.modalClosed, added);
    check('kết nối mới hiện trong danh sách', added.names.includes('Máy thử nghiệm'), added.names);
    check('hiện đúng user@host:port', added.subs.some(s => s.includes('deploy@example.internal:2222')), added.subs);
    check('gom nhóm theo trường Nhóm', added.groups.includes('Staging'), added.groups);

    // --- 5b. Hộp nhập liệu thay cho window.prompt ---
    await run(`(async () => {
      const core = await import('./core.js');
      window.__ask = core.askInput({ title: 'Thử nhập', label: 'Giá trị cho \${TARGET}', value: 'cu' });
      return true;
    })()`);
    await wait(300);
    const askOpen = await run(`({
      open: !document.getElementById('input-modal').hidden,
      label: document.getElementById('input-label').textContent,
      value: document.getElementById('input-field').value,
      focused: document.activeElement && document.activeElement.id
    })`);
    check(
      'askInput mở hộp thoại có nhãn, giá trị sẵn và focus đúng ô nhập',
      askOpen.open && askOpen.label.includes('TARGET') && askOpen.value === 'cu' && askOpen.focused === 'input-field',
      askOpen,
    );

    await run(`(() => {
      document.getElementById('input-field').value = 'Đường dẫn Tiếng Việt';
      document.getElementById('input-form').requestSubmit();
    })()`);
    await wait(250);
    const askResult = await run(`window.__ask`);
    check('askInput trả về đúng chuỗi Unicode người dùng nhập', askResult === 'Đường dẫn Tiếng Việt', askResult);
    check('gửi xong thì hộp nhập liệu đóng lại', await run(`document.getElementById('input-modal').hidden`));

    await run(`(async () => {
      const core = await import('./core.js');
      window.__askCancel = core.askInput({ title: 'Huỷ thử', label: 'Giá trị' });
      return true;
    })()`);
    await wait(250);
    await run(`document.getElementById('input-cancel').click()`);
    await wait(200);
    const cancelled = await run(`window.__askCancel`);
    check('bấm Huỷ thì askInput trả null chứ không treo', cancelled === null, cancelled);

    // --- 6. Form báo lỗi khi thiếu host ---
    await run(`(() => {
      document.getElementById('btn-new').click();
      document.getElementById('f-name').value = 'Thiếu host';
      document.getElementById('f-username').value = 'root';
      document.getElementById('f-host').value = '';
      document.getElementById('conn-form').requestSubmit();
    })()`);
    await wait(400);
    const invalid = await run(`({ open: !document.getElementById('conn-modal').hidden })`);
    check('thiếu host thì không cho lưu', invalid.open, invalid);
    await run(`document.getElementById('conn-modal').hidden = true`);

    // --- 7. Tìm kiếm ---
    await run(`(() => {
      const s = document.getElementById('search');
      s.value = 'khongtontai';
      s.dispatchEvent(new Event('input'));
    })()`);
    await wait(200);
    const noMatch = await run(`document.getElementById('conn-list').textContent`);
    check('tìm không ra thì báo rõ', noMatch.includes('Không có máy chủ nào khớp'), noMatch);

    await run(`(() => {
      const s = document.getElementById('search');
      s.value = 'example';
      s.dispatchEvent(new Event('input'));
    })()`);
    await wait(200);
    const match = await run(`[...document.querySelectorAll('.conn-name')].map(n => n.textContent)`);
    check('tìm theo host ra đúng máy', match.includes('Máy thử nghiệm'), match);

    // --- 8. Bảng tìm nhanh Ctrl+K ---
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`);
    await wait(300);
    const palette = await run(`({
      open: !document.getElementById('palette').hidden,
      items: [...document.querySelectorAll('.palette-item .p-name')].map(n => n.textContent),
      hosts: [...document.querySelectorAll('.palette-item .p-host')].map(n => n.textContent)
    })`);
    check('Ctrl+K mở bảng tìm nhanh kèm danh sách', palette.open && palette.items.includes('Máy thử nghiệm'), palette);
    check('bảng tìm nhanh hiện user@host', palette.hosts.some(h => h.includes('deploy@example.internal')), palette.hosts);

    await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await wait(200);
    check('Escape đóng bảng tìm nhanh', await run(`document.getElementById('palette').hidden`));

    // --- 9. Lệnh nhanh ---
    await run(`(() => {
      document.getElementById('btn-new-snippet').click();
      document.getElementById('s-name').value = 'Xem tiến trình';
      document.getElementById('s-command').value = 'ps aux | head -20';
      document.getElementById('snippet-form').requestSubmit();
    })()`);
    await wait(700);
    const snippets = await run(`({
      closed: document.getElementById('snippet-modal').hidden,
      chips: [...document.querySelectorAll('.snippet-chip')].map(c => c.textContent),
      status: document.getElementById('status-text').textContent
    })`);
    check('lưu được lệnh nhanh và hiện thành chip', snippets.closed && snippets.chips.some(c => c.includes('Xem tiến trình')), snippets);

    // --- 10. Bấm lệnh nhanh khi chưa có phiên ---
    await run(`document.querySelector('.snippet-chip .chip-name').click()`);
    await wait(200);
    const noSession = await run(`document.getElementById('status-text').textContent`);
    check('gửi lệnh khi chưa có phiên thì báo lỗi rõ ràng', noSession.includes('Chưa có phiên'), noSession);

    // --- 11. Khoá lại ---
    await run(`document.getElementById('btn-lock').click()`);
    await wait(600);
    const relocked = await run(`({
      locked: !document.getElementById('lock-screen').hidden,
      appHidden: document.getElementById('app').hidden,
      title: document.getElementById('lock-title').textContent,
      submit: document.getElementById('lock-submit').textContent
    })`);
    check('khoá lại quay về màn hình mở khoá', relocked.locked && relocked.appHidden && relocked.title.includes('Mở kho'), relocked);

    // --- 12. Mở khoá sai / đúng ---
    await run(`(() => {
      document.getElementById('lock-password').value = 'sai-mat-khau-999';
      document.getElementById('lock-form').requestSubmit();
    })()`);
    await wait(1500);
    const badUnlock = await run(`({
      err: document.getElementById('lock-error').textContent,
      stillLocked: !document.getElementById('lock-screen').hidden
    })`);
    check('sai master password thì không mở được', badUnlock.stillLocked && badUnlock.err.includes('Sai master password'), badUnlock);

    await run(`(() => {
      document.getElementById('lock-password').value = 'test-password-123';
      document.getElementById('lock-form').requestSubmit();
    })()`);
    await wait(1500);
    const goodUnlock = await run(`({
      appShown: !document.getElementById('app').hidden,
      names: [...document.querySelectorAll('.conn-name')].map(n => n.textContent),
      chips: [...document.querySelectorAll('.snippet-chip')].map(c => c.textContent)
    })`);
    check('mở khoá đúng thì dữ liệu còn nguyên', goodUnlock.appShown && goodUnlock.names.includes('Máy thử nghiệm') && goodUnlock.chips.length === 1, goodUnlock);

    // --- 13. Mở phiên tới host không tồn tại: phải báo lỗi, không treo ---
    await run(`document.querySelector('.conn-item').click()`);
    await wait(2500);
    const session = await run(`({
      tabs: [...document.querySelectorAll('.tab')].length,
      emptyHidden: document.getElementById('empty-state').hidden,
      status: document.getElementById('status-text').textContent,
      hasTermCanvas: !!document.querySelector('.term-pane .xterm')
    })`);
    check('mở phiên tạo ra tab và khung terminal', session.tabs === 1 && session.emptyHidden && session.hasTermCanvas, session);
    check('host không tồn tại thì báo lỗi trên statusbar', /không|thất bại|ENOTFOUND|getaddrinfo|timed out|Error/i.test(session.status), session.status);

    // --- 13b. Thanh tìm trong terminal (thay cho prompt đã hỏng) ---
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'f', ctrlKey:true, bubbles:true}))`);
    await wait(300);
    const searchBar = await run(`({
      open: !document.getElementById('terminal-search').hidden,
      focused: document.activeElement && document.activeElement.id
    })`);
    check(
      'Ctrl+F mở thanh tìm trong terminal và focus ô nhập',
      searchBar.open && searchBar.focused === 'term-search-input',
      searchBar,
    );
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    await wait(250);
    check('Escape đóng thanh tìm trong terminal', await run(`document.getElementById('terminal-search').hidden`));

    await run(`document.querySelector('.tab-close').click()`);
    await wait(400);
    const closed = await run(`({
      tabs: [...document.querySelectorAll('.tab')].length,
      emptyShown: !document.getElementById('empty-state').hidden
    })`);
    check('đóng tab thì quay lại trạng thái rỗng', closed.tabs === 0 && closed.emptyShown, closed);

    // --- 14. Điều khiển cửa sổ gọi đúng BrowserWindow ---
    // isMaximized()/isMinimized() phản ánh trạng thái do window manager quản lý.
    // CI chạy dưới xvfb, vốn không có window manager nào, nên ở đó cửa sổ không
    // bao giờ báo là đã thu nhỏ. Thứ thuộc về mã của ứng dụng là đường đi từ nút
    // trong renderer qua IPC tới BrowserWindow — cái đó khẳng định ở mọi nền tảng;
    // còn trạng thái thật chỉ khẳng định ở nơi chắc chắn có window manager.
    const hasWindowManager = process.platform === 'win32' || process.platform === 'darwin';
    const windowCalls = { maximize: 0, unmaximize: 0, minimize: 0 };
    for (const name of Object.keys(windowCalls)) {
      const original = win[name].bind(win);
      win[name] = (...args) => {
        windowCalls[name] += 1;
        return original(...args);
      };
    }

    await run(`document.getElementById('wc-max').click()`);
    await wait(300);
    check(
      'nút phóng to gọi tới BrowserWindow',
      windowCalls.maximize + windowCalls.unmaximize === 1,
      windowCalls,
    );
    if (hasWindowManager) check('cửa sổ thật sự phóng to', win.isMaximized());

    await run(`document.getElementById('wc-max').click()`);
    await wait(300);
    check(
      'nút phóng to lần hai gọi tới BrowserWindow',
      windowCalls.maximize + windowCalls.unmaximize === 2,
      windowCalls,
    );
    if (hasWindowManager) check('cửa sổ khôi phục sau lần bấm thứ hai', !win.isMaximized());

    await run(`document.getElementById('wc-min').click()`);
    await wait(300);
    check('nút thu nhỏ gọi BrowserWindow.minimize', windowCalls.minimize === 1, windowCalls);
    if (hasWindowManager) check('cửa sổ thật sự thu nhỏ', win.isMinimized());
    win.restore();
    await wait(200);
    let closeRequested = false;
    win.once('close', (event) => {
      closeRequested = true;
      event.preventDefault();
    });
    await run(`document.getElementById('wc-close').click()`);
    await wait(300);
    check('nút đóng gọi BrowserWindow.close', closeRequested);

    // --- 15. Không có lỗi console ---
    check('không có lỗi console trong renderer', errors.length === 0, errors.slice(0, 5));

    console.log('\n' + passed + ' PASS, ' + failed + ' FAIL');
  } catch (err) {
    failed += 1;
    console.log('\nNGOAI LE: ' + err.message);
    console.log(err.stack);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* thu muc tam co the da bi xoa */ }
    app.exit(failed === 0 ? 0 : 1);
  }
});
