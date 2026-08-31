# Báo cáo rà soát bảo mật và tính năng

Ngày rà soát: 2026-08-31. Phạm vi: mã nguồn hiện tại, cấu hình build, README và test cục bộ.
Không sử dụng credential thật, không kết nối ra ngoài và không chạy lệnh trên server Production.

## Kiến trúc hiện tại

- Electron/Node.js thuần JavaScript, renderer HTML/CSS/xterm.js; không thay đổi framework.
- `src/main/main.js` là composition root, dựng `BrowserWindow`, hộp thoại và IPC allowlist.
- `src/main/vault.js` lưu JSON đã mã hoá toàn khối bằng scrypt + AES-256-GCM tại Electron
  `userData`; payload schema v2 tự migration từ dữ liệu cũ không có schema.
- `src/main/ssh-manager.js` dùng `ssh2.Client`, PTY tương tác, SSH Agent theo platform adapter
  và TOFU host-key verification trong `known_hosts.json`.
- `src/main/preload.js` là API duy nhất cho renderer; `sandbox`, `contextIsolation` bật và
  `nodeIntegration` tắt. Renderer không nhận password/passphrase đã lưu.
- Baseline trước sửa: `npm test` đạt 126/126. Sau sửa: `npm test` đạt 144/144, gồm unit,
  SSH loopback, Electron UI, IME và theme sáng/tối.

## Ma trận tính năng

Trạng thái phản ánh chức năng chạy được và test, không suy luận từ tên nút/file.

| Nhóm | Tính năng | Trạng thái | Bằng chứng trong mã nguồn / kiểm thử | Mức ưu tiên | Rủi ro | Đề xuất |
| ---- | --------- | ---------- | ----------------------------------- | ----------- | ------ | ------- |
| A | Thêm/sửa/xóa/sao chép máy chủ | Đã hoàn chỉnh. | `Vault.saveConnection/deleteConnection/duplicateConnection`; renderer form; `vault.test.js` | P1 | Xóa nhầm | Xóa có confirm; thêm UI test cho sao chép khi GPU runner ổn định |
| A | Tên, host/IP, port, username, auth | Đã hoàn chỉnh. | `validation.js`; `Vault.saveConnection`; `security.test.js` | P0 | Input sai/SSRF ngoài ý muốn | Giữ validation tại main process |
| A | Thư mục làm việc mặc định | Có nhưng chưa hoàn chỉnh. | Trường `defaultDirectory` schema/UI; cố ý chưa tự sinh lệnh shell | P2 | Command injection nếu ghép `cd` | Chỉ áp dụng sau khi biết shell và quote an toàn |
| A | Nhóm, tag, màu, ghi chú | Đã hoàn chỉnh. | Schema v2, form và tìm kiếm trong `app.js` | P2 | Dữ liệu quá dài | Giới hạn độ dài/số tag tại vault |
| A | Tìm kiếm, lọc, sắp xếp | Đã hoàn chỉnh. | `matchesFilter`, `sortConnections`, Ctrl+K; `ui.test.js`, `ime.test.js` baseline | P1 | Không đáng kể | Bổ sung sort selector nếu cần |
| A | Yêu thích | Đã hoàn chỉnh. | `favorite` trong vault/form; ưu tiên trong `sortConnections` | P2 | Không đáng kể | — |
| A | Development/Staging/Production và cảnh báo | Đã hoàn chỉnh. | `environment` schema/form; confirm bắt buộc trong IPC `ssh:open` | P0 | Thao tác nhầm Production | Giữ confirm ở main, không chỉ renderer |
| B | SSH bằng password | Đã hoàn chỉnh. | `SshManager._buildConfig`; loopback `ssh.test.js` | P1 | Lộ credential | Secret chỉ lấy từ vault trong main |
| B | Private key, có/không passphrase | Đã hoàn chỉnh. | `_buildConfig`; test Ed25519 thường và encrypted key | P1 | Lộ key/passphrase | Không trả passphrase về renderer |
| B | SSH Agent | Có nhưng chưa hoàn chỉnh. | Platform adapters và `platform.test.js`; chưa test agent thật | P2 | Sai khác OS/session | Test thủ công Windows/Linux agent thật |
| B | Nhiều phiên bằng tab | Đã hoàn chỉnh. | `state.sessions`, xterm pane/tab; SSH/UI tests | P1 | Rò phiên khi khóa | `lockVault` và `disconnectAll` dọn phiên |
| B | Tự kết nối lại | Chưa có. | Không có retry/backoff trong `SshManager` | P2 | Mất phiên/duplicate command | Thiết kế reconnect opt-in, không tự chạy lại command |
| B | Timeout và keep-alive | Đã hoàn chỉnh. | Schema/form; clamp trong `_buildConfig` | P1 | Treo kết nối/DoS | Bổ sung UI presets sau |
| B | Jump host/ProxyJump | Chưa có. | Không có `sock` chain/jump model | P2 | Bỏ qua verification hop | Verify host key độc lập từng hop |
| B | Lịch sử kết nối gần đây | Có nhưng chưa hoàn chỉnh. | `lastUsedAt/useCount`, sort; chưa có màn lịch sử | P2 | Metadata nhạy cảm | Giữ trong vault; thêm view/xóa lịch sử |
| B | Trạng thái kết nối | Đã hoàn chỉnh. | `connecting/connected/error/closed/ended/gone`; tabs/toast | P1 | Thông báo lỗi lộ secret | `safeErrorMessage` trước khi trả UI |
| B | Chủ động ngắt kết nối | Đã hoàn chỉnh. | Tab close/Ctrl+W → `ssh:close`; integration test | P1 | Phiên treo | `disconnectAll` khi lock/quit |
| C | Terminal tích hợp, nhiều tab | Đã hoàn chỉnh. | xterm + Fit/Search addon; UI/SSH/UTF-8 tests | P1 | Escape sequence không tin cậy | xterm xử lý; không render terminal bằng HTML |
| C | Chia cửa sổ | Chưa có. | Mỗi tab chỉ có một `.term-pane` | P3 | Tăng phức tạp lifecycle | Thiết kế cây split ở renderer |
| C | Font/cỡ/màu/theme tùy chỉnh | Có nhưng chưa hoàn chỉnh. | Theme/font hiện hard-code, có light/dark system | P2 | Không đáng kể | Lưu terminal profile trong vault settings |
| C | Copy/paste/tìm kiếm/Unicode/shortcut | Đã hoàn chỉnh. | `app.js`; UTF-8, IME, UI, theme tests baseline | P1 | Clipboard chứa secret | Thêm clear clipboard opt-in |
| C | Ghi log phiên opt-in | Chưa có. | Không có recorder/file writer | P2 | Log chứa secret | Mặc định tắt, warning + file permission 0600 |
| D | Import SSH key | Có nhưng chưa hoàn chỉnh. | Chọn đường dẫn/key từ ssh config; không copy vào managed store | P1 | Key path mất/permission sai | Thêm key metadata store, không hiển thị nội dung |
| D | Tạo/quản lý public-private key/fingerprint | Chưa có. | Không có key service/UI | P2 | Thuật toán yếu/xóa nhầm | Dùng `ssh-keygen` qua `execFile`, Ed25519 mặc định |
| D | Một key cho nhiều máy chủ | Đã hoàn chỉnh. | Nhiều record có thể dùng cùng `privateKeyPath` | P1 | Thay key ảnh hưởng nhiều host | Hiển thị usage count khi có key manager |
| D | Key có passphrase | Đã hoàn chỉnh. | Vault mã hoá + SSH test encrypted key | P1 | Passphrase trong RAM | Wipe bản sao khi session đóng |
| D | Ngày tạo/thông tin dùng key | Chưa có. | Chỉ connection có timestamp | P2 | Khó rotation | Key entity riêng và usage relation |
| D | Xóa/thay thế key an toàn | Chưa có. | App không quản lý file key | P2 | Mất quyền truy cập | Backup public key, confirm usage impact |
| D | Không lưu secret plain text | Đã hoàn chỉnh. | Vault AES-GCM; disk leakage tests | P0 | Credential disclosure | Giữ atomic write và file mode |
| D | OS credential store | Chưa có. | Không có Credential Manager/Keychain/Secret Service | P2 | Master password phishing/memory dump | Thêm adapter OS; giữ encrypted vault fallback |
| D | Fallback mã hóa không hard-code key | Đã hoàn chỉnh. | `crypto.js`: random salt, scrypt, AES-256-GCM | P0 | Offline brute force | Cân nhắc Argon2id khi có migration/KDF dependency ổn định |
| D | Không hiển thị private key | Đã hoàn chỉnh. | Chỉ hiển thị path; backup không nhúng file | P0 | Key disclosure | — |
| E | Host key verification/TOFU | Đã hoàn chỉnh. | `hostVerifier`, SHA256 fingerprint; `ssh.test.js` | P0 | MITM | Không thêm tùy chọn “bỏ qua” |
| E | Xác nhận lần đầu/lưu trusted key | Đã hoàn chỉnh. | `confirmHostKey`; `KnownHosts.set`; integration test | P0 | Tin nhầm host | Hướng dẫn đối chiếu out-of-band |
| E | Cảnh báo khi fingerprint đổi | Đã hoàn chỉnh. | Dialog severity warning; changed-key integration test | P0 | MITM | Main process chặn mặc định |
| E | Xem/quản lý trusted keys | Đã hoàn chỉnh. | Settings `known-hosts-list`; `KnownHosts.list/forget` | P1 | Quên nhầm key | Có confirm trước khi quên |
| F | Duyệt local/remote, upload/download | Chưa có. | Không có SFTP service/UI | P1 | Path traversal/overwrite | Service riêng, canonical remote POSIX path, allowlisted roots |
| F | Progress/cancel/retry/drag-drop | Chưa có. | Không có transfer model | P2 | Task mồ côi | Transfer queue có AbortController |
| F | Mkdir/rename/move/delete/edit/chmod | Chưa có. | Không có SFTP mutation API | P2 | Mất dữ liệu | Confirm destructive action và optimistic-lock edit |
| F | Chống path traversal/phạm vi | Không phù hợp với kiến trúc hiện tại. | Chưa có SFTP/file API để áp dụng | P0 | Path traversal tương lai | Bắt buộc thiết kế trước khi thêm SFTP IPC |
| G | Lưu snippet | Đã hoàn chỉnh. | Vault + renderer CRUD | P1 | Command nguy hiểm | Default auto-run đã đổi thành false |
| G | Nhóm/tìm kiếm snippet | Có nhưng chưa hoàn chỉnh. | Có field `group`; chưa có search/filter UI | P2 | Khó quản lý | Thêm panel thư viện thay cho chip bar |
| G | Biến `${name}` | Chưa có. | Không có parser/template UI | P2 | Injection qua biến | Typed variables + preview, không shell interpolate tự do |
| G | Preview trước khi chạy | Đã hoàn chỉnh. | Confirm dialog hiển thị nguyên command khi auto-run | P0 | Chạy nhầm | Không cho dialog default “Đồng ý” |
| G | Xác nhận lệnh nguy hiểm | Đã hoàn chỉnh. | `inspectCommand`; `security.test.js`; warning riêng | P0 | Mất dữ liệu remote | Pattern chỉ là defense-in-depth, không thay review người dùng |
| G | Không tự chạy lệnh AI | Đã hoàn chỉnh. | Không tích hợp AI; mọi auto-run có confirm | P0 | Remote code execution | Duy trì invariant nếu thêm AI |
| G | Lịch sử thực thi đã che secret | Chưa có. | Không có execution history | P2 | Secret trong history | Structured record + redaction, opt-out |
| G | Chạy đa máy có kiểm soát | Chưa có. | Không có broadcast executor | P3 | Blast radius lớn | Batch preview, concurrency cap, Production gate |
| H | Local/remote/dynamic forwarding | Chưa có. | Không có tunnel model/API | P1/P2 | Port exposure, leaked listener | Local bind loopback mặc định; lifecycle gắn session |
| H | Lưu/bật/tắt/status/conflict/teardown | Chưa có. | Chỉ SSH sessions hiện hữu | P1 | Port conflict/tunnel mồ côi | Registry tunnel + preflight bind + integration test |
| I | Online/latency/CPU/RAM/disk/uptime/load | Chưa có. | Không có probe service | P2 | Tạo tải/rò thông tin | Lệnh read-only theo OS, opt-in, timeout/caching |
| I | Service/Docker status | Chưa có. | Không có probe/parser | P3 | Quyền cao/khác OS | Adapter capability detection; không cài agent |
| J | Export/import servers/tags/notes/snippets | Đã hoàn chỉnh. | Encrypted backup v1; `backup.test.js` | P1 | Ghi đè/malformed input | Validate toàn bộ trước commit, skip duplicate |
| J | Tunnel config trong backup | Chưa có. | Tunnel chưa có model | P2 | Mất cấu hình | Thêm khi tunnel schema ổn định |
| J | Tùy chọn credential | Đã hoàn chỉnh. | `includeCredentials` false mặc định; UI switch | P0 | Credential disclosure | Password backup riêng >=12 ký tự |
| J | Không export private key mặc định | Đã hoàn chỉnh. | Không bao giờ đọc/nhúng file key; chỉ metadata path | P0 | Private-key disclosure | Giữ invariant trong test |
| J | Backup credential mã hóa mạnh | Đã hoàn chỉnh. | scrypt + AES-256-GCM; wrong-password/tamper tests | P0 | Offline brute force | Cho phép nâng KDF qua version sau |
| J | Validate/tránh overwrite/schema migration | Đã hoàn chỉnh. | `importEncryptedBackup`, endpoint dedupe, payload schema v2 tests | P0 | Mất dữ liệu | Thêm dry-run diff ở P2 |
| K | Khóa app bằng mật khẩu | Đã hoàn chỉnh. | Master password vault; Ctrl+L; UI/vault tests baseline | P0 | Truy cập trái phép | OS biometric là P2 |
| K | Tự khóa khi idle | Đã hoàn chỉnh. | `scheduleAutoLock`, settings 1–240 phút | P0 | Vault mở khi rời máy | Thêm suspend/session-lock hook theo OS |
| K | Không ghi credential vào log | Đã hoàn chỉnh. | Không có log secret; `safeErrorMessage`; disk tests | P0 | Credential disclosure | Thêm automated log-capture regression test |
| K | Che secret trên UI | Đã hoàn chỉnh. | `_safe` loại password/passphrase; input type password | P0 | Shoulder surfing/DOM leak | Không thêm reveal mặc định |
| K | Xóa clipboard sau timeout | Chưa có. | Clipboard chỉ copy/paste, không timer | P2 | Secret lưu clipboard | Opt-in, chỉ clear nếu nội dung chưa đổi |
| K | Validation toàn bộ input nhạy cảm | Đã hoàn chỉnh. | `validation.js`, vault/SSH/IPC caps; tests | P0 | Injection/DoS | Mở rộng schema validator khi có SFTP/tunnel |
| K | Chống command injection | Có nhưng chưa hoàn chỉnh. | Không gọi local shell; remote command được preview/confirm; terminal vẫn là shell chủ ý | P0 | Lệnh remote phá hoại | Typed snippet variables; bỏ auto `defaultDirectory` |
| K | Chống path traversal | Không phù hợp với kiến trúc hiện tại. | Không có file API | P0 | Tương lai khi thêm SFTP | Canonicalize tại main, không tin renderer |
| K | Không nối chuỗi lệnh SSH không an toàn | Có nhưng chưa hoàn chỉnh. | Input gửi thẳng PTY; `onConnect` thêm newline sau confirm | P0 | Shell semantics | Người dùng phải thấy exact command; không ghép biến ẩn |
| K | Dependency không có CVE nghiêm trọng | Chưa thể xác minh. | `npm audit` bị sandbox/network từ chối; lockfile đã đọc | P0 | Supply-chain | Chạy audit/SBOM trong CI có network được phê duyệt |
| K | Error handling không lộ stack/secret | Đã hoàn chỉnh. | IPC wrapper + `safeErrorMessage`; security test | P0 | Secret disclosure | Giữ stack chỉ trong test/dev nội bộ |
| K | CSP Electron | Đã hoàn chỉnh. | Meta CSP trong `index.html`; chỉ `style-src unsafe-inline` cho xterm runtime | P0 | XSS | Không nạp remote script/style |
| K | `nodeIntegration` off, sandbox on | Đã hoàn chỉnh. | `BrowserWindow.webPreferences`; preload/UI test baseline | P0 | Renderer RCE | Không tắt sandbox nếu preload không cần Node API |
| K | IPC allowlist và API expose tối thiểu | Đã hoàn chỉnh. | Preload explicit API; main kiểm `event.sender`, validate/cap payload | P0 | Renderer privilege escalation | Thêm negative IPC test khi GUI runner ổn định |
| K | Không tải/thực thi nội dung remote | Đã hoàn chỉnh. | `loadFile`, CSP, deny navigation/window-open | P0 | Supply-chain/phishing | Giới hạn link ngoài HTTPS khi bổ sung link |

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

| Nội dung | Ưu tiên | Lý do chưa triển khai | Phương án kỹ thuật | Độ phức tạp |
| -------- | ------- | -------------------- | ------------------ | ------------ |
| SFTP cơ bản + traversal/overwrite guard | P1 | Cần model transfer, UI và test server SFTP; không nên ghép vội vào SSH shell | SFTP service main, remote POSIX path canonicalization, transfer queue/cancel | Lớn |
| Local port forwarding | P1 | Cần listener registry và teardown đáng tin cậy | `net.Server` loopback + `ssh2.forwardOut`, conflict preflight, bind opt-in | Trung bình |
| SSH key manager | P1/P2 | Hiện app chỉ tham chiếu file key | Entity key metadata, fingerprint, `execFile(ssh-keygen)`, usage graph | Lớn |
| OS credential store | P2 | Cần adapter và dependency native đa nền tảng | Credential Manager/Keychain/Secret Service; vault fallback | Lớn |
| Jump host/ProxyJump | P2 | Host-key verification phải áp dụng riêng từng hop | Client chain qua `forwardOut`, known-host namespace theo hop | Lớn |
| Reconnect có kiểm soát | P2 | Không được chạy lại command/Production action ngoài ý muốn | Backoff opt-in, session state machine, no auto replay | Trung bình |
| Session logging | P2 | Nguy cơ lưu secret cao | Opt-in per session, warning, 0600, redaction/bounded file | Trung bình |
| Snippet variables/search/history | P2 | Cần UX preview và redaction | Typed placeholders, preview dialog, masked execution metadata | Trung bình |
| Dashboard read-only | P2/P3 | Khác biệt OS và tạo tải lên host | Capability probes, timeout/cache, no remote agent | Lớn |
| Split terminal | P3 | Tăng phức tạp focus/resize/session lifecycle | Renderer split tree, mỗi leaf một xterm/session | Lớn |
