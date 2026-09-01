# SSH Manager

Ứng dụng desktop (Electron) để lưu, truy cập nhanh và thao tác lệnh trên các máy chủ SSH.
Giao diện lấy cảm hứng từ Yaru/libadwaita và hỗ trợ Windows 10/11 cùng Ubuntu Desktop
22.04/24.04 LTS. Xem [hướng dẫn và GAP Analysis đa nền tảng](docs/CROSS_PLATFORM.md).

## Chạy

```bash
npm start
```

Lần chạy đầu tiên bạn sẽ được yêu cầu đặt **master password** (tối thiểu 12 ký tự).
Toàn bộ kho — kể cả tên máy chủ — được mã hoá bằng khoá dẫn xuất từ mật khẩu này.
**Quên là mất kho, không có cách khôi phục.**

## Chức năng

| Việc cần làm            | Cách làm                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Thêm máy chủ            | Nút **+ Kết nối** hoặc <kbd>Ctrl</kbd>+<kbd>N</kbd>                                                                    |
| Kết nối                 | Bấm vào máy trong danh sách bên trái                                                                                   |
| Tìm và kết nối nhanh    | <kbd>Ctrl</kbd>+<kbd>K</kbd>, gõ tên/host, <kbd>Enter</kbd>                                                            |
| Lọc danh sách           | Ô tìm kiếm ở cột trái (khớp tên, host, user, nhóm, ghi chú)                                                            |
| Nhiều phiên cùng lúc    | Mỗi lần kết nối mở một tab riêng; <kbd>Ctrl</kbd>+<kbd>Tab</kbd> hoặc <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> để chuyển |
| Chia terminal           | Nút chia dọc/ngang hoặc <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E/O</kbd>; tối đa 4 pane, **mỗi pane là một kết nối SSH riêng** |
| Pane sang máy chủ khác  | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>, hoặc chuột phải máy chủ ở cột trái → **Mở thành pane trong tab này**      |
| Pane khỏi xác thực lại  | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> thêm shell trên chính kết nối đang mở; nhanh nhưng rớt kết nối là mất cả nhóm |
| Đổi tên tab             | Bấm đúp vào tab hoặc chuột phải → **Đổi tên tab**; tab là một công việc chứ không phải một máy chủ                      |
| Chuyển giữa các pane    | <kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>4</kbd>, hoặc bấm vào pane                                                             |
| Đóng phiên              | <kbd>Ctrl</kbd>+<kbd>W</kbd> đóng pane, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> đóng cả tab                       |
| Kết nối lại khi rớt     | Nút **Kết nối lại** hiện ngay trên pane đã ngắt, giữ nguyên vị trí trong tab                                            |
| Xem toàn bộ phím tắt    | <kbd>F1</kbd>                                                                                                          |
| Lệnh dùng nhiều         | Lưu/tìm theo tên, nhóm hoặc nội dung ở thanh **Lệnh nhanh**; hỗ trợ biến `${name}` và điền trước khi gửi               |
| Lệnh chạy tự động       | Điền ô _Lệnh chạy ngay khi kết nối_ trong form máy chủ                                                                 |
| Lấy sẵn host có rồi     | Nút **Nhập config** đọc `~/.ssh/config`                                                                                |
| Phân loại môi trường    | Chọn Development/Staging/Production; Production luôn cảnh báo trước khi kết nối                                        |
| Sao chép cấu hình       | Mở form sửa rồi chọn **Sao chép**; credential vẫn nằm trong vault mã hoá                                               |
| Sao chép trong terminal | Nút copy, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>, <kbd>Ctrl</kbd>+<kbd>Insert</kbd>, hoặc bật *copy khi bôi đen* |
| Dán vào terminal        | Nút paste, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> hoặc <kbd>Shift</kbd>+<kbd>Insert</kbd>; bracketed paste       |
| Menu trong terminal     | Chuột phải: sao chép, dán, tìm, chọn tất cả, chia pane (riêng hoặc dùng chung), đóng pane                               |
| Mở link trong terminal  | Bấm thẳng vào URL; link mở bằng trình duyệt của hệ điều hành                                                            |
| Cỡ chữ terminal         | <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>Ctrl</kbd>+<kbd>-</kbd>, áp cho mọi tab và được ghi nhớ                             |
| Gõ tiếng Việt           | UniKey bảng mã **Unicode** (Telex/VNI); ký tự `keyCode 229` được chuyển nguyên vẹn qua SSH                              |
| Tìm trong terminal      | <kbd>Ctrl</kbd>+<kbd>F</kbd> mở thanh tìm có đếm kết quả, tới/lui và phân biệt hoa thường                               |
| Khoá kho                | <kbd>Ctrl</kbd>+<kbd>L</kbd> — ngắt hết phiên và xoá khoá khỏi RAM                                                     |
| Đổi master password     | Nút ⚙ trên thanh tiêu đề                                                                                               |
| Backup/khôi phục        | ⚙ → **Backup mã hoá**; credential không được xuất mặc định                                                             |
| Quản lý host key        | ⚙ → **Host key đã tin cậy** để xem fingerprint hoặc quên một mục                                                       |
| Quản lý file SFTP       | Nút SFTP: breadcrumb, sắp xếp theo tên/kích thước/ngày, upload nhiều file, đổi tên, chmod, xoá có xác nhận             |
| Port forwarding         | Nút tunnel hỗ trợ Local, Remote và SOCKS5 Dynamic; đều bind loopback và tự đóng theo kết nối                           |
| Jump host               | Chọn một cấu hình đã lưu trong ô **Jump host**; mỗi hop xác minh host key độc lập; `ProxyJump` được nhập tự động       |
| Ghi log phiên           | Nút ghi log trong phiên; nút sáng đỏ khi đang ghi, luôn cảnh báo dữ liệu nhạy cảm và mặc định tắt                      |
| Tự kết nối lại          | Bật trong cấu hình máy chủ; retry 1/2/4 giây, tối đa 3 lần. Bật phiên bền thì kiên nhẫn tới 10 phút               |
| Phiên bền (tmux)        | Ô **Phiên bền** trong form máy chủ, hoặc ⚙ → bật cho mọi máy. Rớt mạng không mất việc đang chạy                    |
| Xem và dọn phiên tmux   | Nút **Phiên trên máy chủ** trên thanh công cụ, hoặc chuột phải trong terminal                                      |
| Tuỳ chỉnh terminal      | ⚙ → **Terminal**: font, cỡ chữ, màu nền, copy khi bôi đen; áp dụng ngay cho các tab đang mở                            |
| Chế độ sáng/tối         | ⚙ → **Chung**: theo hệ thống, luôn sáng, hoặc luôn tối                                                                 |
| Dashboard máy chủ       | Nút dashboard trong phiên đã kết nối; CPU/RAM/disk/uptime/load tự làm mới mỗi 10 giây, chỉ đọc và không cài agent      |
| Nhật ký chẩn đoán       | ⚙ → **Bảo mật**; mặc định tắt, nội dung đi qua đúng bộ lọc che secret như thông báo lỗi                                |

Máy chủ được xếp theo nhóm, trong mỗi nhóm ưu tiên máy vừa dùng gần nhất. Danh sách
dùng được hoàn toàn bằng bàn phím: <kbd>Tab</kbd> vào danh sách, mũi tên để đi,
<kbd>Enter</kbd> để kết nối, chuột phải (hoặc phím menu) để sửa/nhân bản/xoá.

Ứng dụng nhớ kích thước cửa sổ và mở lại các tab của lần chạy trước ở trạng thái
chờ — tab được dựng sẵn nhưng chỉ kết nối khi bạn bấm. Đóng cửa sổ lúc còn phiên
đang chạy sẽ được hỏi lại; có thể tắt trong ⚙ → **Chung**.

## Phiên bền

Bật **Phiên bền** cho một máy chủ thì mỗi pane chạy trong một phiên `tmux` trên chính
máy đó. Rớt mạng, đóng nắp laptop hay đổi Wi-Fi đều không giết tiến trình đang chạy;
lần kết nối sau bạn nhận lại đúng màn hình cũ kèm thư mục và job. Máy chủ phải có sẵn
`tmux`; nếu không, app rơi về shell thường kèm một dòng cảnh báo.

Ba điều thay đổi khi bật, cần biết trước:

- **Đóng pane là *rời phiên*, không phải kết thúc.** Việc vẫn chạy trên máy chủ. Kết
  thúc hẳn bằng chuột phải → **Kết thúc phiên trên máy chủ**, hoặc trong bảng
  **Phiên trên máy chủ**. Cả hai đều hỏi xác nhận.
- **Khoá kho không dừng được việc từ xa nữa.** Xem mục Bảo mật.
- **Cuộn màn hình do tmux quản.** App tự bật `mouse on` cho phiên nó tạo nên con lăn
  vẫn dùng được. `history-limit` app đặt chỉ áp cho pane tạo sau; muốn áp cho cả pane
  đầu tiên thì đặt trong `~/.tmux.conf` trên máy chủ.

Tiếng Việt trong phiên bền vẫn hiển thị đúng: app gọi `tmux -u` để ép chế độ UTF-8,
không phụ thuộc vào biến locale trên máy chủ. Thiếu nó thì tmux thay mọi ký tự có
dấu bằng `_`.

Tên phiên đặt theo đúng tab và pane bạn đang nhìn — tab đầu của `web01` là
`sshman_web01`, tab hai là `sshman_web01-2`, pane ba của tab hai là `sshman_web01-2-3`
— nên `tmux ls` khi ssh tay vào máy vẫn đọc được. Số tab đếm riêng cho từng máy chủ:
một tab là một công việc và có thể chứa pane của nhiều máy khác nhau, nên mỗi máy tự
đếm tab của riêng nó. Mỗi pane một phiên riêng, không pane nào soi gương pane nào.
Ba tuỳ chọn tmux đều ở phạm vi session nên chết theo session, không đụng `~/.tmux.conf` của bạn.

## Tiếng Việt

Gõ tiếng Việt bằng Unikey, Telex/VNI hay bộ gõ của Windows đều hoạt động bình thường:

- Trong lúc bộ gõ đang soạn thảo, các phím <kbd>Enter</kbd>, <kbd>Esc</kbd> và mũi tên
  thuộc về bộ gõ chứ không kích hoạt phím tắt của ứng dụng. Nhấn Enter để chốt từ sẽ
  không còn mở nhầm kết nối.
- Ô tìm kiếm khớp cả khi gõ không dấu: `ha noi` vẫn ra `Máy chủ Hà Nội`.
- Dữ liệu từ máy chủ được ghép lại đúng cả khi gói tin TCP bị cắt vào giữa một ký tự
  nhiều byte, nên không còn hiện tượng chữ vỡ thành `Ti���ng`.
- Font Ubuntu Sans và Ubuntu Sans Mono đi kèm có đủ glyph tiếng Việt, nên chữ có dấu
  không bị rơi sang font khác.

## Giao diện

Bám theo Ubuntu 26.04:

- **Chữ** Ubuntu Sans cho giao diện, Ubuntu Sans Mono cho terminal (đóng gói sẵn
  trong `node_modules`, không gọi ra mạng), cỡ nền 11pt như mặc định của Ubuntu.
- **Màu** theo token của libadwaita với accent cam Ubuntu `#E95420`. Chế độ sáng
  `#FAFAFA` / `#EBEBEB`, chế độ tối `#242424` / `#303030`, tự đổi theo cài đặt sáng-tối
  của hệ điều hành.
- **Terminal** giữ nguyên nền tím cà `#300A24` cùng bảng màu Tango của GNOME Terminal
  trên Ubuntu, không đổi theo chế độ sáng/tối.
- **Thanh tiêu đề** kiểu GNOME cao 47px, tiêu đề canh giữa, ba nút cửa sổ tròn bên
  phải. Cửa sổ chạy chế độ không khung nhưng vẫn kéo cạnh và snap được như thường.
- **Thành phần** theo libadwaita: boxed list, nhóm nút phân đoạn, công tắc, thông báo
  nổi (toast), bo góc 6px cho nút, 8px cho ô nhập, 12px cho thẻ.

Hai điểm tôi chưa chắc khớp tuyệt đối với bản 26.04 và đã chọn theo Adwaita chuẩn:
sắc độ hover của nút đóng cửa sổ, và việc Ubuntu 26.04 có đổi màu nền terminal mặc
định hay không. Nếu bạn muốn khác, sửa `--accent` và `TERM_THEME` là đủ.

## Xác thực

**SSH key** (khuyến nghị) — trỏ tới file private key, hoặc để trống đường dẫn thì app
tự dùng `ssh-agent` của hệ điều hành (trên Windows là `\\.\pipe\openssh-ssh-agent`).
Passphrase của key nếu có sẽ được lưu mã hoá.

**Mật khẩu** — lưu mã hoá trong kho. Tiện hơn nhưng luôn kém an toàn hơn key.

Khi sửa một máy chủ, để trống ô mật khẩu/passphrase nghĩa là **giữ nguyên** giá trị cũ.

## Bảo mật

- Kho nằm trong thư mục `userData` chuẩn của Electron (`%APPDATA%` trên Windows,
  `~/.config` trên Ubuntu; xem đường dẫn chính xác trong ⚙ → Thông tin).
- Mã hoá **AES-256-GCM**, khoá dẫn xuất bằng **scrypt** (N=32768, r=8, p=1). GCM phát
  hiện nếu file bị sửa. Ghi file theo kiểu ghi-tạm-rồi-đổi-tên để không hỏng kho khi mất điện.
- Khoá giải mã chỉ tồn tại trong RAM của main process. Credential đã lưu không bao giờ được
  trả về renderer — renderer chỉ gửi id kết nối, main process tự tra bí mật và dùng. Master
  password nhập ở màn hình khoá đi qua kênh IPC cô lập đúng một chiều để dẫn xuất khoá; nó
  không được ghi file, log hoặc trả lại giao diện.
- Renderer chạy với `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` và
  một CSP chặt. Main process kiểm tra nguồn gửi của mọi IPC và giới hạn kích thước đầu vào.
- Host key kiểm theo mô hình TOFU: lần đầu hỏi bạn xác nhận vân tay SHA256, các lần sau
  phải khớp. Vân tay đổi thì hiện cảnh báo đỏ và chặn cho tới khi bạn xác nhận lại.
  Danh sách lưu ở `known_hosts.json` cạnh kho.
- Host, port, username, ID và kích thước terminal được kiểm tra ở main process. Lỗi được che
  secret và không trả stack trace. Lệnh tự động/snippet auto-run luôn hiện nguyên lệnh để xác
  nhận; các mẫu nguy hiểm có cảnh báo riêng.
- Kho tự khoá sau 15 phút không hoạt động theo mặc định (cấu hình 1–240 phút trong ⚙), đồng
  thời ngắt toàn bộ phiên và xoá khoá khỏi RAM. Đồng hồ đếm nằm ở main process, nên trang
  giao diện treo hay bị dừng cũng không giữ kho mở quá hạn.
- **Bật phiên bền thì khoá kho không còn dừng được việc từ xa.** Khoá kho vẫn ngắt hết kết nối
  SSH và xoá khoá khỏi RAM như trước, nhưng phiên tmux — kể cả shell root — vẫn chạy tiếp trên
  máy chủ cho tới khi bạn kết thúc nó. Đây là đánh đổi của tính năng, mặc định tắt, và mở bằng
  nút **Phiên trên máy chủ** để xem hoặc dừng.
- Tên phiên tmux do main process tự dựng từ tên máy chủ trong kho cộng vị trí tab/pane; renderer
  chỉ gửi hai con số. Tên tự đặt phải khớp `^[A-Za-z0-9_-]{1,32}$` — kiểm chứ không escape.
- Tham số scrypt đi kèm từng kho. Khi nâng chi phí KDF cho kho mới, kho cũ vẫn mở được bằng
  đúng tham số của nó thay vì báo nhầm "sai master password".
- Lỗi ngoài dự kiến ở main process được ghi lại và báo ra giao diện thay vì làm sập tiến trình
  và ngắt hết phiên đang mở.
- Clipboard có thể tự xoá sau 0–300 giây và chỉ bị xoá nếu nội dung chưa bị người dùng thay đổi.
- SFTP canonicalize đường dẫn POSIX trong `SFTP root`, chặn traversal, ghi file qua tên tạm và
  khôi phục bản cũ nếu replace thất bại. Local/SOCKS listener và remote forward đều chỉ bind loopback.

### Backup

Backup dùng một mật khẩu riêng tối thiểu 12 ký tự, scrypt và AES-256-GCM. File có version
schema, được xác thực trước khi nhập và bỏ qua endpoint/snippet trùng thay vì ghi đè. Password
và passphrase không nằm trong backup mặc định; chỉ được đưa vào khi người dùng chủ động bật
**Bao gồm credential**. Ứng dụng chỉ lưu đường dẫn private key, không nhúng nội dung file key.

Một điểm đánh đổi cần biết: khi kho đang mở, mật khẩu đã lưu nằm dưới dạng rõ trong bộ
nhớ tiến trình. Ai có quyền admin trên máy bạn đều đọc được. Khoá kho khi rời máy.

## Kiểm thử

```bash
npm test
```

Các phép kiểm tra được chia theo các tầng sau:

| Lệnh                    | Kiểm cái gì                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run lint`          | ESLint trên cả main (CommonJS) lẫn renderer (ES module); `npm test` chạy lint trước                                                              |
| `npm run test:platform` | Adapter Windows/Linux: home path, Unicode, separator và SSH agent                                                                                |
| `npm run test:runtime`  | Ghi log phiên không làm sập app, điều tiết dòng dữ liệu terminal, nhớ vị trí cửa sổ, tham số KDF, nhật ký chẩn đoán                              |
| `npm run test:vault`    | Mã hoá, đọc/ghi kho, đổi master password, chống rò bí mật ra đĩa                                                                                 |
| `npm run test:security` | Validation, che lỗi, phát hiện lệnh nguy hiểm, migration và backup mã hoá                                                                        |
| `npm run test:import`   | Bộ đọc `~/.ssh/config`: wildcard, thiếu trường, nhập trùng                                                                                       |
| `npm run test:utf8`     | Tiếng Việt qua đường SSH, kể cả khi gói tin bị cắt từng byte một                                                                                 |
| `npm run test:ssh`      | Dựng SSH server thật trên `127.0.0.1`: password, key thường/key có passphrase, PTY, resize và host key đổi                                       |
| `npm run test:tmux`     | Đặt tên phiên (kể cả tên máy chủ tiếng Việt), chặn 15 mẫu command injection, dựng lệnh gắn phiên; rồi qua SSH thật: probe, exec có pty, resize, đường lùi khi máy chủ không có tmux |
| `npm run test:sftp`     | Canonical path, traversal guard, CRUD, chmod, upload/download và progress                                                                        |
| `npm run test:tunnel`   | Forward TCP, port conflict, stop và teardown theo phiên SSH                                                                                      |
| `npm run test:ui`       | Chạy Electron thật: tạo kho, thêm máy chủ, tìm kiếm, bảng Ctrl+K, lệnh nhanh, hộp nhập liệu, thanh tìm terminal, khoá/mở lại                     |
| `npm run test:ime`      | Bộ gõ tiếng Việt: phím trong lúc soạn thảo, tìm không dấu, dữ liệu sống sót qua vòng khoá/mở                                                     |
| `npm run test:theme`    | Khoá các giá trị Ubuntu: accent cam, bảng Tango, nền tím cà, chữ Ubuntu Sans có glyph tiếng Việt, số đo libadwaita — chạy cả chế độ sáng lẫn tối |

Test dùng thư mục dữ liệu tạm, không đụng tới kho thật của bạn.

## Đóng gói

```bash
npm run build:win    # NSIS + portable, chạy trên Windows
npm run build:linux  # AppImage + deb, chạy trên Ubuntu
```

Bản NSIS cài cho riêng user hiện tại (không cần quyền admin) và tự tạo lối tắt ở
Desktop cùng Start menu. Bản portable chạy thẳng, không cài và không tạo lối tắt.

### Icon

Mặc định dùng icon của Electron. Muốn đóng gói kèm icon riêng
(`assets/icon.ico` cho Windows, `assets/icon.png` cho Linux) thì chạy:

```bash
npm run build:win:icon
npm run build:linux:icon
```

Asset nằm ở `assets/` chứ không phải `build/` là có chủ ý: `build/icon.ico` sẽ bị
electron-builder tự nhặt và icon riêng sẽ thành mặc định, mất luôn lựa chọn.
Muốn đổi hình, sửa `assets/icon.ico` (cần đủ các cỡ 16→256) và `assets/icon.png`
(tối thiểu 256×256).

`electron-builder` đã được khai báo trong devDependencies. Kết quả nằm trong `dist/`.

## Cấu trúc

Main process là CommonJS; renderer là ES module nạp qua `<script type="module">`,
nên mỗi màn hình nằm trong một file riêng thay vì một `app.js` khổng lồ.

```
src/main/
  main.js           cửa sổ, IPC, hộp thoại xác nhận, tự khoá, xác nhận khi thoát
  vault.js          kho kết nối và lệnh nhanh, nhập từ ~/.ssh/config
  crypto.js         scrypt + AES-256-GCM, đọc tham số KDF ghi trong kho
  validation.js     validation đầu vào, che lỗi và nhận diện lệnh nguy hiểm
  remote-path.js    canonical path và scope guard cho SFTP
  sftp-service.js   SFTP CRUD/transfer/cancel trong main process
  ssh-manager.js    kết nối ssh2, nhiều shell trên một kết nối, known_hosts, agent
  session-logs.js   ghi log phiên, mọi lỗi stream đều có người nhận
  output-pump.js    gom dữ liệu terminal theo khung và phanh dòng khi UI chậm
  window-state.js   nhớ kích thước và vị trí cửa sổ
  diagnostics.js    nhật ký chẩn đoán opt-in, che secret
  preload.js        cầu nối duy nhất giữa renderer và main
src/renderer/
  index.html        khung giao diện
  styles.css        hệ thiết kế Yaru/libadwaita
  app.js            điểm vào: icon, phím tắt toàn cục, nút cửa sổ
  core.js           state chia sẻ, toast, hộp thoại, icon, menu chuột phải, hộp nhập liệu
  lock.js           màn hình khoá, độ mạnh mật khẩu, Caps Lock
  connections.js    danh sách máy chủ và form kết nối
  sessions.js       tab, pane, terminal xterm, tìm kiếm, dashboard
  snippets.js       lệnh nhanh và biến ${TEN}
  sftp.js           trình duyệt file remote
  tunnels.js        port forwarding
  settings.js       hộp cài đặt theo tab, backup, host key
  palette.js        bảng tìm nhanh Ctrl+K
```
