# Hỗ trợ Windows và Ubuntu

## Phạm vi và kiến trúc

Repository thực tế dùng Electron/Node.js và xterm.js, không dùng Python/PySide6. Dự án giữ
stack hiện hữu để tránh một lần viết lại không có lý do kỹ thuật. Mục tiêu vẫn là một codebase
chạy trên Windows 10/11 và Ubuntu Desktop 22.04/24.04 LTS.

Mọi quyết định theo hệ điều hành nằm trong `src/main/platform/`:

- `base.js`: đường dẫn home, `.ssh`, mở rộng `~` và fallback chung.
- `windows.js`: named pipe của Windows OpenSSH Agent.
- `linux.js`: hành vi Linux/`SSH_AUTH_SOCK`.
- `index.js`: chọn đúng adapter một lần tại biên ứng dụng.

Đường dẫn remote không đi qua adapter này. Dữ liệu terminal SSH đến từ PTY trên máy chủ và
không phụ thuộc shell cục bộ.

## Cài đặt và chạy

Yêu cầu khi phát triển: Node.js 22 và npm.

### Windows 10/11

```powershell
npm ci
npm start
npm run build:win
```

Kết quả đóng gói gồm NSIS installer và bản portable trong `dist/`. Bản phát hành Electron
đi kèm runtime, người dùng không cần cài Node.js hay Python. OpenSSH Agent là tùy chọn; nếu
không chạy, chọn private key trực tiếp trong form kết nối.

### Ubuntu Desktop 22.04/24.04

```bash
npm ci
npm start
npm run build:linux
```

Kết quả gồm AppImage và `.deb` trong `dist/`. Electron-builder sinh desktop entry cho gói
`.deb`. Icon riêng có sẵn ở `assets/` nhưng là tuỳ chọn: `npm run build:win:icon` và
`npm run build:linux:icon` mới dùng tới, còn `build:win`/`build:linux` vẫn giữ icon mặc
định của Electron. Trên Wayland,
Electron có thể chạy native bằng `--ozone-platform-hint=auto`; nếu driver/compositor có lỗi,
đăng nhập phiên X11 hoặc chạy với `--ozone-platform=x11`.

Ubuntu Server headless không phải môi trường GUI được hỗ trợ. Test tự động dùng Xvfb; người
dùng headless cần X11/Wayland qua VNC hoặc một desktop environment.

## Terminal và phím tắt

xterm.js hiện hỗ trợ ANSI/VT, 256 màu, UTF-8, selection, scrollback, resize, phím điều khiển
và ứng dụng full-screen thông qua PTY `xterm-256color` của `ssh2`. `StringDecoder` ghép đúng
UTF-8 bị chia giữa nhiều TCP chunk. `Ctrl+C` và `Ctrl+D` được chuyển nguyên vẹn tới máy chủ;
copy/paste dùng `Ctrl+Shift+C`/`Ctrl+Shift+V`; tìm trong scrollback dùng `Ctrl+F`.

Không thay terminal vì implementation hiện tại đã là phương án xterm.js tương đương hướng
QWebEngineView + xterm.js. Dependency và chi phí đóng gói Chromium vốn đã có trong Electron.

## Ma trận kiểm thử

| Hạng mục                    | Windows 10/11 | Ubuntu 22.04/24.04 | Tự động hóa hiện có                                      |
| --------------------------- | ------------: | -----------------: | -------------------------------------------------------- |
| Khởi động ứng dụng          |      Bắt buộc |           Bắt buộc | Electron UI test, CI 3 runner                            |
| Giao diện, DPI, theme, font |      Bắt buộc |           Bắt buộc | theme/UI test; DPI cần kiểm thủ công                     |
| SSH mật khẩu                |      Bắt buộc |           Bắt buộc | SSH server loopback thật                                 |
| SSH private key             |      Bắt buộc |           Bắt buộc | Ed25519 loopback                                         |
| SSH Agent                   |    Nếu hỗ trợ |         Nếu hỗ trợ | unit test adapter; thủ công với agent thật               |
| Terminal tương tác          |      Bắt buộc |           Bắt buộc | PTY/input/resize/UTF-8 tự động; app full-screen thủ công |
| Split terminal 1–4 pane     |      Bắt buộc |           Bắt buộc | UI/lifecycle test; cần thử resize trên máy thật          |
| Dashboard Linux            |      Bắt buộc |           Bắt buộc | Parser unit test; cần thử nhiều distro                   |
| SFTP upload/download        |      Bắt buộc |           Bắt buộc | Mock integration đạt; cần test máy Ubuntu thật           |
| Jump Host                   |      Bắt buộc |           Bắt buộc | Loopback integration đạt                                 |
| Port forwarding             |      Bắt buộc |           Bắt buộc | Mock TCP integration đạt; cần test máy thật              |
| Import/export cấu hình      |      Bắt buộc |           Bắt buộc | Backup/import mã hóa round-trip đạt                      |
| Đóng gói                    |      Bắt buộc |           Bắt buộc | CI build NSIS/portable/AppImage/deb                      |

## GAP Analysis

| Thành phần                  | Windows                         | Ubuntu                    | Vấn đề hiện tại                                         | Thay đổi cần thiết                                        | Trạng thái kiểm chứng                                          |
| --------------------------- | ------------------------------- | ------------------------- | ------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| Code dùng chung             | Có                              | Có                        | Stack là Electron, không phải PySide6 như mô tả đầu vào | Không viết lại; duy trì API Electron/Node đa nền tảng     | Rà source + test Windows                                       |
| Đường dẫn/config/cache      | `app.getPath('userData')`       | `app.getPath('userData')` | Trước đây mở rộng `~` rải trong SSH/vault               | Đã gom vào platform adapter; không hard-code ổ đĩa/home   | Unit test mô phỏng hai OS                                      |
| SSH password/key/passphrase | Có                              | Có                        | Cần xác nhận thực tế trên Ubuntu                        | Chạy CI và checklist trên máy Ubuntu                      | Password/key test thực tế trên Windows; Ubuntu chờ CI/máy thật |
| SSH Agent                   | Named pipe hoặc `SSH_AUTH_SOCK` | `SSH_AUTH_SOCK`           | Availability tùy dịch vụ/session desktop                | Fallback chọn key đã có                                   | Unit test adapter; chưa test agent thật                        |
| Terminal xterm.js           | Có                              | Có                        | Chưa tự động hóa `vim/top/less` và IME Linux thật       | Test thủ công full-screen, clipboard, GNOME/KDE           | PTY/resize/UTF-8/UI test trên Windows                          |
| Split terminal              | Có, tối đa 4 pane               | Có, tối đa 4 pane         | Cần thử compositor/DPI Ubuntu thật                      | Grid responsive, PTY resize từng pane                     | UI/source test Windows                                        |
| Dashboard Linux             | Có qua SSH                      | Có qua SSH                | Remote Windows/BSD chưa hỗ trợ                          | Fixed read-only probe `/proc` + `df`, timeout/output cap  | Parser/collector unit test đạt                                |
| Phím tắt                    | Có                              | Có                        | Clipboard phụ thuộc quyền clipboard desktop             | Kiểm thủ công GNOME/KDE; giữ Ctrl+C/Ctrl+D cho PTY        | Source + UI/IME test                                           |
| Theme/font/DPI              | Có                              | Có                        | Frameless window/compositor và scaling cần máy thật     | Test 100/125/150/200%, GNOME Wayland/X11, KDE             | Theme test Windows; Ubuntu chờ CI/máy thật                     |
| System tray/notification    | Không                           | Không                     | Chưa có tính năng; không ảnh hưởng startup              | Chỉ triển khai khi có yêu cầu sản phẩm                    | Rà source                                                      |
| SFTP/quyền remote           | Có                              | Có                        | Chưa kiểm máy Ubuntu thật/drag-drop/quick edit          | POSIX scope guard, CRUD, transfer, chmod                  | Unit/mock integration đạt                                      |
| Jump Host/ProxyJump         | Có                              | Có                        | Cần kiểm máy Ubuntu thật                                | Một tầng qua `forwardOut`, host-key verification từng hop | Loopback integration đạt                                       |
| Port forwarding             | Có                              | Có                        | Cần kiểm firewall/IPv6 trên máy thật                    | Local/remote/dynamic loopback-only và teardown theo phiên | Mock TCP integration đạt                                       |
| Shell cục bộ                | Không dùng                      | Không dùng                | Không có chức năng chạy local command                   | Giữ tách biệt khỏi remote PTY                             | Rà source                                                      |
| Storage/migration           | Vault JSON mã hóa               | Vault JSON mã hóa         | Chưa kiểm restore chéo trên Ubuntu thật                 | Backup mã hóa schema v4, import dedupe                    | Round-trip test đạt                                            |
| Background/teardown         | Event-driven                    | Event-driven              | Cần soak test khi đóng trong lúc đang kết nối           | Theo dõi mọi client/stream, disconnect ở lock/quit        | Unit/integration test Windows                                  |
| Đóng gói                    | NSIS + portable                 | AppImage + deb            | Chưa ký số; icon riêng là tuỳ chọn, không bật mặc định  | Code signing Windows, kiểm install sạch                   | NSIS + portable build đạt trên máy hiện tại (v1.1.0)          |

Jump Host và ba chế độ Port Forwarding đã đạt kiểm thử loopback; chưa được coi là đã xác minh
đa nền tảng cho tới khi chạy trên máy thật của cả Windows và Ubuntu.

## Trạng thái kiểm chứng ngày 2026-08-31

- **Windows (máy hiện tại):** sau đợt rà soát 2, `npm test` đạt 211/211 và `npm run lint` sạch.
  Renderer đã tách thành ES module nạp qua `<script type="module">` — Electron cho phép module
  script trên `file://`, đã kiểm chứng bằng chính bộ test Electron.
- **Đóng gói v1.1.0 (máy hiện tại):** `npm run build:win` chạy trọn vẹn, sinh cả
  `SSH Manager-1.1.0-windows-x64-setup.exe` lẫn bản portable. Lỗi cache NSIS (`EPERM`)
  của đợt trước không còn: electron-builder tự phát hiện cache hỏng và giải nén lại.
  Bản đóng gói đã được kiểm chứng riêng — nạp `main.js` từ trong `app.asar` rồi soi
  renderer: preload, xterm, font và các ES module đều nạp đúng, không lỗi console.
- **Windows (đợt trước):** `npm test` đạt 167/167; bản unpacked được tạo thành công tại
  `dist/win-unpacked`.
- **Linux (đã chạy thật, v1.1.0):** toàn bộ 211 phép kiểm tra chạy trên Ubuntu thật với
  Node 22 và Electron 44 — 121 test thuần Node cùng 90 test Electron, không lỗi nào. Hai
  khác biệt nền tảng phát hiện được và đã xử lý:
  - Electron không tự mang theo NSS và ALSA. Trên Ubuntu sạch, binary chết ngay với
    `libnspr4.so: cannot open shared object file` trước khi chạy được dòng test nào.
    Workflow CI nay cài `libnss3`, `libnspr4` và `libasound2t64`/`libasound2` trước khi test.
  - `BrowserWindow.isMinimized()` và `isMaximized()` phản ánh trạng thái do window manager
    quản lý. `xvfb` không chạy window manager nào nên các giá trị đó không bao giờ đúng ở
    đó. `ui.test.js` nay khẳng định đường đi từ nút qua IPC tới `BrowserWindow` ở mọi nền
    tảng, còn trạng thái thật chỉ khẳng định trên Windows/macOS.
- **CI:** job Windows xanh từ trước. Hai job Ubuntu đỏ liên tục kể cả ở các commit trước
  đợt rà soát; nguyên nhân là hai điểm ở trên chứ không phải lỗi logic đa nền tảng.
- Build dùng JavaScript fallback đã được kiểm thử của `ssh2`; `npmRebuild: false` tránh cố
  biên dịch addon tăng tốc `cpu-features` không bắt buộc, vốn dễ lỗi khi workspace Windows có
  khoảng trắng. Cần giữ SSH integration test trong CI để bảo vệ fallback này.

## Checklist thủ công bắt buộc

Trên mỗi Windows 10, Windows 11, Ubuntu 22.04 GNOME và Ubuntu 24.04 GNOME (thêm KDE nếu hỗ trợ):

1. Cài bản artifact sạch, khởi động, tạo/khóa/mở vault có tên Unicode và khoảng trắng.
2. Kiểm layout/theme ở light/dark và scaling 100%, 125%, 150%, 200%; đổi kích thước/maximize.
3. Kết nối bằng password, key không passphrase, key có passphrase và agent; thử agent tắt.
4. Đối chiếu host key lần đầu và xác nhận host-key-changed bị cảnh báo.
5. Chạy `top`, `htop`, `vim`, `nano`, `less`; thử arrow, Tab, Ctrl+C, Ctrl+D và resize.
6. Thử copy/paste Unicode, selection, scrollback, `Ctrl+F`, IME tiếng Việt.
7. Mở nhiều phiên, khóa vault và thoát khi đang kết nối; xác nhận không còn process treo.
8. Trên Ubuntu thử Wayland và X11; xác nhận app vẫn chạy khi không có tray extension.
9. Khi SFTP/Jump Host/forwarding/export được triển khai, chạy riêng toàn bộ dòng tương ứng
   trong ma trận trước khi đổi trạng thái GAP.
