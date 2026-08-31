// Kiểm tra ứng dụng cư xử đúng khi người dùng gõ tiếng Việt bằng bộ gõ IME.
// Bộ gõ tiếng Việt (Telex/VNI, Unikey, IME của Windows) tạo ra một "phiên soạn
// thảo": trong lúc đó các phím Enter, Escape, mũi tên thuộc về bộ gõ chứ không
// phải ứng dụng. Trình duyệt báo điều này qua cờ isComposing của sự kiện phím.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshman-ime-'));
app.setPath('userData', tmpDir);

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const errors = [];
let passed = 0;
let failed = 0;

function check(label, cond, extra) {
  if (cond) {
    passed += 1;
    console.log('  PASS  ' + label);
  } else {
    failed += 1;
    console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWindow() {
  for (let i = 0; i < 100; i += 1) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0 && !wins[0].webContents.isLoading()) return wins[0];
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

    // Tạo kho và thêm hai máy chủ có tên tiếng Việt
    await run(`(() => {
      document.getElementById('lock-password').value = 'test-password-123';
      document.getElementById('lock-password-confirm').value = 'test-password-123';
      document.getElementById('lock-form').requestSubmit();
    })()`);
    await wait(1500);

    const them = async (name, host, group, notes) => {
      await run(`(() => {
        document.getElementById('btn-new').click();
        document.getElementById('f-name').value = ${JSON.stringify(name)};
        document.getElementById('f-host').value = ${JSON.stringify(host)};
        document.getElementById('f-username').value = 'quantri';
        document.getElementById('f-group').value = ${JSON.stringify(group)};
        document.getElementById('f-notes').value = ${JSON.stringify(notes || '')};
        document.getElementById('conn-form').requestSubmit();
      })()`);
      await wait(700);
    };
    await them('Máy chủ Hà Nội', 'hanoi.internal', 'Sản xuất', 'Đặt tại trung tâm dữ liệu Cầu Giấy');
    await them('Máy chủ Đà Nẵng', 'danang.internal', 'Sản xuất', 'Dự phòng');

    // --- 1. Tiếng Việt lưu và hiện lại nguyên vẹn ---
    const names = await run(`[...document.querySelectorAll('.conn-name')].map(n => n.textContent)`);
    check('tên tiếng Việt lưu và hiện lại nguyên vẹn',
      names.includes('Máy chủ Hà Nội') && names.includes('Máy chủ Đà Nẵng'), names);

    const groups = await run(`[...document.querySelectorAll('.group-title')].map(n => n.textContent)`);
    check('tên nhóm tiếng Việt hiển thị đúng', groups.includes('Sản xuất'), groups);

    // --- 2. Tìm kiếm CÓ dấu ---
    const timCoDau = await run(`(() => {
      const s = document.getElementById('search');
      s.value = 'Hà Nội';
      s.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('.conn-name')].map(n => n.textContent);
    })()`);
    check('tìm bằng chữ có dấu ra đúng máy', timCoDau.includes('Máy chủ Hà Nội'), timCoDau);

    // --- 3. Tìm kiếm KHÔNG dấu (thói quen gõ nhanh của người Việt) ---
    const timKhongDau = await run(`(() => {
      const s = document.getElementById('search');
      s.value = 'ha noi';
      s.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('.conn-name')].map(n => n.textContent);
    })()`);
    check('tìm bằng chữ KHÔNG dấu vẫn ra máy có dấu', timKhongDau.includes('Máy chủ Hà Nội'), timKhongDau);

    const timChuThuong = await run(`(() => {
      const s = document.getElementById('search');
      s.value = 'DA NANG';
      s.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('.conn-name')].map(n => n.textContent);
    })()`);
    check('tìm không dấu viết hoa vẫn khớp', timChuThuong.includes('Máy chủ Đà Nẵng'), timChuThuong);

    await run(`(() => {
      const s = document.getElementById('search');
      s.value = '';
      s.dispatchEvent(new Event('input'));
    })()`);
    await wait(200);

    // --- 4. Phím Enter trong lúc bộ gõ đang soạn thảo ---
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`);
    await wait(300);
    const paletteMo = await run(`!document.getElementById('palette').hidden`);
    check('Ctrl+K mở được bảng tìm nhanh', paletteMo);

    const enterKhiSoanThao = await run(`(() => {
      const input = document.getElementById('palette-input');
      input.dispatchEvent(new CompositionEvent('compositionstart', {bubbles: true}));
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, isComposing:true}));
      return {
        conMo: !document.getElementById('palette').hidden,
        soTab: document.querySelectorAll('.tab').length
      };
    })()`);
    check('Enter khi bộ gõ đang soạn thảo KHÔNG kết nối nhầm',
      enterKhiSoanThao.conMo && enterKhiSoanThao.soTab === 0, enterKhiSoanThao);

    // --- 5. Phím mũi tên trong lúc soạn thảo không đổi lựa chọn ---
    const muiTenKhiSoanThao = await run(`(() => {
      const input = document.getElementById('palette-input');
      const truoc = [...document.querySelectorAll('.palette-item')].findIndex(r => r.classList.contains('active'));
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, isComposing:true}));
      const sau = [...document.querySelectorAll('.palette-item')].findIndex(r => r.classList.contains('active'));
      return { truoc, sau };
    })()`);
    check('mũi tên khi đang soạn thảo KHÔNG đổi lựa chọn',
      muiTenKhiSoanThao.truoc === muiTenKhiSoanThao.sau, muiTenKhiSoanThao);

    // --- 6. Escape trong lúc soạn thảo chỉ huỷ bộ gõ, không đóng bảng ---
    const escapeKhiSoanThao = await run(`(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, isComposing:true}));
      return !document.getElementById('palette').hidden;
    })()`);
    check('Escape khi đang soạn thảo KHÔNG đóng bảng tìm nhanh', escapeKhiSoanThao);

    // --- 7. Sau khi soạn thảo xong thì phím hoạt động bình thường trở lại ---
    const sauSoanThao = await run(`(() => {
      const input = document.getElementById('palette-input');
      input.dispatchEvent(new CompositionEvent('compositionend', {bubbles: true, data: 'Hà'}));
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      return document.getElementById('palette').hidden;
    })()`);
    check('soạn thảo xong thì Escape đóng bảng như thường', sauSoanThao);

    // --- 8. Enter thật (không soạn thảo) vẫn kết nối được ---
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}))`);
    await wait(300);
    await run(`document.getElementById('palette-input').dispatchEvent(
      new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`);
    await wait(800);
    const enterThat = await run(`({
      dong: document.getElementById('palette').hidden,
      soTab: document.querySelectorAll('.tab').length
    })`);
    check('Enter thật vẫn mở được phiên', enterThat.dong && enterThat.soTab === 1, enterThat);

    // --- 9. Lệnh nhanh chứa tiếng Việt ---
    await run(`(() => {
      document.getElementById('btn-new-snippet').click();
      document.getElementById('s-name').value = 'Kiểm tra dung lượng ổ đĩa';
      document.getElementById('s-command').value = 'df -h';
      document.getElementById('snippet-form').requestSubmit();
    })()`);
    await wait(700);
    const chip = await run(`[...document.querySelectorAll('.snippet-chip')].map(c => c.textContent)`);
    check('lệnh nhanh tên tiếng Việt hiển thị đúng',
      chip.some((c) => c.includes('Kiểm tra dung lượng ổ đĩa')), chip);

    // --- 10. Tiếng Việt sống sót qua một vòng khoá/mở kho ---
    await run(`document.getElementById('btn-lock').click()`);
    await wait(700);
    await run(`(() => {
      document.getElementById('lock-password').value = 'test-password-123';
      document.getElementById('lock-form').requestSubmit();
    })()`);
    await wait(1600);
    const sauMoLai = await run(`({
      ten: [...document.querySelectorAll('.conn-name')].map(n => n.textContent),
      ghiChu: [...document.querySelectorAll('.conn-item')].map(i => i.title)
    })`);
    check('tiếng Việt nguyên vẹn sau khi khoá rồi mở lại kho',
      sauMoLai.ten.includes('Máy chủ Hà Nội') &&
      sauMoLai.ghiChu.some((t) => t.includes('Cầu Giấy')), sauMoLai);

    check('không có lỗi console trong renderer', errors.length === 0, errors.slice(0, 5));

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
