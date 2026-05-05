/**
 * Code editor enhancement for HTML/template textareas in the admin UI.
 *
 * Strategy: progressive enhancement. Every targeted textarea stays in the
 * DOM with the original `name` attribute, so form submission works exactly
 * as before. We add a contenteditable <pre><code> element next to it,
 * wire CodeJar to it for typing/indentation behavior, and pipe changes
 * back into the textarea on every keystroke.
 *
 * If this script fails to load (CSP, network, browser too old), the form
 * still works because the textarea is the real input. Just less pretty.
 *
 * Targeting: opt-in via data-code-editor="html". I deliberately don't
 * upgrade every textarea on the page - the auto-conversion-terms textarea
 * on /admin/pages/new is plain newline-separated text, not code.
 *
 * Bundle: imports CodeJar via ES module, expects Prism on window.Prism.
 */

import { CodeJar } from '/static/js/vendor/codejar.js';

(function () {
  'use strict';

  // Wait for Prism to be loaded - the <script src="prism.js"> tag is regular
  // (not a module) so it might still be parsing when this module starts.
  // Poll briefly; give up after 2s and degrade to a styled textarea.
  function waitForPrism(callback) {
    const start = Date.now();
    (function check() {
      if (window.Prism && window.Prism.languages && window.Prism.languages.markup) {
        callback();
      } else if (Date.now() - start > 2000) {
        console.warn('[code-editor] Prism not available; falling back to plain textarea');
        // No callback - leaves the textareas untouched
      } else {
        setTimeout(check, 30);
      }
    })();
  }

  function highlightHtml(editorEl) {
    // Prism.highlightElement expects the element to have a class like
    // "language-markup" - we set that when creating the element.
    //
    // Skip empty/whitespace-only content. Prism would strip the element's
    // innerHTML entirely (no tokens to render), which destroys the seed
    // newline we put in to anchor the cursor for empty editors. Once the
    // user types real content, this guard short-circuits and Prism runs
    // normally on every CodeJar onInput cycle.
    if (!window.Prism) return;
    const text = editorEl.textContent || '';
    if (!text.trim()) return;
    window.Prism.highlightElement(editorEl);
  }

  function upgradeTextarea(textarea) {
    if (textarea.dataset.codeEditorActive === '1') return;
    textarea.dataset.codeEditorActive = '1';

    // Create the editor element. <pre> + <code> is what Prism expects;
    // CodeJar attaches to the <code> for contenteditable behavior.
    const wrap = document.createElement('div');
    wrap.className = 'code-editor-wrap';

    const pre = document.createElement('pre');
    pre.className = 'code-editor';

    const code = document.createElement('code');
    code.className = 'language-markup';

    // Seed the contenteditable with at least a newline. An empty <code>
    // element with no text/children has nowhere for the browser to place
    // a caret - clicking inside refuses to focus, or the cursor lands at
    // an unreachable position. With a newline seed (zero-width-equivalent
    // for our purposes), the editor is immediately typable.
    //
    // Also: even non-empty content benefits from a trailing newline because
    // contenteditable's last-line behavior is fragile across browsers without
    // it. We normalize to "exactly one trailing newline".
    const initial = (textarea.value || '').replace(/\n*$/, '\n');
    code.textContent = initial;

    pre.appendChild(code);
    wrap.appendChild(pre);

    // Insert the editor right before the textarea, then hide the textarea.
    // We don't remove it - it must stay in the DOM for form submission to
    // pick up its value.
    textarea.parentNode.insertBefore(wrap, textarea);
    textarea.style.display = 'none';
    textarea.setAttribute('aria-hidden', 'true');
    textarea.setAttribute('tabindex', '-1');

    // Initialize CodeJar with our highlighter. CodeJar calls this on every
    // edit; we re-highlight the whole element via Prism.
    const jar = CodeJar(code, highlightHtml, {
      tab: '  ',                  // 2 spaces - matches our EJS templates
      indentOn: /[<({[]$/,        // auto-indent after opening brackets / tags
      moveToNewLine: /^[)}\]]/,
      spellcheck: false,
      catchTab: true,
      preserveIdent: true,
      addClosing: true,
    });

    // Pipe edits back into the hidden textarea so form submit works.
    // We strip the trailing newline we forced on init so the saved value
    // matches what the user actually typed.
    jar.onUpdate((newCode) => {
      textarea.value = newCode.replace(/\n$/, '');
    });
    // Also sync immediately - textarea.value already matches but ensure
    // consistency in case onUpdate doesn't fire on init in some browsers.
    textarea.value = initial.replace(/\n$/, '');

    // Make the whole wrapper a click target. Without this, clicking the
    // padding area of an empty editor fails to focus the contenteditable
    // because the click lands on the wrap div, not the <code> child.
    wrap.addEventListener('click', (e) => {
      // Don't steal clicks already handled by the contenteditable itself
      if (e.target === code || code.contains(e.target)) return;
      code.focus();
      // Place cursor at the end
      const range = document.createRange();
      range.selectNodeContents(code);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // If something else (validation, restore from autosave) updates the
    // textarea later, sync it back into the editor. Watch with an event
    // we synthesize when programmatic changes happen. This is a defensive
    // hook; in practice nothing currently does this.
    const sync = () => { jar.updateCode(textarea.value); };
    textarea.addEventListener('codeeditor:sync', sync);

    // Initial highlight pass
    highlightHtml(code);
  }

  function init() {
    waitForPrism(() => {
      const targets = document.querySelectorAll('textarea[data-code-editor="html"]');
      targets.forEach(upgradeTextarea);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
