# Thiết kế triển khai: phiên bền tmux

Tài liệu này trả lời câu hỏi *triển khai thế nào để dễ dùng và thuận tiện khi vận
hành thật*, tiếp nối quyết định trong [TMUX_MOSH.md](TMUX_MOSH.md).

> **Trạng thái (2026-09-01): đã làm xong mục 1–8 và bảng ở mục 3.**
> `npm test` xanh 287/287. Hai thứ trong thiết kế chưa làm, có chủ đích:
> **Gắn vào** một phiên bất kỳ từ bảng (phiên do app tạo vốn tự gắn lại theo
> tab/pane, còn gắn phiên người dùng tự mở cần một mô hình đặt tên khác), và
> **hộp thoại giải thích lần đầu bật** — ba điều đó hiện nằm ở README và ở dòng
> mô tả ngay dưới công tắc trong form. Va chạm <kbd>Ctrl</kbd>+<kbd>L</kbd> ở mục 9
> vẫn để nguyên, chờ quyết định.

## Nguyên tắc

> **Người dùng không phải học tmux.** Họ bấm vào máy chủ, việc cũ hiện ra. Ai biết
> tmux thì mọi thứ vẫn đúng như họ mong đợi; ai không biết thì không bao giờ phải biết.

Mọi quyết định dưới đây suy ra từ nguyên tắc đó. Ba thứ quyết định trải nghiệm nhiều
nhất, xếp theo thứ tự: **tên phiên phải đọc được**, **đóng pane không được giết việc**,
và **phải có chỗ dọn dẹp**.

---

## 1. Tên phiên: đặt theo thứ người dùng nhìn thấy

Sai lầm dễ mắc là đặt tên bằng UUID của connection. Đúng về mặt kỹ thuật, nhưng khi
người dùng ssh tay vào máy chủ và gõ `tmux ls`, họ nhìn thấy một dãy vô nghĩa và không
biết cái nào là cái nào.

Đặt tên theo **tab và pane mà họ đang nhìn**:

| Người dùng đang ở | Tên tmux session |
| --- | --- |
| Tab đầu tiên của `web01`, một pane | `sshman_web01` |
| Tab thứ hai của `web01` | `sshman_web01-2` |
| Pane thứ ba của tab hai | `sshman_web01-2-3` |

- Slug lấy từ **tên connection**, hạ về `[a-z0-9-]`, cắt 16 ký tự.
- Tab 1 và pane 1 **không có hậu tố** — trường hợp phổ biến nhất cho tên ngắn nhất.
- Dấu `.` và `:` bị tmux cấm trong tên session; dùng `-` là an toàn.
- Tên hiện ngay trên pane dưới dạng badge nhỏ, để đối chiếu được khi ssh tay.
- Ô **Tên phiên** trong form máy chủ là đường thoát cho người muốn tự đặt; để trống thì auto.

**Một tmux session cho mỗi pane, không phải mỗi tab.** Đây là lựa chọn quan trọng:
nó xoá luôn hai vấn đề khó của mục 2.3 trong đánh giá — hai pane không còn soi gương
nhau, và mỗi session chỉ có đúng một client nên không bao giờ bị co về kích thước
client nhỏ nhất. Đổi lại `tmux ls` dài hơn, và đó là lý do cần mục 3.

---

## 2. Mở lại là có việc cũ ngay

Bấm vào máy chủ → **gắn vào phiên rời (detached) khớp tên nếu có, chỉ tạo mới khi
không còn cái nào**. Đây là toàn bộ giá trị của tính năng, gói trong một cú bấm.

Cơ chế: sau khi `ready`, chạy **một** lệnh probe trên `exec` channel:

```sh
command -v tmux >/dev/null 2>&1 && tmux ls -F '#{session_name} #{session_attached} #{session_windows} #{session_created}' 2>/dev/null
```

Một round trip cho cả ba việc: biết máy chủ có tmux không, biết đang có những phiên
nào, và biết cái nào đang rời. Kết quả cache trên `host`, dùng lại cho mọi pane, cho
badge, và cho bảng ở mục 3.

**Dùng `exec` có PTY thay vì ghi lệnh vào `shell()`.** Cách hiện tại ghi
`cd -- '<dir>'` vào stream nên dòng lệnh bị echo ra màn hình. Với tmux thì càng xấu.
Thay bằng:

```js
host.client.exec(attachCommand, { pty: { term: 'xterm-256color', cols, rows } }, cb)
```

Không echo, không shell bọc ngoài, `stream.setWindow` vẫn hoạt động y như cũ. Khi
máy chủ **không có tmux**, đi đúng đường `shell()` cũ không sửa gì — fallback giống
hệt hành vi hôm nay, cộng một dòng cảnh báo.

**Clear terminal ngay trước khi gắn lại.** Khi reconnect, xterm vẫn còn nội dung cũ
cộng các dòng thông báo retry; tmux vẽ đè lên tạo ra màn hình rác. Gọi `term.clear()`
trước khi attach để tmux vẽ lại trên nền sạch. Chi tiết nhỏ, nhưng là khác biệt giữa
"như có phép" và "trông hỏng".

---

## 3. Bảng "Phiên trên máy chủ"

Bật phiên bền nghĩa là **công việc tích tụ vô hình trên máy chủ**. Không có chỗ nhìn
và dọn thì sau vài tuần mỗi máy có hai chục session mồ côi. Đây là phần bắt buộc, không
phải phần trang trí.

Một nút trong toolbar phiên, cạnh dashboard và SFTP. Mở ra bảng từ kết quả `tmux ls`:

| Cột | Nội dung |
| --- | --- |
| Tên | `sshman_web01-2`, kèm nhãn *của app này* hay *tạo bằng tay* |
| Trạng thái | Đang gắn · Đang rời |
| Cửa sổ | Số window |
| Tạo lúc | Thời gian tương đối — "3 ngày trước" |

Hành động: **Gắn vào** (mở tab mới attach thẳng), **Kết thúc** (`tmux kill-session`,
có xác nhận nêu rõ tiến trình đang chạy sẽ chết). Sắp phiên rời lên trên — đó là thứ
người ta vào đây để tìm.

---

## 4. Đóng pane là rời phiên, không phải kết thúc

Đây là chỗ dễ làm người dùng mất việc hoặc tích rác nhất, nên ngữ nghĩa phải rõ:

| Thao tác | Kết quả |
| --- | --- |
| <kbd>Ctrl</kbd>+<kbd>W</kbd> | Đóng pane, **tmux vẫn chạy trên máy chủ** |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd> | Đóng tab, mọi phiên tmux vẫn chạy |
| Menu chuột phải → **Kết thúc phiên trên máy chủ** | `tmux kill-session`, có xác nhận |
| `exit` trong tmux | Kết thúc window; hết window thì session tự chết — đúng phản xạ sẵn có |

Ba lần đầu đóng pane, hiện toast một dòng — *"Phiên vẫn chạy trên web01"* — kèm **một
nút thật** *Kết thúc hẳn*. Sau đó im. Người dùng học được ngữ nghĩa mới mà không bị
hỏi lại mãi. Toast hiện tại chỉ có chữ, xem mục 5.

---

## 5. Nút bấm cho terminal: đặt ở đâu, và không đặt ở đâu

**Không vẽ nút bằng chữ trong lòng terminal.** xterm.js dựng buffer ký tự, không phải
DOM — không nhét được `<button>` vào giữa dòng chữ. Nguy hiểm hơn, riêng với tính năng
này: tmux chạy trên **alternate screen** và vẽ lại toàn màn hình mỗi lần attach hoặc
resize, nên mọi thứ app tự `term.writeln` vào đó **bị xoá sạch** ở lần vẽ lại kế tiếp,
và alternate screen không có scrollback nên dòng đó cũng không trôi lên chỗ an toàn
được. Nút-bằng-chữ vừa không bấm được vừa không sống sót.

May là app đã có sẵn đủ ba mặt phẳng DOM nằm **trên** terminal:

| Mặt phẳng | Có sẵn ở | Dùng cho |
| --- | --- | --- |
| Lớp phủ pane | `buildPaneOverlay` ([sessions.js:176](../src/renderer/sessions.js#L176)) | Trạng thái **chặn** — pane đang vô dụng: đã chết, chờ kết nối |
| Thanh nổi trên terminal | `.terminal-search` ([styles.css:1478](../src/renderer/styles.css#L1478)) | Hành động **không chặn** — đúng khuôn cho banner gợi ý |
| Nút toolbar | `renderHeader()` ([sessions.js:445](../src/renderer/sessions.js#L445)) | Hành động **thường trực** cho phiên đã kết nối |

Thanh tìm kiếm là khuôn mẫu chuẩn nhất để sao lại: `position: absolute` nổi trên
terminal, có nút thật, không nằm trong luồng layout. Điểm này quan trọng — banner
**phải** absolute. Nếu nó chiếm chỗ theo chiều dọc thì `FitAddon` co terminal lại,
tmux nhận resize và vẽ lại toàn màn hình, chỉ để hiện một lời gợi ý.

**Bản đồ mặt phẳng cho tính năng này:**

| Hành động | Đặt ở đâu |
| --- | --- |
| Kết nối lại / Kết nối | Lớp phủ pane — đã có, không sửa |
| Bật phiên bền cho máy này | **Banner mỏng trong pane**, tự tắt, có nút *Bật* và *Bỏ qua* |
| Kết thúc phiên tmux sau khi đóng pane | **Toast có nút** — tạm thời, hành động phụ |
| Mở bảng "Phiên trên máy chủ" | **Nút toolbar** cạnh dashboard và SFTP |
| Tên session đang gắn | **Badge trên pane**, bấm được, mở thẳng bảng |
| Kết thúc phiên này | Menu chuột phải — hành động phá huỷ, không để lộ ra ngoài |

**Hai việc phải làm để có được các nút này:**

1. **`setStatus` hiện chỉ nhận chữ** ([core.js:84](../src/renderer/core.js#L84)). Cần
   thêm tham số action tuỳ chọn `{ label, onClick }` và dừng đồng hồ tự ẩn khi có nút —
   toast biến mất sau 3,5 giây thì nút trên nó vô nghĩa.
2. **Thành phần `pane-banner`** đặt cạnh `buildPaneOverlay`, dùng lại lớp `.btn` sẵn có.
   Kỷ luật focus: `preventDefault` trên `mousedown` để banner không cướp con trỏ khỏi
   terminal, và gọi `term.focus()` ngay sau khi xử lý xong. Nút vẫn phải tới được bằng
   <kbd>Tab</kbd>.

**Ngoại lệ duy nhất được phép bấm trong lòng terminal:** `registerLinkProvider`
([sessions.js:80](../src/renderer/sessions.js#L80)) đang dùng cho URL. Nó cho phép bất
kỳ đoạn chữ nào trong buffer thành vùng bấm được có `activate`. Về nguyên tắc có thể
dùng cho hành động, nhưng nó vẫn là **chữ**: trôi theo scrollback, dính vào khi chọn
tất cả, và vẫn bị tmux xoá như trên. Chỉ dùng cho thứ vốn thuộc về dòng dữ liệu — URL,
đường dẫn file — không dùng cho nút hành động.

---

## 6. Bật ở đâu, và mời bật lúc nào

**Ba trạng thái cho mỗi máy chủ:** *Theo mặc định · Bật · Tắt*, cộng một công tắc mặc
định chung trong ⚙. Không ép một giá trị cho mọi máy: phiên bền đáng bật cho máy làm
việc lâu, thừa cho máy ghé qua một phút.

**Mời đúng lúc, không nag.** Khoảnh khắc người dùng hiểu giá trị của tính năng này là
lúc họ vừa mất việc. Khi một phiên rớt rồi reconnect xong với shell trắng, viết thẳng
hiện **banner mỏng ở đáy pane** (mục 5):

> Việc đang chạy đã mất khi rớt kết nối. Bật phiên bền cho **web01**?
> &nbsp;&nbsp; `[ Bật ]` `[ Bỏ qua ]`

Banner nổi trên terminal nên không chặn gõ, tự tắt sau 30 giây, và không hiện lại nếu
bị bỏ qua hai lần. Không modal.

**Lần đầu bật thì nói thật ba điều**, một hộp thoại có "Đừng hiện lại":

1. Đóng pane từ giờ là *rời phiên*, không phải kết thúc.
2. Khoá kho **không còn dừng được việc đang chạy trên máy chủ**.
3. Cuộn màn hình do tmux quản, không phải app.

---

## 7. Cấu hình tmux do app đặt — phạm vi session, không đụng `~/.tmux.conf`

Khi **tạo mới** một session, app đặt kèm vài tuỳ chọn ở phạm vi session. Chúng chết
theo session nên không bao giờ ảnh hưởng cấu hình cá nhân của người dùng trên máy chủ:

| Tuỳ chọn | Vì sao |
| --- | --- |
| `mouse on` | Trả lại con lăn chuột — vá đúng phàn nàn lớn nhất khi dùng tmux trong terminal đồ hoạ |
| `status off` | App đã có thanh tab riêng; bỏ thanh status của tmux được thêm một dòng terminal và log phiên sạch hơn nhiều |
| `history-limit` | Nới scrollback. **Giới hạn thật:** chỉ áp cho pane tạo sau, không cứu được pane đầu tiên — muốn triệt để thì phải đặt trong `~/.tmux.conf`, và tài liệu nên nói rõ như vậy |

Cả ba đều nên có công tắc trong ⚙ cho người đã có cấu hình tmux riêng và không muốn
app can thiệp.

---

## 8. Kết nối lại: nới thời gian, thêm nút, bám sự kiện mạng

Hiện `1s, 2s, 4s` rồi bỏ cuộc — bảy giây, không đủ cho một lần đóng nắp laptop
([sessions.js:594](../src/renderer/sessions.js#L594)). Khi có phiên bền, gắn lại là
idempotent nên retry lâu là an toàn:

- Backoff `1s → 2s → 4s → 8s → 15s → 30s → 30s…`, dừng sau 10 phút hoặc khi người dùng bấm huỷ.
- Overlay pane hiện đếm ngược kèm nút **Thử lại ngay** (overlay và nút đã có sẵn tại
  [sessions.js:189](../src/renderer/sessions.js#L189)).
- Nghe sự kiện `online` của renderer để gắn lại ngay khi máy có mạng, thay vì chờ hết backoff.

Ba việc này cộng với tmux là phần lớn cảm giác "không rớt" mà mosh mang lại, với chi
phí gần bằng không.

---

## 9. Va chạm phím tắt

`Ctrl`+`B` (prefix mặc định của tmux) hiện **không** bị app dùng — không xung đột.

Nhưng <kbd>Ctrl</kbd>+<kbd>L</kbd> đang là **khoá kho**, trong khi phản xạ của mọi
người trong terminal là clear màn hình. Va chạm này đã tồn tại sẵn, nhưng phiên bền
khiến người dùng ở trong terminal nhiều hơn nên nó sẽ đau hơn. Hai lựa chọn: chuyển
khoá kho sang <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>, hoặc để nguyên và ghi rõ
trong <kbd>F1</kbd>. Cần quyết trước khi làm, không nên để trôi.

---

## 10. Chia giai đoạn

| Giai đoạn | Nội dung | Công |
| --- | --- | --- |
| **1 · Chạy được** | Probe + attach/reattach, đặt tên, `exec`+pty, fallback khi không có tmux, clear trước attach | 1–2 ngày |
| **2 · Dùng thoải mái** | Ngữ nghĩa đóng pane + xác nhận kết thúc, **`pane-banner` và toast có nút** (mục 5), badge tên trên pane, hộp thoại lần đầu, cấu hình phạm vi session, backoff mới | +2 ngày |
| **3 · Vận hành nhiều máy** | Bảng "Phiên trên máy chủ", lời mời đúng lúc, cảnh báo khi khoá kho mà còn phiên chạy | +1–2 ngày |

Giai đoạn 1 tự nó đã dùng được và không làm hỏng gì. Giai đoạn 2 là ranh giới giữa
"có tính năng" và "tính năng dùng thoải mái" — **đừng dừng trước khi hết giai đoạn 2**.
Giai đoạn 3 mới là thứ giữ cho máy chủ không thành bãi rác sau vài tháng.

---

## 11. Những chỗ phải cẩn thận

**`tmux -u` là bắt buộc, và đây là cái giá của việc đổi sang `exec`.** tmux đoán
terminal có UTF-8 hay không từ `LC_ALL`/`LC_CTYPE`/`LANG`, rồi **thay mọi ký tự
ngoài ASCII bằng `_`** nếu đoán là không. Channel `exec` chạy qua `$SHELL -c` nên
không đi qua profile của login shell — các biến đó trống, khác hẳn channel `shell`
tương tác. Hậu quả với người dùng Việt: *"Phiên làm việc"* hiện ra thành
*"Phi_n l_m vi_c"*. Mọi lời gọi tmux đều phải có `-u`, kể cả lệnh probe (tên phiên
có dấu cũng phải đọc đúng). Đã tái hiện và kiểm chứng bản sửa với tmux 3.6 thật.

**`set-option -t` không nhận `=NAME`.** `-t` ở đó là target-*pane*, và `=NAME` bị
từ chối thẳng với "no such session" — trong khi `has-session`/`attach`/`kill` thì
nhận bình thường. Dùng `=NAME:` (target-window trong đúng session đó) để vừa được
chấp nhận vừa giữ so khớp chính xác. Bỏ dấu `=` không phải lựa chọn: đã thử trên
tmux thật, xoá `app` rồi thì `-t app` gắn sang `app-2`.

**Không có chỗ trống an toàn trên mặt terminal.** Bản đầu vẽ tên phiên thành chip
nổi ở góc pane; chip đó che mất chữ, thấy rõ nhất ở pane hẹp sau khi chia đôi.
Tên phiên chuyển hẳn ra thanh tiêu đề.

**Tên session là dữ liệu người dùng đi vào lệnh shell từ xa.** Cả slug tự sinh lẫn ô
người dùng tự nhập đều phải qua `^[A-Za-z0-9_-]{1,32}$` ở main process, kiểm chứ không
chỉ escape. Đây là bề mặt command injection mới và không được xử lý lỏng hơn
`inspectCommand` đang làm với lệnh tự động.

**Khoá kho không còn dừng việc từ xa.** Khi <kbd>Ctrl</kbd>+<kbd>L</kbd> hoặc auto-lock
chạy mà còn phiên bền, toast phải nói rõ: *"Đã khoá kho. N phiên vẫn chạy trên máy chủ."*
Và `docs/SECURITY_AUDIT.md` phải ghi lại thay đổi này trong cam kết bảo mật.

**Máy chủ không có tmux phải im lặng đi tiếp.** Rơi về `shell()` như cũ kèm đúng một
dòng cảnh báo, kèm gợi ý tắt phiên bền cho riêng máy đó. Không treo, không báo lỗi kết nối.

**Ghi log phiên.** `status off` ở mục 6 đã xử lý phần lớn rác, nhưng log của một phiên
tmux vẫn nhiều escape sequence hơn shell thường. Nên nói trong README thay vì để người
dùng tự phát hiện.

**Test cần có** ([test/ssh.test.js](../test/ssh.test.js)): dựng tên từ tên connection
có dấu tiếng Việt và ký tự lạ; chặn tên xấu; chọn đúng session rời khi có nhiều; đường
fallback khi probe trả về rỗng; và `resize` vẫn tới đúng stream trên đường `exec`.
