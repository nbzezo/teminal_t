'use strict';

import { $, state, openModal, closeModal, matchesFilter, sortConnections } from './core.js';
import { openSession } from './sessions.js';

export function openPalette() {
  $('palette-input').value = '';
  renderPalette('');
  openModal('palette');
  $('palette-input').focus();
}

function renderPalette(needle) {
  const query = needle.trim();
  state.paletteItems = sortConnections(state.connections.filter((conn) => matchesFilter(conn, query))).slice(0, 12);
  state.paletteIndex = 0;

  const box = $('palette-results');
  box.textContent = '';
  if (state.paletteItems.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'palette-empty';
    empty.textContent = 'Không tìm thấy máy chủ nào.';
    box.appendChild(empty);
    return;
  }
  state.paletteItems.forEach((conn, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'palette-item' + (index === 0 ? ' active' : '');
    row.tabIndex = -1;
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = conn.name;
    const host = document.createElement('span');
    host.className = 'p-host';
    host.textContent = conn.username + '@' + conn.host;
    row.append(name, host);
    row.addEventListener('click', () => {
      closeModal('palette');
      openSession(conn.id);
    });
    box.appendChild(row);
  });
}

function movePalette(delta) {
  const rows = [...$('palette-results').children];
  if (rows.length === 0 || !rows[0].classList.contains('palette-item')) return;
  rows[state.paletteIndex].classList.remove('active');
  state.paletteIndex = (state.paletteIndex + delta + rows.length) % rows.length;
  rows[state.paletteIndex].classList.add('active');
  rows[state.paletteIndex].scrollIntoView({ block: 'nearest' });
}

export function initPalette() {
  $('palette-input').addEventListener('input', (event) => renderPalette(event.target.value));

  $('palette-input').addEventListener('keydown', (event) => {
    // Bộ gõ tiếng Việt đang soạn thảo: Enter và mũi tên lúc này thuộc về bộ gõ
    // (chốt từ, chọn ứng viên), không phải lệnh của ứng dụng.
    if (event.isComposing || event.keyCode === 229) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      movePalette(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      movePalette(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const conn = state.paletteItems[state.paletteIndex];
      if (conn) {
        closeModal('palette');
        openSession(conn.id);
      }
    }
  });
}
