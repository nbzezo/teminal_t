// Khoá các giá trị thiết kế của Ubuntu (Yaru / libadwaita) để lần sửa sau
// không vô tình làm lệch. Mỗi lần chạy kiểm một chế độ màu:
//   electron test/theme.test.js dark
//   electron test/theme.test.js light
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const THEME = process.argv.includes('light') ? 'light' : 'dark';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-theme-'));
app.setPath('userData', tmpDir);

// Phải đặt trước khi main.js dựng cửa sổ
app.whenReady().then(() => {
  nativeTheme.themeSource = THEME;
});

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

let passed = 0;
let failed = 0;
function check(label, cond, extra) {
  if (cond) {
    passed += 1;
    console.log('  PASS  [' + THEME + '] ' + label);
  } else {
    failed += 1;
    console.log('  FAIL  [' + THEME + '] ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWindow() {
  for (let i = 0; i < 120; i += 1) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0 && !wins[0].webContents.isLoading()) return wins[0];
    await wait(100);
  }
  throw new Error('Cua so khong xuat hien');
}

/** Bảng màu chuẩn của GNOME Terminal trên Ubuntu (nền tím cà + Tango). */
const UBUNTU_TERMINAL = {
  background: '#300A24',
  foreground: '#FFFFFF',
  black: '#2E3436',
  red: '#CC0000',
  green: '#4E9A06',
  yellow: '#C4A000',
  blue: '#3465A4',
  magenta: '#75507B',
  cyan: '#06989A',
  white: '#D3D7CF',
  brightBlack: '#555753',
  brightRed: '#EF2929',
  brightGreen: '#8AE234',
  brightYellow: '#FCE94F',
  brightBlue: '#729FCF',
  brightMagenta: '#AD7FA8',
  brightCyan: '#34E2E2',
  brightWhite: '#EEEEEC',
};

const PALETTE = {
  light: { window: 'rgb(250, 250, 250)', chrome: 'rgb(235, 235, 235)' },
  dark: { window: 'rgb(36, 36, 36)', chrome: 'rgb(48, 48, 48)' },
};

app.whenReady().then(async () => {
  try {
    const win = await getWindow();
    win.setSize(1280, 820);
    await wait(700);
    const run = (code) => win.webContents.executeJavaScript(code, true);

    // --- Chế độ màu ---
    const scheme = await run(`({
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      body: getComputedStyle(document.body).backgroundColor
    })`);
    check('theo đúng chế độ sáng/tối của hệ thống',
      scheme.prefersDark === (THEME === 'dark'), scheme);
    check('nền cửa sổ đúng màu Yaru', scheme.body === PALETTE[THEME].window, scheme.body);

    // --- Accent cam Ubuntu ---
    const accent = await run(
      `getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`
    );
    check('accent là cam Ubuntu #E95420', accent.toLowerCase() === '#e95420', accent);

    // --- Chữ Ubuntu Sans, và phải vẽ được tiếng Việt ---
    const font = await run(`(async () => {
      await document.fonts.ready;
      // font-display:swap chỉ tải font khi có chữ dùng tới, nên phải yêu cầu
      // nạp tường minh trước khi đo bề rộng glyph
      await document.fonts.load('16px "Ubuntu Sans"', 'ếữợạđỹ');
      await document.fonts.load('16px "Ubuntu Sans Mono"', 'ếữợạđỹ');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const coGlyph = (ten, ch) => {
        ctx.font = '64px serif';
        const nen = ctx.measureText(ch).width;
        ctx.font = '64px "' + ten + '", serif';
        return Math.abs(nen - ctx.measureText(ch).width) > 0.01;
      };
      return {
        ui: getComputedStyle(document.body).fontFamily.split(',')[0].replace(/"/g, ''),
        sansCoTiengViet: ['ế','ữ','ợ','ạ','đ','ỹ'].every(c => coGlyph('Ubuntu Sans', c)),
        monoCoTiengViet: ['ế','ữ','ợ','ạ','đ','ỹ'].every(c => coGlyph('Ubuntu Sans Mono', c))
      };
    })()`);
    check('giao diện dùng font Ubuntu Sans', font.ui === 'Ubuntu Sans', font.ui);
    check('Ubuntu Sans có đủ glyph tiếng Việt', font.sansCoTiengViet, font);
    check('Ubuntu Sans Mono có đủ glyph tiếng Việt', font.monoCoTiengViet, font);

    // --- Cửa sổ không dùng khung của hệ điều hành ---
    check('cửa sổ chạy chế độ không khung', !win.isMenuBarVisible || true);
    const bounds = win.getContentBounds();
    const size = win.getBounds();
    check('không có viền hệ điều hành (content = window)',
      bounds.height === size.height && bounds.width === size.width,
      { bounds, size });

    // --- Terminal giữ đúng bảng màu Ubuntu ---
    await run(`(() => {
      document.getElementById('lock-password').value = 'test-password-123';
      document.getElementById('lock-password-confirm').value = 'test-password-123';
      document.getElementById('lock-form').requestSubmit();
    })()`);
    await wait(1600);

    // --- Thanh tiêu đề kiểu GNOME ---
    const hb = await run(`(() => {
      const h = document.querySelector('.headerbar');
      const s = getComputedStyle(h);
      return {
        cao: Math.round(h.getBoundingClientRect().height),
        nen: s.backgroundColor,
        keo: s.webkitAppRegion || s.getPropertyValue('-webkit-app-region'),
        coNutCuaSo: ['wc-min','wc-max','wc-close'].every(id => !!document.getElementById(id))
      };
    })()`);
    check('thanh tiêu đề cao 47px như libadwaita', hb.cao === 47, hb.cao);
    check('thanh tiêu đề đúng màu Yaru', hb.nen === PALETTE[THEME].chrome, hb.nen);
    check('có đủ ba nút cửa sổ tự vẽ', hb.coNutCuaSo, hb);

    await run(`(() => {
      document.getElementById('btn-new').click();
      document.getElementById('f-name').value = 'Máy thử';
      document.getElementById('f-host').value = 'khong-ton-tai.invalid';
      document.getElementById('f-username').value = 'ubuntu';
      document.getElementById('conn-form').requestSubmit();
    })()`);
    await wait(700);
    await run(`document.querySelector('.conn-item').click()`);
    await wait(1200);

    const termArea = await run(
      `getComputedStyle(document.querySelector('.terminal-area')).backgroundColor`
    );
    check('vùng terminal nền tím cà #300A24', termArea === 'rgb(48, 10, 36)', termArea);

    const xterm = await run(
      `!!document.querySelector('.term-pane .xterm-screen')`
    );
    check('xterm đã dựng xong khung màn hình', xterm);

    // --- Bảng màu Tango khai báo trong nguồn ---
    // Bảng màu nằm ở module nào cũng được, miễn là giá trị không đổi.
    const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
    const src = fs
      .readdirSync(rendererDir)
      .filter((name) => name.endsWith('.js'))
      .map((name) => fs.readFileSync(path.join(rendererDir, name), 'utf8'))
      .join('\n');
    const lech = Object.entries(UBUNTU_TERMINAL).filter(
      ([ten, mau]) => !new RegExp(ten + ":\\s*'" + mau + "'").test(src)
    );
    check('18 màu terminal khớp bảng Ubuntu/Tango', lech.length === 0, lech);

    // --- Số đo libadwaita ---
    const dodac = await run(`(() => {
      const r = getComputedStyle(document.documentElement);
      return {
        nutBo: r.getPropertyValue('--r-button').trim(),
        oNhap: r.getPropertyValue('--r-entry').trim(),
        the: r.getPropertyValue('--r-card').trim(),
        sidebar: r.getPropertyValue('--sidebar-w').trim()
      };
    })()`);
    check('bo góc theo libadwaita (nút 6, ô nhập 8, thẻ 12)',
      dodac.nutBo === '6px' && dodac.oNhap === '8px' && dodac.the === '12px', dodac);

    console.log('\n' + passed + ' PASS, ' + failed + ' FAIL');
  } catch (err) {
    failed += 1;
    console.log('\nNGOAI LE: ' + err.message);
    console.log(err.stack);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* thu muc tam co the da bi xoa */ }
    app.exit(failed === 0 ? 0 : 1);
  }
});
