# Báo cáo rà soát bảo mật và tính năng

Ngày rà soát: 2026-08-31. Phạm vi: mã nguồn hiện tại, cấu hình build, README và test cục bộ.
Không sử dụng credential thật, không kết nối ra ngoài và không chạy lệnh trên server Production.

## Kiến trúc hiện tại

- Electron/Node.js thuần JavaScript, renderer HTML/CSS/xterm.js; không thay đổi framework.
- `src/main/main.js` là composition root, dựng `BrowserWindow`, hộp thoại và IPC allowlist.
- `src/main/vault.js` lưu JSON đã mã hoá toàn khối bằng scrypt + AES-256-GCM tại Electron
  `userData`; payload schema v4 tự migration từ dữ liệu cũ không có schema.
- `src/main/ssh-manager.js` dùng `ssh2.Client`, PTY tương tác, SSH Agent theo platform adapter
  và TOFU host-key verification trong `known_hosts.json`.
- `src/main/preload.js` là API duy nhất cho renderer; `sandbox`, `contextIsolation` bật và
  `nodeIntegration` tắt. Renderer không nhận password/passphrase đã lưu.
- Baseline trước sửa: `npm test` đạt 126/126. Sau đợt rà soát 1 đạt 177/177. Sau đợt rà soát 2
  (xem cuối tài liệu) đạt **211/211** cộng `npm run lint` sạch, gồm unit,
  SSH/jump-host loopback, TCP forwarding, Electron UI, IME và theme sáng/tối.

## Ma trận tính năng

Trạng thái phản ánh chức năng chạy được và test, không suy luận từ tên nút/file.

| Nhóm | Tính năng                                  | Trạng thái                            | Bằng chứng trong mã nguồn / kiểm thử                                                                         | Mức ưu tiên | Rủi ro                                              | Đề xuất                                                          |
| ---- | ------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| A    | Thêm/sửa/xóa/sao chép máy chủ              | Đã hoàn chỉnh.                        | `Vault.saveConnection/deleteConnection/duplicateConnection`; renderer form; `vault.test.js`                  | P1          | Xóa nhầm                                            | Xóa có confirm; thêm UI test cho sao chép khi GPU runner ổn định |
| A    | Tên, host/IP, port, username, auth         | Đã hoàn chỉnh.                        | `validation.js`; `Vault.saveConnection`; `security.test.js`                                                  | P0          | Input sai/SSRF ngoài ý muốn                         | Giữ validation tại main process                                  |
| A    | Thư mục làm việc mặc định                  | Đã hoàn chỉnh.                        | `SshManager.connect` sinh `cd -- '<escaped>'`; integration test có dấu nháy đơn                              | P2          | Command injection nếu quote sai                     | POSIX shell quoting; không nội suy ẩn                            |
| A    | Nhóm, tag, màu, ghi chú                    | Đã hoàn chỉnh.                        | Schema v2, form và tìm kiếm trong `app.js`                                                                   | P2          | Dữ liệu quá dài                                     | Giới hạn độ dài/số tag tại vault                                 |
| A    | Tìm kiếm, lọc, sắp xếp                     | Đã hoàn chỉnh.                        | `matchesFilter`, `sortConnections`, Ctrl+K; `ui.test.js`, `ime.test.js` baseline                             | P1          | Không đáng kể                                       | Bổ sung sort selector nếu cần                                    |
| A    | Yêu thích                                  | Đã hoàn chỉnh.                        | `favorite` trong vault/form; ưu tiên trong `sortConnections`                                                 | P2          | Không đáng kể                                       | —                                                                |
| A    | Development/Staging/Production và cảnh báo | Đã hoàn chỉnh.                        | `environment` schema/form; confirm bắt buộc trong IPC `ssh:open`                                             | P0          | Thao tác nhầm Production                            | Giữ confirm ở main, không chỉ renderer                           |
| B    | SSH bằng password                          | Đã hoàn chỉnh.                        | `SshManager._buildConfig`; loopback `ssh.test.js`                                                            | P1          | Lộ credential                                       | Secret chỉ lấy từ vault trong main                               |
| B    | Private key, có/không passphrase           | Đã hoàn chỉnh.                        | `_buildConfig`; test Ed25519 thường và encrypted key                                                         | P1          | Lộ key/passphrase                                   | Không trả passphrase về renderer                                 |
| B    | SSH Agent                                  | Có nhưng chưa hoàn chỉnh.             | Platform adapters và `platform.test.js`; chưa test agent thật                                                | P2          | Sai khác OS/session                                 | Test thủ công Windows/Linux agent thật                           |
| B    | Nhiều phiên bằng tab                       | Đã hoàn chỉnh.                        | `state.sessions`, xterm pane/tab; SSH/UI tests                                                               | P1          | Rò phiên khi khóa                                   | `lockVault` và `disconnectAll` dọn phiên                         |
| B    | Tự kết nối lại                             | Đã hoàn chỉnh.                        | Opt-in per connection; backoff 1/2/4 giây, tối đa 3; IPC reconnect xóa `onConnect`                           | P2          | Replay command                                      | Không replay lệnh; đóng tab hủy timer                            |
| B    | Timeout và keep-alive                      | Đã hoàn chỉnh.                        | Schema/form; clamp trong `_buildConfig`                                                                      | P1          | Treo kết nối/DoS                                    | Bổ sung UI presets sau                                           |
| B    | Jump host/ProxyJump                        | Đã hoàn chỉnh.                        | Một tầng `ssh2.Client.forwardOut` + `sock`; host verifier độc lập từng hop; loopback integration test        | P2          | Chuỗi hop sai/lộ credential                         | Giới hạn một tầng, secret chỉ ở main process                     |
| B    | Lịch sử kết nối gần đây                    | Có nhưng chưa hoàn chỉnh.             | `lastUsedAt/useCount`, sort; chưa có màn lịch sử                                                             | P2          | Metadata nhạy cảm                                   | Giữ trong vault; thêm view/xóa lịch sử                           |
| B    | Trạng thái kết nối                         | Đã hoàn chỉnh.                        | `connecting/connected/error/closed/ended/gone`; tabs/toast                                                   | P1          | Thông báo lỗi lộ secret                             | `safeErrorMessage` trước khi trả UI                              |
| B    | Chủ động ngắt kết nối                      | Đã hoàn chỉnh.                        | Tab close/Ctrl+W → `ssh:close`; integration test                                                             | P1          | Phiên treo                                          | `disconnectAll` khi lock/quit                                    |
| C    | Terminal tích hợp, nhiều tab               | Đã hoàn chỉnh.                        | xterm + Fit/Search addon; UI/SSH/UTF-8 tests                                                                 | P1          | Escape sequence không tin cậy                       | xterm xử lý; không render terminal bằng HTML                     |
| C    | Chia cửa sổ                                | Đã hoàn chỉnh.                        | Workspace grid 1–4 pane, mỗi pane có kết nối SSH/PTY/focus/resize/cleanup độc lập; pane trong một tab có thể ở các máy chủ khác nhau; Ctrl+Shift+E/O                         | P3          | Mỗi pane là một phiên SSH thật nên tải máy chủ tăng theo số pane | Giới hạn 4 pane; không broadcast input; vẫn có lối dùng chung kết nối (Ctrl+Shift+D) |
| C    | Font/cỡ/màu/theme tùy chỉnh                | Đã hoàn chỉnh.                        | Font/cỡ/màu nền lưu trong vault settings; UI theme tự theo light/dark hệ thống                               | P2          | Không đáng kể                                       | Có thể thêm palette preset sau                                   |
| C    | Copy/paste/tìm kiếm/Unicode/shortcut       | Đã hoàn chỉnh.                        | `app.js`; UTF-8, IME, UI, theme tests; clipboard auto-clear                                                  | P1          | Clipboard chứa secret                               | Clear chỉ khi clipboard chưa đổi                                 |
| C    | Ghi log phiên opt-in                       | Đã hoàn chỉnh.                        | Main-process stream, warning bắt buộc, mode 0600, teardown theo phiên                                        | P2          | Log chứa secret                                     | Mặc định tắt; người dùng tự bảo vệ file log                      |
| D    | Import SSH key                             | Có nhưng chưa hoàn chỉnh.             | Chọn đường dẫn/key từ ssh config; không copy vào managed store                                               | P1          | Key path mất/permission sai                         | Thêm key metadata store, không hiển thị nội dung                 |
| D    | Tạo/quản lý public-private key/fingerprint | Chưa có.                              | Không có key service/UI                                                                                      | P2          | Thuật toán yếu/xóa nhầm                             | Dùng `ssh-keygen` qua `execFile`, Ed25519 mặc định               |
| D    | Một key cho nhiều máy chủ                  | Đã hoàn chỉnh.                        | Nhiều record có thể dùng cùng `privateKeyPath`                                                               | P1          | Thay key ảnh hưởng nhiều host                       | Hiển thị usage count khi có key manager                          |
| D    | Key có passphrase                          | Đã hoàn chỉnh.                        | Vault mã hoá + SSH test encrypted key                                                                        | P1          | Passphrase trong RAM                                | Wipe bản sao khi session đóng                                    |
| D    | Ngày tạo/thông tin dùng key                | Chưa có.                              | Chỉ connection có timestamp                                                                                  | P2          | Khó rotation                                        | Key entity riêng và usage relation                               |
| D    | Xóa/thay thế key an toàn                   | Chưa có.                              | App không quản lý file key                                                                                   | P2          | Mất quyền truy cập                                  | Backup public key, confirm usage impact                          |
| D    | Không lưu secret plain text                | Đã hoàn chỉnh.                        | Vault AES-GCM; disk leakage tests                                                                            | P0          | Credential disclosure                               | Giữ atomic write và file mode                                    |
| D    | OS credential store                        | Chưa có.                              | Không có Credential Manager/Keychain/Secret Service                                                          | P2          | Master password phishing/memory dump                | Thêm adapter OS; giữ encrypted vault fallback                    |
| D    | Fallback mã hóa không hard-code key        | Đã hoàn chỉnh.                        | `crypto.js`: random salt, scrypt, AES-256-GCM                                                                | P0          | Offline brute force                                 | Cân nhắc Argon2id khi có migration/KDF dependency ổn định        |
| D    | Không hiển thị private key                 | Đã hoàn chỉnh.                        | Chỉ hiển thị path; backup không nhúng file                                                                   | P0          | Key disclosure                                      | —                                                                |
| E    | Host key verification/TOFU                 | Đã hoàn chỉnh.                        | `hostVerifier`, SHA256 fingerprint; `ssh.test.js`                                                            | P0          | MITM                                                | Không thêm tùy chọn “bỏ qua”                                     |
| E    | Xác nhận lần đầu/lưu trusted key           | Đã hoàn chỉnh.                        | `confirmHostKey`; `KnownHosts.set`; integration test                                                         | P0          | Tin nhầm host                                       | Hướng dẫn đối chiếu out-of-band                                  |
| E    | Cảnh báo khi fingerprint đổi               | Đã hoàn chỉnh.                        | Dialog severity warning; changed-key integration test                                                        | P0          | MITM                                                | Main process chặn mặc định                                       |
| E    | Xem/quản lý trusted keys                   | Đã hoàn chỉnh.                        | Settings `known-hosts-list`; `KnownHosts.list/forget`                                                        | P1          | Quên nhầm key                                       | Có confirm trước khi quên                                        |
| F    | Duyệt local/remote, upload/download        | Đã hoàn chỉnh.                        | `SftpService`, file dialogs, progress; `sftp.test.js`                                                        | P1          | Path traversal/overwrite                            | Local browse dùng native dialog; transfer ghi qua file tạm       |
| F    | Progress/cancel/retry/drag-drop            | Có nhưng chưa hoàn chỉnh.             | Transfer ID, progress callback và cancel đã có; retry/drag-drop chưa có                                      | P2          | Task mồ côi                                         | Thêm queue retry và validated drop target                        |
| F    | Mkdir/rename/delete/chmod                  | Đã hoàn chỉnh.                        | SFTP UI/API; delete confirmation; scope guard                                                                | P2          | Mất dữ liệu                                         | Move khác thư mục và quick-edit vẫn ở backlog                    |
| F    | Chống path traversal/phạm vi               | Đã hoàn chỉnh.                        | `remote-path.js`, configured `sftpRoot`, traversal tests                                                     | P0          | Truy cập ngoài scope                                | Không tin path từ renderer                                       |
| G    | Lưu snippet                                | Đã hoàn chỉnh.                        | Vault + renderer CRUD                                                                                        | P1          | Command nguy hiểm                                   | Default auto-run đã đổi thành false                              |
| G    | Nhóm/tìm kiếm snippet                      | Đã hoàn chỉnh.                        | Search theo tên/nhóm/nội dung trong thanh snippet                                                            | P2          | Không đáng kể                                       | Có thể nâng thành panel khi danh sách rất lớn                    |
| G    | Biến `${name}`                             | Đã hoàn chỉnh.                        | Parser tên biến giới hạn; prompt từng giá trị, chặn newline/NUL; auto-run preview lệnh đã render             | P2          | Injection qua biến                                  | Giá trị là shell text chủ ý và luôn preview trước auto-run       |
| G    | Preview trước khi chạy                     | Đã hoàn chỉnh.                        | Confirm dialog hiển thị nguyên command khi auto-run                                                          | P0          | Chạy nhầm                                           | Không cho dialog default “Đồng ý”                                |
| G    | Xác nhận lệnh nguy hiểm                    | Đã hoàn chỉnh.                        | `inspectCommand`; `security.test.js`; warning riêng                                                          | P0          | Mất dữ liệu remote                                  | Pattern chỉ là defense-in-depth, không thay review người dùng    |
| G    | Không tự chạy lệnh AI                      | Đã hoàn chỉnh.                        | Không tích hợp AI; mọi auto-run có confirm                                                                   | P0          | Remote code execution                               | Duy trì invariant nếu thêm AI                                    |
| G    | Lịch sử thực thi đã che secret             | Chưa có.                              | Không có execution history                                                                                   | P2          | Secret trong history                                | Structured record + redaction, opt-out                           |
| G    | Chạy đa máy có kiểm soát                   | Chưa có.                              | Không có broadcast executor                                                                                  | P3          | Blast radius lớn                                    | Batch preview, concurrency cap, Production gate                  |
| H    | Local forwarding                           | Đã hoàn chỉnh.                        | `startLocalTunnel`, persistent config/UI; `tunnel.test.js`                                                   | P1          | Port exposure, leaked listener                      | Chỉ bind loopback; teardown gắn session                          |
| H    | Remote/dynamic forwarding                  | Đã hoàn chỉnh.                        | `forwardIn` và SOCKS5 CONNECT no-auth; loopback-only; `tunnel.test.js`                                       | P2          | Public exposure/proxy abuse                         | Không cho bind public                                            |
| H    | Lưu/bật/tắt/status/conflict/teardown       | Đã hoàn chỉnh.                        | Vault config, UI, registry và cleanup theo session; conflict test                                            | P1          | Port conflict/tunnel mồ côi                         | Duy trì teardown regression test                                 |
| I    | CPU/RAM/disk/uptime/load                   | Đã hoàn chỉnh cho Linux.              | Command cố định chỉ đọc, timeout 5s, cap 64KB; dashboard refresh 10s; `metrics.test.js`                       | P2          | Tạo tải/rò thông tin                                | Không sudo/agent; OS không có `/proc` báo không hỗ trợ           |
| I    | Service/Docker status                      | Chưa có.                              | Không có probe/parser                                                                                        | P3          | Quyền cao/khác OS                                   | Adapter capability detection; không cài agent                    |
| J    | Export/import servers/tags/notes/snippets  | Đã hoàn chỉnh.                        | Encrypted backup v1; `backup.test.js`                                                                        | P1          | Ghi đè/malformed input                              | Validate toàn bộ trước commit, skip duplicate                    |
| J    | Tunnel config trong backup                 | Đã hoàn chỉnh.                        | Tunnel nằm trong connection payload được backup/migration cùng schema v4                                     | P2          | Mất cấu hình                                        | Giữ round-trip migration test                                    |
| J    | Tùy chọn credential                        | Đã hoàn chỉnh.                        | `includeCredentials` false mặc định; UI switch                                                               | P0          | Credential disclosure                               | Password backup riêng >=12 ký tự                                 |
| J    | Không export private key mặc định          | Đã hoàn chỉnh.                        | Không bao giờ đọc/nhúng file key; chỉ metadata path                                                          | P0          | Private-key disclosure                              | Giữ invariant trong test                                         |
| J    | Backup credential mã hóa mạnh              | Đã hoàn chỉnh.                        | scrypt + AES-256-GCM; wrong-password/tamper tests                                                            | P0          | Offline brute force                                 | Cho phép nâng KDF qua version sau                                |
| J    | Validate/tránh overwrite/schema migration  | Đã hoàn chỉnh.                        | `importEncryptedBackup`, endpoint dedupe, payload schema v4 tests                                            | P0          | Mất dữ liệu                                         | Thêm dry-run diff ở P2                                           |
| K    | Khóa app bằng mật khẩu                     | Đã hoàn chỉnh.                        | Master password vault; Ctrl+L; UI/vault tests baseline                                                       | P0          | Truy cập trái phép                                  | OS biometric là P2                                               |
| K    | Tự khóa khi idle                           | Đã hoàn chỉnh.                        | `scheduleAutoLock`, settings 1–240 phút                                                                      | P0          | Vault mở khi rời máy                                | Thêm suspend/session-lock hook theo OS                           |
| K    | Không ghi credential vào log               | Đã hoàn chỉnh.                        | Không có log secret; `safeErrorMessage`; disk tests                                                          | P0          | Credential disclosure                               | Thêm automated log-capture regression test                       |
| K    | Che secret trên UI                         | Đã hoàn chỉnh.                        | `_safe` loại password/passphrase; input type password                                                        | P0          | Shoulder surfing/DOM leak                           | Không thêm reveal mặc định                                       |
| K    | Xóa clipboard sau timeout                  | Đã hoàn chỉnh.                        | Settings 0–300 giây; renderer so sánh trước khi clear                                                        | P2          | Secret lưu clipboard                                | Mặc định 30 giây                                                 |
| K    | Validation toàn bộ input nhạy cảm          | Đã hoàn chỉnh.                        | `validation.js`, vault/SSH/IPC caps; tests                                                                   | P0          | Injection/DoS                                       | Mở rộng schema validator khi có SFTP/tunnel                      |
| K    | Chống command injection                    | Đã hoàn chỉnh trong phạm vi hiện tại. | Không gọi local shell; default directory được quote; auto-run preview/confirm; variable chặn control newline | P0          | Lệnh remote do người dùng chủ ý vẫn có thể phá hoại | Duy trì exact preview và Production gate                         |
| K    | Chống path traversal                       | Không phù hợp với kiến trúc hiện tại. | Không có file API                                                                                            | P0          | Tương lai khi thêm SFTP                             | Canonicalize tại main, không tin renderer                        |
| K    | Không nối chuỗi lệnh SSH không an toàn     | Có nhưng chưa hoàn chỉnh.             | Input gửi thẳng PTY; `onConnect` thêm newline sau confirm                                                    | P0          | Shell semantics                                     | Người dùng phải thấy exact command; không ghép biến ẩn           |
| K    | Dependency không có CVE nghiêm trọng       | Đã hoàn chỉnh tại thời điểm rà soát.  | `npm audit --omit=dev`: 0 vulnerability ngày 2026-08-31                                                      | P0          | Supply-chain thay đổi theo thời gian                | Chạy audit/SBOM định kỳ trong CI                                 |
| K    | Error handling không lộ stack/secret       | Đã hoàn chỉnh.                        | IPC wrapper + `safeErrorMessage`; security test                                                              | P0          | Secret disclosure                                   | Giữ stack chỉ trong test/dev nội bộ                              |
| K    | CSP Electron                               | Đã hoàn chỉnh.                        | Meta CSP trong `index.html`; chỉ `style-src unsafe-inline` cho xterm runtime                                 | P0          | XSS                                                 | Không nạp remote script/style                                    |
| K    | `nodeIntegration` off, sandbox on          | Đã hoàn chỉnh.                        | `BrowserWindow.webPreferences`; preload/UI test baseline                                                     | P0          | Renderer RCE                                        | Không tắt sandbox nếu preload không cần Node API                 |
| K    | IPC allowlist và API expose tối thiểu      | Đã hoàn chỉnh.                        | Preload explicit API; main kiểm `event.sender`, validate/cap payload                                         | P0          | Renderer privilege escalation                       | Thêm negative IPC test khi GUI runner ổn định                    |
| K    | Không tải/thực thi nội dung remote         | Đã hoàn chỉnh.                        | `loadFile`, CSP, deny navigation/window-open                                                                 | P0          | Supply-chain/phishing                               | Giới hạn link ngoài HTTPS khi bổ sung link                       |

## Vấn đề bảo mật đã sửa

1. Validation trước đây chỉ kiểm tra host/username không rỗng và dùng `Number(port) || 22`.
   Nay validation nằm ở main/vault/SSH, chặn port ngoài dải, control character và host không hợp lệ.
2. IPC trước đây không xác minh nguồn gửi và không cap terminal input/size. Nay mọi handler kiểm
   `event.sender`, session/connection ID và kích thước payload.
3. Lỗi `ssh2` trước đây được chuyển nguyên văn sang renderer. Nay thông báo được giới hạn, bỏ
   newline và che password/passphrase/private key/token/secret.
4. Snippet mặc định auto-run và `onConnect` chạy không confirm. Nay mặc định không auto-run;
   mọi auto-run/on-connect hiển thị exact command và pattern nguy hiểm có warning riêng.
5. Electron sandbox trước đây bị tắt dù preload chỉ cần module `electron`. Nay sandbox bật.
6. Vault trước đây không có payload schema/settings/backup. Nay migration v2 tương thích dữ liệu
   cũ, tự khóa idle và backup mã hóa có validate + dedupe trước khi merge.
7. Known-hosts write trước đây không atomic và chấp nhận JSON tùy ý. Nay lọc fingerprint hợp lệ,
   ghi qua file tạm và có UI list/forget có xác nhận.

## Backlog ưu tiên

| Nội dung                       | Ưu tiên | Lý do chưa triển khai                                         | Phương án kỹ thuật                                                    | Độ phức tạp |
| ------------------------------ | ------- | ------------------------------------------------------------- | --------------------------------------------------------------------- | ----------- |
| SFTP move/quick edit/drag-drop | P2      | Basic SFTP đã hoàn tất; thao tác nâng cao cần editor/UX riêng | Optimistic-lock editor, drag-drop target validation                   | Trung bình  |
| SSH key manager                | P1/P2   | Hiện app chỉ tham chiếu file key                              | Entity key metadata, fingerprint, `execFile(ssh-keygen)`, usage graph | Lớn         |
| OS credential store            | P2      | Cần adapter và dependency native đa nền tảng                  | Credential Manager/Keychain/Secret Service; vault fallback            | Lớn         |
| Snippet execution history      | P2      | Không lưu command/giá trị để tránh giữ secret ngoài ý muốn    | Chỉ lưu snippet ID/time/connection ID, opt-in và cho phép xóa         | Trung bình  |
| Dashboard Windows/BSD remote   | P3      | Bản hiện tại dùng Linux `/proc`; khác biệt OS                 | Capability probe và parser PowerShell/BSD riêng                       | Trung bình  |

## Đợt rà soát 2 — 2026-08-31

Đợt này bắt đầu từ một phát hiện làm mất giá trị của chính bảng ma trận ở trên:
**bảng được suy ra từ đọc mã nguồn, không phải từ chạy thử**. Bốn dòng đánh dấu
"Đã hoàn chỉnh" thực ra không chạy được, vì cả năm đường dẫn đều gọi
`window.prompt()` — thứ Electron không hỗ trợ và ném lỗi ngay khi gọi.

Quy ước từ nay: chỉ ghi **Đã hoàn chỉnh** khi có test tự động chạy qua đúng
đường dẫn đó, hoặc có một lần bấm thử được ghi lại. Đọc mã nguồn không đủ.

### Lỗi chặn đã sửa

| Mã   | Vấn đề                                                                                                        | Sửa                                                                                                     | Bằng chứng                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P0-1 | `window.prompt()` ném lỗi trong Electron → biến `${name}` của snippet, đổi tên/chmod/tạo thư mục SFTP và Ctrl+F đều chết im lặng | Hộp nhập liệu trong ứng dụng (`core.askInput`) và thanh tìm terminal thật có đếm kết quả, tới/lui, highlight | `ui.test.js`: prompt ném lỗi, không module renderer nào còn gọi `prompt(`, askInput trả giá trị/null, Ctrl+F mở và Esc đóng |
| P0-2 | Bật ghi log rồi chọn file đã tồn tại → `'wx'` phát `'error'` không listener → uncaught exception giết main process | `SessionLogs` dùng cờ `'w'`, gắn listener `'error'`, báo về UI; thêm `uncaughtException`/`unhandledRejection` | `runtime.test.js`: ghi vào file đã tồn tại không lỗi; stream giả phát `'error'` được định tuyến về callback |

### Rủi ro ổn định đã sửa

| Mã  | Vấn đề                                                                        | Sửa                                                                                          |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| S-1 | Đóng tab lúc hộp thoại xác nhận đang mở để lại phiên SSH mồ côi không đóng được | `pendingOpens`/`cancelledOpens` trong `main.js`; huỷ được kiểm lại sau mỗi hộp thoại          |
| S-2 | Không có backpressure SSH → IPC → xterm; output lớn làm phình RAM và treo UI    | `OutputPump` gom theo khung 16ms, phanh dòng ở 512 KB, nhả ở 128 KB, tự mở phanh sau 3s im lặng |
| S-3 | Ghi log tắt im lặng khi tự kết nối lại; nút không phản ánh trạng thái           | Trạng thái ghi log đồng bộ vào nút (`aria-pressed` + chấm đỏ), có kênh `log:state`            |
| S-4 | Dashboard bắn toast lỗi mỗi 10 giây khi phiên chết lúc modal còn mở            | `activeSession()` thành truy vấn thuần; dashboard báo một lần trong bảng rồi dừng đồng hồ    |
| S-5 | Download đổi tên ngay sau `'finish'`, race EPERM trên Windows                  | Đợi `'close'`, có timeout dự phòng cho stream không phát `'close'`                            |
| S-6 | Một mục hỏng trong `~/.ssh/config` làm hỏng cả lần nhập                        | Bọc từng mục, trả `{ added, skipped, jumpsLinked, errors[] }`; thêm hỗ trợ `ProxyJump`        |
| S-7 | Không có lưới an toàn lỗi, không có log chẩn đoán                              | Handler toàn cục ở cả hai phía + `DiagnosticLog` opt-in đi qua bộ lọc che secret              |
| S-8 | `unlock` đọc và parse cả file kho không giới hạn kích thước                    | Cap 20 MB, đồng nhất với import backup                                                        |

### Vấn đề logic đã sửa

| Mã   | Vấn đề                                                     | Sửa                                                                                         |
| ---- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| L-1  | Chia pane mở kết nối SSH mới: 4 pane = 4 lần xác thực       | Tầng "host" trong `SshManager` vẫn còn: <kbd>Ctrl+Shift+D</kbd> thêm shell channel trên kết nối sẵn có, đếm tham chiếu. Mặc định nay là pane độc lập để mỗi pane đi được tới một máy chủ khác — đổi lại một pane rớt không kéo theo cả nhóm |
| L-2  | Thanh tab hiện một tab cho mỗi pane                         | Tab theo workspace, pane nằm bên trong; đóng tab đóng cả nhóm pane                            |
| L-3  | Nhân bản kết nối giữ nguyên ID tunnel                       | Sinh lại `randomUUID()` cho từng tunnel khi nhân bản                                          |
| L-4  | Xoá jump host để lại tham chiếu treo                        | Cảnh báo trước kèm danh sách bị ảnh hưởng, và dọn `jumpHostId` khi xoá                        |
| L-5  | Cổng 0 mở được nhưng lưu không được                         | `validatePort(..., { allowZero: true })` cho tunnel; UI lưu lại cổng thật được cấp            |
| L-6  | Không có cách bỏ màu nhận diện                              | Công tắc bật/tắt màu trong form; tắt thì lưu chuỗi rỗng                                       |
| L-7  | Tham số scrypt ghi vào kho nhưng không bao giờ đọc lại      | `crypto.readParams` đọc và kiểm tham số theo kho; đổi mật khẩu là dịp nâng lên tham số mới    |
| L-8  | Đồng hồ tự khoá chỉ sống ở renderer                         | Đồng hồ ở main process, renderer chỉ gửi tín hiệu hoạt động                                   |
| L-9  | Renderer là một file 1641 dòng, không có lint               | Tách 10 module ES; `eslint.config.js` cho cả hai môi trường; `npm test` chạy lint trước       |
| L-10 | Tài liệu khẳng định nhiều hơn mức đã kiểm chứng             | Mục này, cộng quy ước "Đã hoàn chỉnh" ở đầu phần                                              |

### UI/UX đã sửa

Vòng focus cho mọi nút và danh sách; danh sách máy chủ, tab, palette và chip lệnh
nhanh chuyển thành phần tử bấm được bằng bàn phím kèm điều hướng mũi tên; `role`
và `aria-live` cho toast, `role="dialog"` + giam focus + trả focus cho hộp thoại;
Escape chỉ đóng lớp phủ trên cùng và hỏi lại khi form đang sửa dở; ba nút công cụ
mờ đi cùng lúc với các nút khác khi chưa có phiên; toàn bộ icon chuyển sang SVG
symbolic; đường dẫn kho, vân tay host key và nội dung toast bôi đen được; nút kết
nối lại ngay trên pane đã ngắt; hỏi trước khi thoát khi còn phiên; nhớ kích thước
cửa sổ và mở lại tab của lần trước; menu chuột phải cho terminal và danh sách máy
chủ; click mở URL trong scrollback; `Ctrl` +/− đổi cỡ chữ; copy khi bôi đen; SFTP
có breadcrumb, sắp xếp, kích thước và thời gian đọc được, menu ⋯ và thanh tiến
độ; cài đặt chia tab và tự lưu; công tắc sáng/tối thủ công; màn hình khoá có cảnh
báo Caps Lock, nút hiện mật khẩu và thước đo độ mạnh; bảng phím tắt mở bằng `F1`.

### Thay đổi phá vỡ tương thích

- Master password tối thiểu **12 ký tự** (trước là 8). Kho cũ vẫn mở bình thường;
  giới hạn chỉ áp khi tạo kho mới hoặc đổi mật khẩu.
- Payload schema lên **v5** (thêm `workspace` và các tuỳ chọn giao diện). Migration
  từ v1–v4 chạy tự động khi mở kho.
- `eslint` là devDependency mới: chạy `npm install` trước `npm test`.
