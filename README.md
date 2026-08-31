# SSH Manager

Ứng dụng desktop (Electron) để lưu, truy cập nhanh và thao tác lệnh trên các máy chủ SSH.
Giao diện lấy cảm hứng từ Yaru/libadwaita và hỗ trợ Windows 10/11 cùng Ubuntu Desktop
22.04/24.04 LTS. Xem [hướng dẫn và GAP Analysis đa nền tảng](docs/CROSS_PLATFORM.md).

## Chạy

```bash
npm start
```

Lần chạy đầu tiên bạn sẽ được yêu cầu đặt **master password**. Toàn bộ kho — kể cả
tên máy chủ — được mã hoá bằng khoá dẫn xuất từ mật khẩu này. **Quên là mất kho,
không có cách khôi phục.**

## Chức năng

| Việc cần làm            | Cách làm                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Thêm máy chủ            | Nút **+ Kết nối** hoặc <kbd>Ctrl</kbd>+<kbd>N</kbd>                                                                    |
| Kết nối                 | Bấm vào máy trong danh sách bên trái                                                                                   |
| Tìm và kết nối nhanh    | <kbd>Ctrl</kbd>+<kbd>K</kbd>, gõ tên/host, <kbd>Enter</kbd>                                                            |
| Lọc danh sách           | Ô tìm kiếm ở cột trái (khớp tên, host, user, nhóm, ghi chú)                                                            |
| Nhiều phiên cùng lúc    | Mỗi lần kết nối mở một tab riêng; <kbd>Ctrl</kbd>+<kbd>Tab</kbd> để chuyển                                             |
| Chia terminal           | Nút **▥/⬒** hoặc <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E/O</kbd>; tối đa 4 pane độc lập trong một workspace             |
| Đóng phiên              | <kbd>Ctrl</kbd>+<kbd>W</kbd> hoặc dấu × trên tab                                                                       |
| Lệnh dùng nhiều         | Lưu/tìm theo tên, nhóm hoặc nội dung ở thanh **Lệnh nhanh**; hỗ trợ biến `${name}` và điền trước khi gửi               |
| Lệnh chạy tự động       | Điền ô _Lệnh chạy ngay khi kết nối_ trong form máy chủ                                                                 |
| Lấy sẵn host có rồi     | Nút **Nhập config** đọc `~/.ssh/config`                                                                                |
| Phân loại môi trường    | Chọn Development/Staging/Production; Production luôn cảnh báo trước khi kết nối                                        |
| Sao chép cấu hình       | Mở form sửa rồi chọn **Sao chép**; credential vẫn nằm trong vault mã hoá                                               |
| Sao chép trong terminal | Nút **⧉**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> hoặc <kbd>Ctrl</kbd>+<kbd>Insert</kbd>; clipboard native Unicode |
| Dán vào terminal        | Nút **▣**, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> hoặc <kbd>Shift</kbd>+<kbd>Insert</kbd>; bracketed paste        |
| Tìm trong terminal      | <kbd>Ctrl</kbd>+<kbd>F</kbd>                                                                                           |
| Khoá kho                | <kbd>Ctrl</kbd>+<kbd>L</kbd> — ngắt hết phiên và xoá khoá khỏi RAM                                                     |
| Đổi master password     | Nút ⚙ trên thanh tiêu đề                                                                                               |
| Backup/khôi phục        | ⚙ → **Backup mã hoá**; credential không được xuất mặc định                                                             |
| Quản lý host key        | ⚙ → **Host key đã tin cậy** để xem fingerprint hoặc quên một mục                                                       |
| Quản lý file SFTP       | Kết nối SSH rồi chọn nút **⇄**: duyệt, upload/download, tạo thư mục, đổi tên, chmod và xoá có xác nhận                 |
| Port forwarding         | Nút **↔** hỗ trợ Local, Remote và SOCKS5 Dynamic; đều bind loopback và tự đóng theo phiên                              |
| Jump host               | Chọn một cấu hình đã lưu trong ô **Jump host**; mỗi hop xác minh host key độc lập                                      |
| Ghi log phiên           | Chọn nút **●** trong phiên; luôn có cảnh báo dữ liệu nhạy cảm và mặc định tắt                                          |
| Tự kết nối lại          | Bật trong cấu hình máy chủ; retry 1/2/4 giây, tối đa 3 lần và không chạy lại `onConnect`                               |
| Tuỳ chỉnh terminal      | ⚙ → chọn font, cỡ chữ và màu nền; áp dụng ngay cho các tab đang mở                                                     |
| Dashboard máy chủ       | Nút **◴** trong phiên đã kết nối; CPU/RAM/disk/uptime/load tự làm mới mỗi 10 giây, chỉ đọc và không cài agent           |

Máy chủ được xếp theo nhóm, trong mỗi nhóm ưu tiên máy vừa dùng gần nhất.

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
  thời ngắt toàn bộ phiên và xoá khoá khỏi RAM.
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
| `npm run test:platform` | Adapter Windows/Linux: home path, Unicode, separator và SSH agent                                                                                |
| `npm run test:vault`    | Mã hoá, đọc/ghi kho, đổi master password, chống rò bí mật ra đĩa                                                                                 |
| `npm run test:security` | Validation, che lỗi, phát hiện lệnh nguy hiểm, migration và backup mã hoá                                                                        |
| `npm run test:import`   | Bộ đọc `~/.ssh/config`: wildcard, thiếu trường, nhập trùng                                                                                       |
| `npm run test:utf8`     | Tiếng Việt qua đường SSH, kể cả khi gói tin bị cắt từng byte một                                                                                 |
| `npm run test:ssh`      | Dựng SSH server thật trên `127.0.0.1`: password, key thường/key có passphrase, PTY, resize và host key đổi                                       |
| `npm run test:sftp`     | Canonical path, traversal guard, CRUD, chmod, upload/download và progress                                                                        |
| `npm run test:tunnel`   | Forward TCP, port conflict, stop và teardown theo phiên SSH                                                                                      |
| `npm run test:ui`       | Chạy Electron thật, điều khiển giao diện: tạo kho, thêm máy chủ, tìm kiếm, bảng Ctrl+K, lệnh nhanh, khoá/mở lại                                  |
| `npm run test:ime`      | Bộ gõ tiếng Việt: phím trong lúc soạn thảo, tìm không dấu, dữ liệu sống sót qua vòng khoá/mở                                                     |
| `npm run test:theme`    | Khoá các giá trị Ubuntu: accent cam, bảng Tango, nền tím cà, chữ Ubuntu Sans có glyph tiếng Việt, số đo libadwaita — chạy cả chế độ sáng lẫn tối |

Test dùng thư mục dữ liệu tạm, không đụng tới kho thật của bạn.

## Đóng gói

```bash
npm run build:win    # NSIS + portable, chạy trên Windows
npm run build:linux  # AppImage + deb, chạy trên Ubuntu
```

`electron-builder` đã được khai báo trong devDependencies. Kết quả nằm trong `dist/`.

## Cấu trúc

```
src/main/
  main.js         cửa sổ, menu, IPC, hộp thoại xác nhận host key
  vault.js        kho kết nối và lệnh nhanh, nhập từ ~/.ssh/config
  crypto.js       scrypt + AES-256-GCM
  validation.js   validation đầu vào, che lỗi và nhận diện lệnh nguy hiểm
  remote-path.js  canonical path và scope guard cho SFTP
  sftp-service.js SFTP CRUD/transfer/cancel trong main process
  ssh-manager.js  phiên ssh2, known_hosts, ssh-agent
  preload.js      cầu nối duy nhất giữa renderer và main
src/renderer/
  index.html      giao diện
  styles.css      giao diện tối
  app.js          danh sách, tab, terminal xterm, lệnh nhanh, phím tắt
```
