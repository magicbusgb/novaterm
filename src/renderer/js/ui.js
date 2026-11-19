/* Utility UI condivise: DOM helper, toast, menu contestuali, modali. */
(function () {
  const { icon, hydrate } = window.Icons;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function html(str) {
    const t = document.createElement('template');
    t.innerHTML = str.trim();
    const el = t.content.firstElementChild;
    hydrate(el);
    return el;
  }

  function formatBytes(n) {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  function formatDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
  }

  function timeAgo(ms) {
    if (!ms) return 'mai';
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'ora';
    if (s < 3600) return `${Math.floor(s / 60)} min fa`;
    if (s < 86400) return `${Math.floor(s / 3600)} h fa`;
    return `${Math.floor(s / 86400)} g fa`;
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- toast ----------
  function toast(message, kind = 'info', ms = 3500) {
    const ic = { ok: 'checkCircle', err: 'alertCircle', warn: 'alert', info: 'info' }[kind] || 'info';
    const el = html(`<div class="toast ${kind}">${icon(ic)}<div>${esc(message)}</div></div>`);
    $('#toast-root').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 250); }, ms);
  }

  // ---------- menu contestuale ----------
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
  function contextMenu(x, y, items) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { menu.appendChild(document.createElement('hr')); continue; }
      if (it.label && !it.action) { menu.appendChild(html(`<div class="ctx-label">${esc(it.label)}</div>`)); continue; }
      const b = html(`<button class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${icon(it.icon || 'chevronRight')}<span>${esc(it.text)}</span>${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ''}</button>`);
      b.addEventListener('click', () => { closeMenu(); it.action(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    openMenu = menu;
    return menu;
  }
  document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
  window.addEventListener('blur', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // ---------- modali ----------
  const modalStack = [];
  function modal({ title, subtitle, iconName = 'info', body, footer, wide = false, onClose }) {
    const backdrop = html(`
      <div class="modal-backdrop">
        <div class="modal ${wide ? 'wide' : ''}" role="dialog">
          <div class="modal-head">
            <div class="m-icon">${icon(iconName)}</div>
            <div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div>
            <button class="icon-btn" data-close title="Chiudi">${icon('x')}</button>
          </div>
          <div class="modal-body"></div>
          ${footer !== false ? '<div class="modal-foot"></div>' : ''}
        </div>
      </div>`);
    const m = { el: backdrop, body: $('.modal-body', backdrop), foot: $('.modal-foot', backdrop), modal: $('.modal', backdrop) };
    if (typeof body === 'string') m.body.innerHTML = body; else if (body) m.body.appendChild(body);
    hydrate(m.body);
    if (footer && m.foot) { if (typeof footer === 'string') m.foot.innerHTML = footer; else m.foot.appendChild(footer); hydrate(m.foot); }
    m.close = (result) => {
      const i = modalStack.indexOf(m);
      if (i >= 0) modalStack.splice(i, 1);
      backdrop.remove();
      onClose?.(result);
    };
    $('[data-close]', backdrop).addEventListener('click', () => m.close());
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) m.close(); });
    $('#overlay-root').appendChild(backdrop);
    modalStack.push(m);
    setTimeout(() => { const f = $('[autofocus]', backdrop) || $('input:not([type=checkbox]), textarea', m.body); f?.focus(); }, 30);
    return m;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalStack.length && !openMenu) { e.stopPropagation(); modalStack[modalStack.length - 1].close(); }
  }, true);

  function confirmDialog({ title, message, okText = 'Conferma', danger = false, iconName = 'alert' }) {
    return new Promise((resolve) => {
      let result = false;
      const m = modal({
        title, iconName, body: `<div style="color:var(--text-2)">${message}</div>`,
        footer: `<button class="btn ghost" data-act="no">Annulla</button><button class="btn ${danger ? 'danger' : 'primary'}" data-act="yes" autofocus>${esc(okText)}</button>`,
        onClose: () => resolve(result),
      });
      $('[data-act=no]', m.el).onclick = () => m.close();
      $('[data-act=yes]', m.el).onclick = () => { result = true; m.close(); };
      setTimeout(() => $('[data-act=yes]', m.el).focus(), 40);
    });
  }

  function promptDialog({ title, label, value = '', placeholder = '', okText = 'OK', type = 'text', iconName = 'edit', hint = '' }) {
    return new Promise((resolve) => {
      let result = null;
      const m = modal({
        title, iconName,
        body: `<form class="field"><label>${esc(label)}</label><input class="input ${type === 'password' ? '' : 'mono'}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autofocus />${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</form>`,
        footer: `<button class="btn ghost" data-act="no">Annulla</button><button class="btn primary" data-act="yes">${esc(okText)}</button>`,
        onClose: () => resolve(result),
      });
      const input = $('input', m.el);
      const ok = () => { result = input.value; m.close(); };
      $('form', m.el).onsubmit = (e) => { e.preventDefault(); ok(); };
      $('[data-act=no]', m.el).onclick = () => m.close();
      $('[data-act=yes]', m.el).onclick = ok;
      setTimeout(() => { input.focus(); input.select(); }, 40);
    });
  }

  window.UI = { $, $$, esc, html, icon, hydrate, toast, contextMenu, closeMenu, modal, confirmDialog, promptDialog, formatBytes, formatDate, timeAgo, debounce };
})();
