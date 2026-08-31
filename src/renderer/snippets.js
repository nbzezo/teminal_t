'use strict';

import {
  $,
  bridge,
  call,
  state,
  setStatus,
  showError,
  clearError,
  icon,
  openModal,
  closeModal,
  askInput,
  activeSession,
} from './core.js';

export function renderSnippets(query = $('snippet-search').value) {
  const list = $('snippet-list');
  list.textContent = '';
  const needle = String(query || '')
    .trim()
    .toLocaleLowerCase('vi');
  const snippets = state.snippets.filter(
    (snippet) =>
      !needle ||
      [snippet.name, snippet.group, snippet.command].some((value) =>
        String(value || '')
          .toLocaleLowerCase('vi')
          .includes(needle),
      ),
  );
  if (snippets.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'snippet-empty';
    empty.textContent = needle
      ? 'Không tìm thấy lệnh phù hợp.'
      : 'Chưa có lệnh nào — lưu các lệnh hay dùng để bấm một phát là chạy.';
    list.appendChild(empty);
    return;
  }
  for (const snippet of snippets) {
    const chip = document.createElement('div');
    chip.className = 'snippet-chip';
    chip.title = snippet.command;

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'chip-name';
    label.textContent = snippet.name;
    label.addEventListener('click', () => runSnippet(snippet));

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'chip-edit';
    edit.appendChild(icon('edit', 12));
    edit.title = 'Sửa lệnh ' + snippet.name;
    edit.setAttribute('aria-label', 'Sửa lệnh ' + snippet.name);
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openSnippetModal(snippet.id);
    });

    chip.append(label, edit);
    list.appendChild(chip);
  }
}

/**
 * Điền biến `${name}` rồi gửi lệnh.
 *
 * Trước đây chỗ này gọi `window.prompt`, thứ Electron không hỗ trợ — nên mọi
 * snippet có biến đều im lặng không chạy. Giờ dùng hộp nhập liệu trong ứng dụng.
 */
async function runSnippet(snippet) {
  const session = activeSession();
  if (!session) return setStatus('Chưa có phiên SSH nào đang kết nối để gửi lệnh.', 'error');
  const sessionId = state.activeSessionId;
  let command = snippet.command;
  const variableNames = [
    ...new Set([...command.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/g)].map((match) => match[1])),
  ];
  for (const name of variableNames) {
    const value = await askInput({
      title: 'Lệnh nhanh: ' + snippet.name,
      label: 'Giá trị cho ${' + name + '}',
      placeholder: 'Nhập giá trị…',
      hint: 'Giá trị được chèn nguyên văn vào lệnh trước khi gửi.',
      confirmLabel: 'Tiếp tục',
    });
    if (value === null) return setStatus('Đã huỷ điền biến.', undefined);
    if (value.length > 1024 || /[\r\n\0]/.test(value)) return setStatus('Giá trị biến không hợp lệ.', 'error');
    command = command.replaceAll('${' + name + '}', value);
  }
  if (snippet.autoRun) {
    const confirmed = await call(
      bridge.dialogs.confirm(snippet.dangerous ? 'Lệnh có rủi ro cao — vẫn chạy?' : 'Chạy lệnh nhanh này?', command),
    );
    if (!confirmed) return setStatus('Đã huỷ lệnh.', undefined);
  }
  if (!state.sessions.has(sessionId)) return setStatus('Phiên đã đóng trong lúc điền biến.', 'error');
  bridge.ssh.input(sessionId, command + (snippet.autoRun ? '\n' : ''));
  session.term.focus();
  setStatus('Đã gửi: ' + snippet.name, 'ok');
}

export function openSnippetModal(snippetId) {
  state.editingSnippetId = snippetId || null;
  const snippet = snippetId ? state.snippets.find((item) => item.id === snippetId) : null;
  $('snippet-modal-title').textContent = snippet ? 'Sửa lệnh nhanh' : 'Lệnh nhanh mới';
  $('s-name').value = snippet ? snippet.name : '';
  $('s-command').value = snippet ? snippet.command : '';
  $('s-group').value = snippet ? snippet.group || '' : '';
  $('s-autorun').checked = snippet ? snippet.autoRun : false;
  $('btn-snippet-delete').hidden = !snippet;
  clearError('snippet-error');
  openModal('snippet-modal');
  $('s-name').focus();
}

export function initSnippets() {
  $('snippet-search').addEventListener('input', (event) => renderSnippets(event.target.value));

  $('snippet-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError('snippet-error');
    try {
      await call(
        bridge.snippets.save({
          id: state.editingSnippetId,
          name: $('s-name').value,
          command: $('s-command').value,
          group: $('s-group').value,
          autoRun: $('s-autorun').checked,
        }),
      );
    } catch (err) {
      return showError('snippet-error', err.message);
    }
    closeModal('snippet-modal');
    state.snippets = await call(bridge.snippets.list());
    renderSnippets();
  });

  $('btn-snippet-delete').addEventListener('click', async () => {
    await call(bridge.snippets.remove(state.editingSnippetId));
    closeModal('snippet-modal');
    state.snippets = await call(bridge.snippets.list());
    renderSnippets();
  });
}
