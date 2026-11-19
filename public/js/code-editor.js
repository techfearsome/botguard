/**
 * Code editor enhancement for HTML/template textareas in the admin UI.
 *
 * Strategy: progressive enhancement. The original <textarea> always stays in
 * the DOM with its `name` attribute, so form submission works exactly as
 * before. For a manageable-sized template we add a CodeJar + Prism editor on
 * top for syntax highlighting; for a LARGE template we leave the native
 * textarea as-is, because a browser's native textarea stays fast at any size
 * while a highlighted contenteditable does not.
 *
 * Why this file changed: a large landing page in the CodeJar/Prism editor
 * could bog the browser down — every keystroke re-runs caret bookkeeping over
 * a huge contenteditable, and highlighting builds thousands of DOM nodes. Now:
 *   1. Templates above UPGRADE_MAX_BYTES default to the plain native textarea.
 *   2. A toolbar toggle ("Syntax highlight: On/Off") lets you switch either
 *      way on any page, and the choice is remembered (localStorage).
 * The rich editor is torn down cleanly when you switch to plain, and rebuilt
 * when you switch back, so there is no leftover cost.
 *
 * If this script fails to load (CSP, network, old browser), the form still
 * works because the textarea is the real input — just without highlighting.
 */

import { CodeJar } from '/static/js/vendor/codejar.js';

(function () {
  'use strict';

  // ── Thresholds ──────────────────────────────────────────────────────
  // Above UPGRADE_MAX_BYTES we default to the native textarea (no CodeJar).
  // The user can still force the rich editor via the toggle if they want.
  const UPGRADE_MAX_BYTES = 40000;  // ~40 KB
  // Within the rich editor, highlighting is debounced above this size and
  // skipped entirely above SKIP_THRESHOLD, so even a forced-rich large doc
  // degrades gracefully instead of freezing.
  const DEBOUNCE_THRESHOLD = 8000;
  const DEBOUNCE_MS = 500;
  const SKIP_THRESHOLD = 120000;
  const PREF_KEY = 'bg_code_editor_mode'; // 'rich' | 'plain'

  function getPref() {
    try { return localStorage.getItem(PREF_KEY); } catch (_) { return null; }
  }
  function setPref(v) {
    try { localStorage.setItem(PREF_KEY, v); } catch (_) { /* private mode */ }
  }

  // Wait for Prism (loaded via a regular, non-module <script defer>). Poll
  // briefly; give up after 2s and fall back to the plain textarea.
  function waitForPrism(callback, onGiveUp) {
    const start = Date.now();
    (function check() {
      if (window.Prism && window.Prism.languages && window.Prism.languages.markup) {
        callback();
      } else if (Date.now() - start > 2000) {
        console.warn('[code-editor] Prism not available; staying on plain textarea');
        if (onGiveUp) onGiveUp();
      } else {
        setTimeout(check, 30);
      }
    })();
  }

  let highlightTimer = null;
  function highlightHtml(editorEl) {
    if (!window.Prism) return;
    const text = editorEl.textContent || '';
    if (!text.trim()) return;
    const size = text.length;
    if (size > SKIP_THRESHOLD) return;                 // too big: leave plain text
    if (size > DEBOUNCE_THRESHOLD) {                   // big: highlight after a pause
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => {
        window.Prism.highlightElement(editorEl);
        highlightTimer = null;
      }, DEBOUNCE_MS);
      return;
    }
    window.Prism.highlightElement(editorEl);           // small: instant
  }

  // Build the CodeJar editor on top of a textarea. Returns a teardown fn.
  function enableRich(textarea) {
    if (textarea.__codeEditorWrap) return;             // already rich

    const wrap = document.createElement('div');
    wrap.className = 'code-editor-wrap';
    const pre = document.createElement('pre');
    pre.className = 'code-editor';
    const code = document.createElement('code');
    code.className = 'language-markup';

    // Seed with a trailing newline so the caret has somewhere to land and
    // contenteditable's last-line behavior stays consistent across browsers.
    const initial = (textarea.value || '').replace(/\n*$/, '\n');
    code.textContent = initial;
    pre.appendChild(code);
    wrap.appendChild(pre);

    textarea.parentNode.insertBefore(wrap, textarea);
    textarea.style.display = 'none';
    textarea.setAttribute('aria-hidden', 'true');
    textarea.setAttribute('tabindex', '-1');
    textarea.dataset.codeEditorActive = '1';

    const jar = CodeJar(code, highlightHtml, {
      tab: '  ',
      indentOn: /[<({[]$/,
      moveToNewLine: /^[)}\]]/,
      spellcheck: false,
      catchTab: true,
      preserveIdent: true,
      addClosing: true,
    });
    jar.onUpdate((newCode) => { textarea.value = newCode.replace(/\n$/, ''); });
    textarea.value = initial.replace(/\n$/, '');

    const onWrapClick = (e) => {
      if (e.target === code || code.contains(e.target)) return;
      code.focus();
      const range = document.createRange();
      range.selectNodeContents(code);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
    wrap.addEventListener('click', onWrapClick);

    highlightHtml(code);

    textarea.__codeEditorWrap = wrap;
    textarea.__codeEditorJar = jar;
    return function teardown() {
      try { jar.destroy(); } catch (_) { /* older CodeJar */ }
      if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
      wrap.removeEventListener('click', onWrapClick);
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      textarea.style.display = '';
      textarea.removeAttribute('aria-hidden');
      textarea.removeAttribute('tabindex');
      delete textarea.dataset.codeEditorActive;
      textarea.__codeEditorWrap = null;
      textarea.__codeEditorJar = null;
    };
  }

  // Mount the toolbar + mode machinery around one textarea.
  function mount(textarea) {
    if (textarea.dataset.codeEditorMounted === '1') return;
    textarea.dataset.codeEditorMounted = '1';

    const bar = document.createElement('div');
    bar.className = 'code-editor-toolbar';
    bar.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:6px;';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small';

    const note = document.createElement('span');
    note.className = 'muted';
    note.style.fontSize = '12px';

    bar.appendChild(btn);
    bar.appendChild(note);
    textarea.parentNode.insertBefore(bar, textarea);

    const isLarge = (textarea.value || '').length > UPGRADE_MAX_BYTES;
    const pref = getPref();
    let mode = (pref === 'rich' || pref === 'plain') ? pref : (isLarge ? 'plain' : 'rich');
    let teardown = null;

    function toPlain() {
      if (teardown) { teardown(); teardown = null; }
      btn.textContent = 'Syntax highlight: Off';
      note.textContent = isLarge ? 'Large template — highlighting off for speed' : '';
    }

    function toRich() {
      btn.textContent = 'Syntax highlight: On';
      note.textContent = isLarge ? 'Large template — highlighting may be slow' : '';
      waitForPrism(
        () => { teardown = enableRich(textarea); },
        () => { mode = 'plain'; toPlain(); } // Prism never loaded: stay plain
      );
    }

    function render() { (mode === 'rich' ? toRich : toPlain)(); }

    btn.addEventListener('click', () => {
      mode = (mode === 'rich') ? 'plain' : 'rich';
      setPref(mode);
      render();
    });

    render();
  }

  function init() {
    const targets = document.querySelectorAll('textarea[data-code-editor="html"]');
    targets.forEach(mount);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
