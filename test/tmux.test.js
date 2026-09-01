// Phiên bền: đặt tên, kiểm tên, dựng lệnh gắn phiên và đọc kết quả probe.
// Đây là phần logic thuần — cũng là phần duy nhất chạm tới một lệnh shell chạy
// trên máy chủ, nên nó được kiểm riêng thay vì chỉ đi kèm test mạng.
const path = require('path');
const PROJECT = path.join(__dirname, '..');
const SRC = path.join(PROJECT, 'src', 'main');

const { buildTmuxSessionName, validateTmuxName, slugifyForTmux } = require(path.join(SRC, 'validation.js'));
const { buildTmuxCommand, parseTmuxProbe } = require(path.join(SRC, 'ssh-manager.js'));

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

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

console.log('\n== Đặt tên phiên ==');

const web01 = buildTmuxSessionName('web01');
check('tab 1 pane 1 không có hậu tố', web01 === 'sshman_web01', web01);
check('tab 2 thêm số tab', buildTmuxSessionName('web01', { tabIndex: 2 }) === 'sshman_web01-2');
check(
  'pane 3 của tab 2 thêm cả hai',
  buildTmuxSessionName('web01', { tabIndex: 2, paneIndex: 3 }) === 'sshman_web01-2-3',
);
check(
  'pane 2 của tab 1 vẫn ghi rõ số tab',
  buildTmuxSessionName('web01', { paneIndex: 2 }) === 'sshman_web01-1-2',
);

// Tên máy chủ trong kho là tiếng Việt có dấu; bỏ dấu chứ không được loại sạch
// thành chuỗi rỗng, nếu không mọi máy sẽ dùng chung một tên phiên.
const hanoi = buildTmuxSessionName('Máy chủ Hà Nội');
check('bỏ dấu tiếng Việt', hanoi === 'sshman_may-chu-ha-noi', hanoi);
const danang = buildTmuxSessionName('Đà Nẵng DB');
check('đ/Đ thành d', danang === 'sshman_da-nang-db', danang);
check('tên toàn ký tự lạ vẫn ra tên dùng được', buildTmuxSessionName('!!! ???') === 'sshman_server');
check('slug cắt 16 ký tự', slugifyForTmux('a'.repeat(40)).length === 16);
check(
  'tên rất dài cộng hậu tố vẫn hợp lệ',
  buildTmuxSessionName('b'.repeat(80), { tabIndex: 99, paneIndex: 9 }).length <= 32,
);
check('không có gạch ngang thừa ở cuối slug', !buildTmuxSessionName('web01 ---').includes('--'));

// Tên người dùng tự đặt cũng chỉ là gốc: thiếu hậu tố thì hai pane cùng gắn một
// phiên tmux và soi gương nhau.
check(
  'tên tự đặt vẫn nhận hậu tố tab/pane',
  buildTmuxSessionName('web01', { base: 'lam_viec', tabIndex: 2, paneIndex: 2 }) === 'lam_viec-2-2',
);
check('tên tự đặt ở tab 1 pane 1 giữ nguyên', buildTmuxSessionName('web01', { base: 'lam_viec' }) === 'lam_viec');

console.log('\n== Kiểm tên (bề mặt command injection) ==');

const INJECTIONS = [
  'x; rm -rf /',
  'x && reboot',
  'x`whoami`',
  'x$(id)',
  "x'y",
  'x"y',
  'x y',
  'x|y',
  'x>y',
  'x\ny',
  '../../etc/passwd',
  'a.b',
  'a:b',
  '',
  'z'.repeat(33),
];
for (const bad of INJECTIONS) {
  check('chặn ' + JSON.stringify(bad), throws(() => validateTmuxName(bad)));
}
check('chấp nhận tên hợp lệ', validateTmuxName('sshman_web01-2-3') === 'sshman_web01-2-3');
check('tên tự đặt có ký tự lạ bị chặn ngay khi dựng', throws(() => buildTmuxSessionName('web01', { base: 'a b' })));

console.log('\n== Lệnh gắn phiên ==');

const full = buildTmuxCommand(
  { name: 'sshman_web01', mouse: true, hideStatus: true, historyLimit: 50000 },
  '/var/www',
);
check('gắn bằng attach-session', full.includes('exec tmux -u attach-session -t =sshman_web01'));
check('tạo phiên khi chưa có', full.includes('tmux -u has-session -t =sshman_web01'));
// Thiếu dấu = thì tmux so khớp theo tiền tố: sshman_web01 có thể gắn nhầm vào
// sshman_web01-2, tức là gắn vào việc của tab khác.
check('mọi target đều so khớp chính xác', !/-t (?!=)/.test(full), full);
check('thư mục được bọc nháy đơn', full.includes("-c '/var/www'"));
check('có đường lùi khi thư mục không còn', full.includes('|| tmux -u new-session -d -s sshman_web01'));
check('đặt mouse on', full.includes('mouse on'));
// `set-option -t` nhận target-*pane*: `=NAME` bị từ chối thẳng với "no such
// session", còn `=NAME:` vừa được chấp nhận vừa giữ so khớp chính xác.
// Đã kiểm chứng với tmux 3.6 thật.
check('set-option dùng target window (có dấu hai chấm)', !/set-option -t =[A-Za-z0-9_-]+ /.test(full), full);
check('set-option vẫn so khớp chính xác', /set-option -t =sshman_web01: /.test(full));
check(
  'attach dùng target session (không dấu hai chấm)',
  full.includes('attach-session -t =sshman_web01') && !full.includes('attach-session -t =sshman_web01:'),
);
check('đặt status off', full.includes('status off'));
// tmux đoán UTF-8 từ LC_ALL/LC_CTYPE/LANG và thay mọi ký tự ngoài ASCII bằng `_`
// nếu đoán là không có. Channel `exec` không đi qua profile nên các biến đó trống,
// và "Phiên làm việc" hiện thành "Phi_n l_m vi_c". Đã tái hiện với tmux 3.6 thật.
for (const verb of ['has-session', 'new-session', 'set-option', 'attach-session']) {
  check('lệnh ' + verb + ' ép UTF-8 bằng -u', !new RegExp('tmux (?!-u )[a-z-]*' + verb).test(full), full);
}
check('không có lời gọi tmux nào thiếu -u', !/tmux (?!-u )/.test(full), full);
check('đặt history-limit', full.includes('history-limit 50000'));
check('lỗi set-option không hiện ra terminal', full.includes('2>/dev/null'));
// Login shell của người dùng có thể là csh hay fish; if/then sẽ vỡ ở đó.
check('không dùng cú pháp if/then', !full.includes('if ') && !full.includes('then'));

const bare = buildTmuxCommand({ name: 'sshman_db' }, '');
check('không có thư mục thì không có -c', !bare.includes(' -c '));
check('tắt hết tuỳ chọn thì không set-option', !bare.includes('set-option'));

const quoted = buildTmuxCommand({ name: 'sshman_db' }, "/srv/o'brien");
check('nháy đơn trong đường dẫn được escape', quoted.includes(`'/srv/o'"'"'brien'`), quoted);
check('lệnh xấu bị chặn trước khi dựng', throws(() => buildTmuxCommand({ name: 'a; reboot' }, '')));

console.log('\n== Đọc kết quả probe ==');

const none = parseTmuxProbe('');
check('không có tmux thì available = false', none.available === false && none.sessions.length === 0);

const empty = parseTmuxProbe('__sshman_tmux__\n');
check('có tmux nhưng chưa có phiên', empty.available === true && empty.sessions.length === 0);

const probe = parseTmuxProbe(
  ['__sshman_tmux__', '0 2 1700000000 sshman_web01', '1 1 1700000100 viec cua toi', 'rac khong dung dinh dang'].join(
    '\n',
  ),
);
check('đọc đủ hai phiên, bỏ dòng rác', probe.sessions.length === 2, probe.sessions);
check('phiên rời', probe.sessions[0].attached === false && probe.sessions[0].windows === 2);
check('phiên đang gắn', probe.sessions[1].attached === true);
// Tên tmux của người dùng tự đặt có thể chứa dấu cách, nên chỉ tách ba trường số
// đầu rồi lấy toàn bộ phần đuôi làm tên.
check('tên có dấu cách không bị cắt', probe.sessions[1].name === 'viec cua toi', probe.sessions[1].name);
check('phân biệt phiên của app và phiên tạo tay', probe.sessions[0].owned === true && probe.sessions[1].owned === false);
check('đổi thời gian tạo sang mili giây', probe.sessions[0].createdAt === 1700000000000);

console.log('\n' + passed + ' PASS, ' + failed + ' FAIL');
process.exit(failed === 0 ? 0 : 1);
