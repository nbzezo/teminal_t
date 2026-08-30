# SSH Manager

Ứng dụng desktop (Electron) để lưu, truy cập nhanh và thao tác lệnh trên các máy chủ SSH.

## Chạy

```bash
npm start
```

Lần chạy đầu tiên bạn sẽ được yêu cầu đặt **master password**. Toàn bộ kho — kể cả
tên máy chủ — được mã hoá bằng khoá dẫn xuất từ mật khẩu này. **Quên là mất kho,
không có cách khôi phục.**

## Chức năng

| Việc cần làm | Cách làm |
|---|---|
| Thêm máy chủ | Nút **+ Kết nối** hoặc <kbd>Ctrl</kbd>+<kbd>N</kbd> |
| Kết nối | Bấm vào máy trong danh sách bên trái |
| Tìm và kết nối nhanh | <kbd>Ctrl</kbd>+<kbd>K</kbd>, gõ tên/host, <kbd>Enter</kbd> |
| Lọc danh sách | Ô tìm kiếm ở cột trái (khớp tên, host, user, nhóm, ghi chú) |
| Nhiều phiên cùng lúc | Mỗi lần kết nối mở một tab riêng; <kbd>Ctrl</kbd>+<kbd>Tab</kbd> để chuyển |
| Đóng phiên | <kbd>Ctrl</kbd>+<kbd>W</kbd> hoặc dấu × trên tab |
| Lệnh dùng nhiều | Lưu vào thanh **Lệnh nhanh** dưới đáy, bấm một phát là gửi vào phiên đang mở |
| Lệnh chạy tự động | Điền ô *Lệnh chạy ngay khi kết nối* trong form máy chủ |
| Lấy sẵn host có rồi | Nút **Nhập config** đọc `~/.ssh/config` |
| Khoá kho | <kbd>Ctrl</kbd>+<kbd>L</kbd> — ngắt hết phiên và xoá khoá khỏi RAM |
| Đổi master password | Nút ⚙ ở góc dưới trái |

Máy chủ được xếp theo nhóm, trong mỗi nhóm ưu tiên máy vừa dùng gần nhất.

## Xác thực

**SSH key** (khuyến nghị) — trỏ tới file private key, hoặc để trống đường dẫn thì app
tự dùng `ssh-agent` của hệ điều hành (trên Windows là `\\.\pipe\openssh-ssh-agent`).
Passphrase của key nếu có sẽ được lưu mã hoá.

**Mật khẩu** — lưu mã hoá trong kho. Tiện hơn nhưng luôn kém an toàn hơn key.

Khi sửa một máy chủ, để trống ô mật khẩu/passphrase nghĩa là **giữ nguyên** giá trị cũ.

## Bảo mật

- Kho nằm ở `%APPDATA%/sshman/vault.enc` (xem đường dẫn chính xác trong ⚙ → Thông tin).
- Mã hoá **AES-256-GCM**, khoá dẫn xuất bằng **scrypt** (N=32768, r=8, p=1). GCM phát
  hiện nếu file bị sửa. Ghi file theo kiểu ghi-tạm-rồi-đổi-tên để không hỏng kho khi mất điện.
- Khoá giải mã chỉ tồn tại trong RAM của main process. **Mật khẩu không bao giờ đi qua
  IPC sang giao diện** — renderer chỉ gửi id kết nối, main process tự tra bí mật và dùng.
- Renderer chạy với `contextIsolation: true`, `nodeIntegration: false` và một CSP chặt.
- Host key kiểm theo mô hình TOFU: lần đầu hỏi bạn xác nhận vân tay SHA256, các lần sau
  phải khớp. Vân tay đổi thì hiện cảnh báo đỏ và chặn cho tới khi bạn xác nhận lại.
  Danh sách lưu ở `known_hosts.json` cạnh kho.

Một điểm đánh đổi cần biết: khi kho đang mở, mật khẩu đã lưu nằm dưới dạng rõ trong bộ
nhớ tiến trình. Ai có quyền admin trên máy bạn đều đọc được. Khoá kho khi rời máy.

## Kiểm thử

```bash
npm test
```

73 phép kiểm tra, chia bốn tầng:

- `npm run test:vault` — mã hoá, đọc/ghi kho, đổi master password, chống rò bí mật ra đĩa.
- `npm run test:import` — bộ đọc `~/.ssh/config` (wildcard, thiếu trường, nhập trùng).
- `npm run test:ssh` — dựng SSH server thật trên `127.0.0.1` rồi kết nối vào: auth bằng
  mật khẩu và bằng key, cấp pty, gõ lệnh, đổi kích thước, cảnh báo host key đổi.
- `npm run test:ui` — chạy Electron thật, điều khiển giao diện để kiểm tra luồng tạo kho,
  thêm máy chủ, tìm kiếm, bảng Ctrl+K, lệnh nhanh, khoá/mở lại.

Test dùng thư mục dữ liệu tạm, không đụng tới kho thật của bạn.

## Đóng gói

```bash
npm run build
```

Cần cài thêm `electron-builder` (`npm i -D electron-builder`). Kết quả nằm trong `dist/`.

## Cấu trúc

```
src/main/
  main.js         cửa sổ, menu, IPC, hộp thoại xác nhận host key
  vault.js        kho kết nối và lệnh nhanh, nhập từ ~/.ssh/config
  crypto.js       scrypt + AES-256-GCM
  ssh-manager.js  phiên ssh2, known_hosts, ssh-agent
  preload.js      cầu nối duy nhất giữa renderer và main
src/renderer/
  index.html      giao diện
  styles.css      giao diện tối
  app.js          danh sách, tab, terminal xterm, lệnh nhanh, phím tắt
```
