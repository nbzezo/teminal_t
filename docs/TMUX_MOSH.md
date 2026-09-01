# Đánh giá: kết hợp tmux và mosh cho các phiên SSH

Tài liệu đánh giá phương án bổ sung **phiên bền (tmux)** và **kết nối chống rớt
mạng (mosh)** vào SSH Manager. Đánh giá dựa trên mã nguồn tại thời điểm viết,
không phải trên mô tả tính năng chung chung.

## Kết luận trước

| Phương án | Khuyến nghị | Lý do một câu |
| --- | --- | --- |
| **tmux** — phiên bền phía máy chủ | **Nên làm**, phạm vi mức 2 | Không thêm phụ thuộc nào, chạy hoàn toàn phía server, và vá đúng lỗ hổng đang có: tự kết nối lại hiện tại **mất sạch việc đang chạy** |
| **tmux control mode** (`tmux -CC`) | Chưa làm | Phải viết bộ phân tích giao thức control mode và mâu thuẫn với mô hình chia pane hiện tại |
| **mosh** | **Không làm bây giờ** | Cần tầng PTY cục bộ mà app chưa có, **không có mosh-client bản Windows**, và mosh không có forwarding/SFTP/scrollback nên phải chạy song song một kết nối SSH nữa |

---

## 1. Ràng buộc từ kiến trúc hiện tại

Ba điểm dưới đây quyết định toàn bộ phần còn lại của đánh giá.

**a. App nói giao thức SSH trực tiếp, không gọi binary `ssh`.**
`src/main/ssh-manager.js` dùng `ssh2` (JavaScript thuần) mở `Client` rồi xin
shell channel có PTY tại [ssh-manager.js:299](../src/main/ssh-manager.js#L299).
Không có tiến trình con nào, không có `node-pty`, không có phụ thuộc native bắt
buộc — `package.json` đang đặt `npmRebuild: false`.

**b. Chia pane = thêm shell channel trên cùng một kết nối, không phải kết nối mới.**
Xem [ssh-manager.js:293](../src/main/ssh-manager.js#L293). Bốn pane dùng chung một
lần bắt tay, một lần xác thực. Điều này va chạm trực tiếp với cách tmux xử lý
nhiều client (mục 2.3).

**c. Tự kết nối lại hiện tại dựng một shell hoàn toàn mới và cố ý bỏ `onConnect`.**
`ssh:reconnect` gọi `connectionForSsh(connectionId, { clearOnConnect: true })`
tại [main.js:476](../src/main/main.js#L476), rồi `connect()` mở shell mới. Nghĩa là:

> Khi rớt Wi-Fi, thứ bạn nhận lại là một shell trắng ở `$HOME`. Tiến trình đang
> chạy đã chết theo SIGHUP, scrollback mất, thư mục làm việc mất.

Đây là lỗ hổng thật, và nó cũng phá luôn cách lách hiện có: người dùng *có thể*
gõ `tmux new -A -s x` vào ô **Lệnh chạy ngay khi kết nối**, nhưng ô đó
(1) chỉ chạy cho pane đầu tiên (`runOnConnect: false` ở
[ssh-manager.js:293](../src/main/ssh-manager.js#L293)) và (2) **bị xoá đúng trên
đường reconnect**. Tức là cách lách hỏng đúng vào lúc cần nó nhất.

---

## 2. tmux — đánh giá chi tiết

### 2.1 Giá trị mang lại

tmux chạy **trên máy chủ**. App không phải cài gì, không phải đóng gói gì, không
đổi tầng vận chuyển. Chỉ là một câu lệnh gõ vào shell channel đã có. Đổi lại:

- Rớt mạng không giết tiến trình đang chạy; `apt upgrade`, `rsync`, build dài
  vẫn tiếp tục sau khi mất kết nối.
- Reconnect **gắn lại đúng màn hình cũ** kèm thư mục, biến môi trường, job đang chạy.
- Đóng nắp laptop, đổi mạng, sáng hôm sau mở lại vẫn thấy nguyên công việc.

Tỉ lệ giá trị/công sức cao nhất trong các tính năng còn lại đang cân nhắc.

### 2.2 Ba mức tích hợp

| Mức | Mô tả | Công sức | Đánh giá |
| --- | --- | --- | --- |
| 1 | Chỉ viết tài liệu hướng dẫn dùng ô `onConnect` | 0 | **Không đủ** — hỏng trên reconnect và trên pane chia (mục 1c) |
| 2 | Công tắc *Phiên bền (tmux)* cho từng máy chủ; manager tự gắn lại ở **mọi** lần mở shell, kể cả reconnect | 1–2 ngày kể cả test và tài liệu | **Nên làm** |
| 3 | `tmux -CC` control mode: window/pane của tmux ánh xạ thành tab/pane của app (kiểu iTerm2) | Vài tuần | Chưa làm — xem 2.5 |

### 2.3 Xung đột cần xử lý với tính năng sẵn có

Đây là phần dễ bị bỏ sót nếu chỉ nghĩ "chèn thêm một câu lệnh".

**Chia pane sẽ soi gương nhau.** Hai shell channel cùng gắn vào một tên tmux
session sẽ hiển thị **cùng một window**. Gõ ở pane này hiện ở pane kia. Tệ hơn,
tmux co window về kích thước client nhỏ nhất, nên hai pane lệch cỡ sẽ để lại
viền trống. Cách xử lý: mỗi pane mở một **window riêng** trong cùng session, hoặc
dùng grouped session (`tmux new-session -t <tên>`) để mỗi pane có con trỏ window
độc lập.

**Thứ tự với `defaultDirectory`.** Hiện app ghi `cd -- '<dir>'` vào shell trước
([ssh-manager.js:326](../src/main/ssh-manager.js#L326)). Nếu gắn tmux sau đó thì
`cd` chỉ tác động lên shell bọc ngoài, vô nghĩa. Phải chuyển thành
`tmux new-session -A -s <tên> -c <dir>`.

**Scrollback và con lăn chuột.** tmux dùng alternate screen, nên scrollback của
xterm.js ngừng hoạt động và con lăn chuột không cuộn được như trước. Bật `mouse on`
trong `~/.tmux.conf` xử lý được, nhưng đây là thay đổi hành vi người dùng thấy
ngay và phải nói rõ trong README.

**Ghi log phiên sẽ phồng lên.** Log hiện ghi nguyên dòng dữ liệu từ server. Với
tmux, mỗi lần vẽ lại status bar là thêm một loạt escape sequence. File log to hơn
nhiều và khó đọc hơn. Cân nhắc gợi ý `set -g status off` hoặc ghi chú trong tài liệu.

**Auto-lock không còn dừng được việc từ xa.** Đây là điểm bảo mật quan trọng nhất.
Hiện <kbd>Ctrl</kbd>+<kbd>L</kbd> và auto-lock 15 phút ngắt hết phiên và xoá khoá
khỏi RAM — coi như dừng hẳn. Với tmux, session **vẫn chạy trên máy chủ sau khi
kho đã khoá**, kể cả shell root. Cam kết bảo mật của app thay đổi và phải được ghi
vào `docs/SECURITY_AUDIT.md`, không im lặng.

**Tên session là dữ liệu người dùng ghép vào lệnh shell từ xa.** Phải kiểm chặt
`^[A-Za-z0-9_-]{1,32}$` ở main process (cùng chỗ với `validateId`), không chỉ
escape. Đây là bề mặt command injection mới, không được xử lý lỏng hơn `inspectCommand`.

**Không bị ảnh hưởng:** SFTP, port forwarding, jump host, dashboard máy chủ — tất
cả đi qua channel `exec`/`sftp` riêng trên cùng `ssh2.Client`, tmux không đụng tới.

### 2.4 Phạm vi đề xuất (mức 2)

| File | Việc |
| --- | --- |
| [src/main/vault.js](../src/main/vault.js) | Thêm `persistentSession` (bool) và `tmuxSessionName` vào normalize (~137), create/update (~306) và schema backup (~611) |
| [src/renderer/index.html](../src/renderer/index.html), [connections.js](../src/renderer/connections.js) | Công tắc + ô tên trong form máy chủ (đọc/ghi quanh ~216 và ~360) |
| [src/main/ssh-manager.js:297](../src/main/ssh-manager.js#L297) | Dựng lệnh gắn tmux trong `_openShell`; đặt window riêng cho pane chia; gộp `defaultDirectory` vào `-c` |
| [src/main/main.js:473](../src/main/main.js#L473) | Cho phép gắn lại trên đường `ssh:reconnect` — ngoại lệ có chủ đích của quy tắc "không chạy lại onConnect", vì `new -A` là idempotent |
| [src/renderer/sessions.js:590](../src/renderer/sessions.js#L590) | Nới trần retry khi bật phiên bền: 3 lần / 7 giây là quá ngắn cho ngủ máy hoặc đổi mạng |
| [test/ssh.test.js](../test/ssh.test.js) | Test dựng lệnh, escape, chặn tên session xấu, và nhánh máy chủ **không cài tmux** |
| README + SECURITY_AUDIT | Hành vi scrollback mới và việc auto-lock không còn dừng việc từ xa |

**Bắt buộc có đường lùi:** máy chủ không cài tmux phải rơi về shell thường kèm một
dòng cảnh báo, không được treo hay báo lỗi kết nối.

### 2.5 Vì sao chưa làm control mode

`tmux -CC` cho phép pane của tmux ánh xạ thẳng thành pane của app, giữ được layout
qua các lần reconnect. Nhưng phải viết bộ phân tích giao thức control mode
(`%output`, `%layout-change`, `%window-add`…), và mô hình pane hiện tại của app
đang gắn với *shell channel* chứ không phải *tmux pane* — tức phải viết lại tầng
pane. Chi phí vài tuần cho phần lợi ích thêm khá mỏng so với mức 2. Để dành.

---

## 3. mosh — đánh giá chi tiết

### 3.1 mosh giải quyết vấn đề gì

- Chạy trên UDP với giao thức đồng bộ trạng thái (SSP), nên **đổi IP không rớt phiên** —
  chuyển Wi-Fi sang 4G vẫn giữ nguyên.
- Local echo dự đoán: gõ hiện ngay, che độ trễ trên đường truyền tệ.
- Ngủ máy rồi mở lại không cần reconnect.

Đây là những thứ tmux **không** làm được. Hai công cụ bù nhau chứ không thay nhau.

### 3.2 Rào cản 1 — app không có tầng PTY cục bộ (rào cản chính)

mosh gồm hai nửa. Nửa bootstrap dễ: đăng nhập SSH, chạy `mosh-server new`, đọc
dòng `MOSH CONNECT <port> <key>`. Phần này làm được ngay bằng `exec` channel có sẵn.

Nửa còn lại là vấn đề: **`mosh-client` là một binary native tự vẽ terminal của nó**.
Muốn chạy nó, app phải:

1. Thêm `node-pty` — **phụ thuộc native bắt buộc đầu tiên** của dự án. Kéo theo
   `electron-rebuild`, build theo từng kiến trúc, bỏ `npmRebuild: false`, và CI phải
   dựng đủ ma trận nền tảng.
2. Đóng gói hoặc yêu cầu có sẵn `mosh-client` trên **máy khách**.

Cách khác là tự cài đặt SSP bằng JavaScript. Giao thức không có đặc tả ổn định cho
bên thứ ba và cần AES-128-OCB. Không khả thi trong phạm vi dự án này.

### 3.3 Rào cản 2 — Windows không có mosh-client

Không có bản dựng mosh-client chính thức cho Windows. Chỉ có WSL, Cygwin, hoặc bản
biên dịch emscripten đã lâu không ai bảo trì. Windows 10/11 là **nền tảng chính**
của app theo README. Một tính năng cốt lõi chỉ chạy trên nửa số nền tảng, và nửa
không chạy lại là nửa lớn hơn.

### 3.4 Rào cản 3 — mosh không có forwarding, SFTP, hay scrollback

mosh cố ý không làm port forwarding và không có kênh SFTP. Nó cũng **không có
scrollback** — đó là lý do tài liệu của chính mosh khuyên dùng kèm tmux. Với app này:

- Nút tunnel (local/remote/SOCKS5) sẽ chết trên phiên mosh.
- SFTP và dashboard máy chủ cũng vậy.
- Muốn giữ chúng thì phải **duy trì song song một kết nối SSH nữa** cho cùng một
  máy chủ: hai lần xác thực, hai vòng đời, hai chỗ hỏng, và người dùng phải hiểu
  vì sao "kết nối" không còn là một thứ duy nhất.

### 3.5 Rào cản 4 — firewall và jump host

mosh-server cần mở UDP 60000–61000 vào máy chủ. Nhiều môi trường doanh nghiệp
chặn thẳng. Và app đang hỗ trợ **jump host** — UDP không đi qua một jump host TCP
được nếu không dựng thêm tunnel, nên toàn bộ nhóm máy chủ sau bastion sẽ không
dùng được mosh.

### 3.6 Ghi chú bảo mật

mosh kế thừa niềm tin từ lần bắt tay SSH (nên xác minh host key TOFU hiện tại vẫn
có giá trị), nhưng khoá phiên AES-128-OCB được truyền qua đầu ra lệnh/biến môi
trường, và mosh được soi ít hơn OpenSSH rất nhiều. Với một dự án đã có
`docs/SECURITY_AUDIT.md` dài 40KB, đây là thứ phải được đánh giá tử tế chứ không
phải ghi một dòng.

### 3.7 Kết luận về mosh

Chi phí: một phụ thuộc native, một binary phải đóng gói cho từng nền tảng, một
đường CI mới, một khoảng trống trên nền tảng chính, và một mô hình kết nối kép để
giữ các tính năng đang có. Lợi ích: roaming và che độ trễ.

**Chưa xứng.** Chỉ nên xem lại nếu sau này app phải thêm `node-pty` vì lý do khác
(ví dụ mở terminal cục bộ) — khi đó rào cản chính đã được trả tiền rồi.

---

## 4. Nếu mục tiêu thật là "đừng mất việc khi mạng chập chờn"

Ba việc rẻ, cộng lại đạt phần lớn lợi ích của mosh mà không đụng gì tới đóng gói:

1. **tmux mức 2** — việc đang chạy sống sót qua mọi lần rớt.
2. **Nới cửa sổ retry.** Hiện `1s, 2s, 4s` rồi bỏ cuộc sau 3 lần
   ([sessions.js:594](../src/renderer/sessions.js#L594)) — tổng cộng 7 giây, không
   đủ cho một lần ngủ máy. Khi có tmux, retry lâu hơn là an toàn vì gắn lại là idempotent.
3. **Reconnect khi mạng có lại.** Nghe `online`/`offline` của renderer để gắn lại
   ngay khi máy có mạng, thay vì chờ hết backoff.

Phần còn thiếu so với mosh là local echo và giữ phiên qua đổi IP không cần gắn lại.
Với tmux, cái giá của việc đổi IP chỉ là một lần gắn lại vài trăm mili giây — chấp nhận được.

---

## 5. Khuyến nghị

Làm **tmux mức 2** như phạm vi ở 2.4, kèm đủ ba thứ dễ bị bỏ: đường lùi khi máy chủ
không có tmux, kiểm chặt tên session, và cập nhật `SECURITY_AUDIT.md` về việc
auto-lock không còn dừng được việc từ xa.

Không làm mosh. Ghi lại quyết định và điều kiện xem lại: *khi nào dự án có `node-pty`
vì lý do khác.*
