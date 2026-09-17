/* Self-contained: installed as a bookmarklet, with no network script dependency. */
(() => {
  try {
  function packCaptureStyles(styles) {
    const owners = new Map();
    styles.forEach((declarations, index) => {
      for (const [property, value] of declarations) {
        const declaration = `${property}:${value};`;
        const indices = owners.get(declaration);
        if (indices) indices.push(index); else owners.set(declaration, [index]);
      }
    });
    const groups = new Map();
    for (const [declaration, indices] of owners) {
      const key = indices.join(',');
      const group = groups.get(key);
      if (group) group.declarations.push(declaration); else groups.set(key, { indices, declarations: [declaration] });
    }
    const tokens = styles.map(() => []);
    const rules = [];
    let id = 0;
    for (const { indices, declarations } of groups.values()) {
      const token = `c${id++}`;
      indices.forEach(index => tokens[index].push(token));
      const selector = `[data-proto-style~="${token}"]`;
      rules.push(`${selector}${selector}{${declarations.join('')}}`);
    }
    return { css: rules.join('\n'), tokens: tokens.map(values => values.join(' ')) };
  }
  const key = '__protoCaptureCancel';
  if (window[key]) window[key]();
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none';
  const shadow = host.attachShadow({ mode: 'open' });
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:2px solid #ef4444;background:rgba(239,68,68,.08);pointer-events:none;box-sizing:border-box';
  const hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;bottom:20px;left:20px;max-width:400px;padding:14px;background:#171717;color:white;font:14px/1.5 system-ui;box-shadow:0 4px 24px #0004;pointer-events:auto';
  hint.textContent = 'Capture: hover and click a component. ↑ selects its parent. Esc cancels. ';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => cleanup();
  hint.append(cancel);
  shadow.append(box, hint);
  document.documentElement.append(host);
  let selected = null;
  function highlight(element) {
    selected = element;
    const r = element.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }
  function move(e) { if (e.target instanceof Element && e.target !== host) highlight(e.target); }
  function keyboard(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); }
    if (e.key === 'ArrowUp' && selected?.parentElement) { e.preventDefault(); e.stopImmediatePropagation(); highlight(selected.parentElement); }
  }
  function cleanup() {
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('click', capture, true);
    document.removeEventListener('keydown', keyboard, true);
    host.remove();
    delete window[key];
  }
  const safeUrl = (value) => {
    try { const u = new URL(value, document.baseURI); return /^(https?:|data:|blob:)$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
  };
  async function capture(e) {
    if (e.target === host || !selected) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = selected;
    cleanup();
    try {
      if (target.querySelectorAll('*').length > 4000) throw new Error('Select a smaller component (under 4,000 elements).');
      const clone = target.cloneNode(true);
      const originals = [target, ...target.querySelectorAll('*')];
      const copies = [clone, ...clone.querySelectorAll('*')];
      const fonts = new Set();
      originals.forEach((original, i) => {
        const copy = copies[i];
        if (original.matches('script,iframe,object,embed,link,meta,base,style,noscript')) { copy.remove(); return; }
        for (const attr of [...copy.attributes]) {
          if (/^on/i.test(attr.name) || ['srcdoc', 'nonce', 'integrity', 'autofocus', 'srcset', 'action', 'formaction'].includes(attr.name)) copy.removeAttribute(attr.name);
        }
        for (const attr of ['href', 'src', 'poster', 'xlink:href']) {
          if (copy.hasAttribute(attr)) copy.setAttribute(attr, safeUrl(copy.getAttribute(attr)));
        }
        const computed = getComputedStyle(original);
        computed.fontFamily.split(',').forEach(family => fonts.add(family.trim().replace(/^['"]|['"]$/g, '').toLowerCase()));
        const styles = [];
        for (const prop of computed) {
          if (prop.startsWith('--')) continue;
          styles.push(prop + ':' + computed.getPropertyValue(prop) + ';');
        }
        copy.setAttribute('style', styles.join('') + 'animation:none!important;transition:none!important;');
        if (original instanceof HTMLImageElement) copy.setAttribute('src', safeUrl(original.currentSrc || original.src));
        if (original instanceof HTMLInputElement) {
          copy.removeAttribute('value');
          if (!['password', 'hidden', 'file'].includes(original.type)) copy.setAttribute('value', original.value);
          if (original.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked');
        }
        if (original instanceof HTMLTextAreaElement) copy.textContent = original.value;
        if (original instanceof HTMLOptionElement) { if (original.selected) copy.setAttribute('selected', ''); else copy.removeAttribute('selected'); }
        if (original instanceof HTMLCanvasElement) {
          try { const img = document.createElement('img'); img.src = original.toDataURL(); img.setAttribute('style', copy.getAttribute('style')); copy.replaceWith(img); } catch { /* Cross-origin canvases cannot be exported. */ }
        }
      });
      if (!clone.outerHTML || target.matches('script,iframe,object,embed,link,meta,base,style,noscript')) throw new Error('Select a visible HTML component instead.');
      // Lift the selected component out of its original page positioning.
      for (const [prop, value] of Object.entries({ position: 'relative', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', margin: '0', transform: 'none' })) clone.style.setProperty(prop, value);
      const fontRules = new Set();
      const seenSheets = new Set();
      function readSheet(sheet) {
        if (!sheet || seenSheets.has(sheet)) return;
        seenSheets.add(sheet);
        function readRules(rules) {
          for (const rule of rules) {
            if (rule.type === 5) {
              const family = rule.style.getPropertyValue('font-family').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
              if (fonts.has(family)) fontRules.add(rule.cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (_, quote, url) => {
                try { return 'url(' + JSON.stringify(new URL(url, sheet.href || document.baseURI).href) + ')'; } catch { return 'url("")'; }
              }));
            }
            if (rule.styleSheet) readSheet(rule.styleSheet);
            if (rule.cssRules) readRules(rule.cssRules);
          }
        }
        try { readRules(sheet.cssRules); } catch { /* Cross-origin stylesheets may deny access. */ }
      }
      for (const sheet of document.styleSheets) readSheet(sheet);
      const styled = [clone, ...clone.querySelectorAll('[style]')].filter(el => el.style && el.style.length > 100);
      const packed = packCaptureStyles(styled.map(el => Array.from(el.style).map(property => [property, el.style.getPropertyValue(property) + (el.style.getPropertyPriority(property) ? ' !important' : '')])));
      styled.forEach((el, index) => { el.setAttribute('data-proto-style', packed.tokens[index]); el.removeAttribute('style'); });
      // Embed accessible fonts: sandboxed previews cannot rely on the source
      // server allowing cross-origin font requests. Keep a bounded asset budget.
      const embeddedFonts = new Map();
      let fontBytes = 0;
      let fontFailures = 0;
      hint.textContent = 'Preparing capture and fonts…';
      box.remove(); document.documentElement.append(host);
      const fontUrls = [...new Set([...fontRules].flatMap(rule => [...rule.matchAll(/url\("([^"\n]+)"\)/g)].map(match => match[1])))].filter(url => !url.startsWith('data:'));
      fontFailures = Math.max(0, fontUrls.length - 24);
      await Promise.all(fontUrls.slice(0, 24).map(async url => {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error('Font unavailable');
          const blob = await response.blob();
          if (blob.size > 300_000 || fontBytes + blob.size > 1_000_000) throw new Error('Font budget exceeded');
          fontBytes += blob.size;
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
          });
          embeddedFonts.set(url, data);
        } catch { fontFailures++; }
      }));
      const fontCss = [...fontRules].map(rule => rule.replace(/url\("([^"\n]+)"\)/g, (match, url) => 'url(' + JSON.stringify(embeddedFonts.get(url) || url) + ')')).join('\n');
      const css = [fontCss, packed.css].join('\n').replace(/<\/style/gi, '<\\/style');
      const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style></head><body style="margin:0;padding:16px;background:white">' + clone.outerHTML + '</body></html>';
      const payload = JSON.stringify({ format: 'proto-capture', version: 1, title: document.title, source: location.origin + location.pathname, html });
      const download = () => {
        const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'component.capture.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
      const done = (message) => {
        hint.replaceChildren(document.createTextNode(message + (fontFailures ? ' Some fonts could not be embedded and may use a fallback.' : '') + ' '));
        const save = document.createElement('button'); save.textContent = 'Download file'; save.onclick = download;
        const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => host.remove();
        const copyButton = document.createElement('button'); copyButton.textContent = 'Copy capture'; copyButton.onclick = () => { navigator.clipboard?.writeText(payload).then(() => { copyButton.textContent = 'Copied!'; }, () => { copyButton.textContent = 'Use Download file'; }); };
        hint.append(copyButton, save, close); box.remove(); document.documentElement.append(host);
      };
      if (payload.length > 8_000_000) throw new Error('Capture is too large. Select a smaller component.');
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(payload).then(() => done('Copied! Paste into the Capture tab in your canvas.'), () => done('Clipboard unavailable. Download and import in the Capture tab.'));
      else done('Download and import in the Capture tab.');
    } catch (error) { host.remove(); alert('Capture failed: ' + error.message); }
  }
  window[key] = cleanup;
  document.addEventListener('pointermove', move, true);
  document.addEventListener('click', capture, true);
  document.addEventListener('keydown', keyboard, true);
  } catch (error) {
    console.error('Capture could not start:', error);
    alert('Capture could not start: ' + (error instanceof Error ? error.message : String(error)));
  }
})();
