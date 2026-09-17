import { packCaptureStyles } from "./captureStyles";

export const MAX_CAPTURE_SIZE = 8_000_000;

export type Capture = { format: 'proto-capture'; version: 1; title: string; source: string; html: string };

/** Accept only our versioned capture envelope, never arbitrary pasted JSON. */
export function parseCapture(text: string): Capture {
  if (text.length > MAX_CAPTURE_SIZE) throw new Error('Capture is too large. Select a smaller component.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Paste the capture copied by the bookmarklet, or import its .json file.'); }
  if (!value || typeof value !== 'object') throw new Error('This is not a component capture.');
  const capture = value as Partial<Capture>;
  if (capture.format !== 'proto-capture' || capture.version !== 1 || typeof capture.html !== 'string' || !capture.html.trim() || typeof capture.title !== 'string' || typeof capture.source !== 'string') {
    throw new Error('Unsupported capture. Use the current bookmarklet to capture again.');
  }
  return capture as Capture;
}

/** Imported snapshots are inert; editing and generation still use the usual HTML tools. */
export function captureHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,iframe,object,embed,base,link,meta[http-equiv]').forEach(el => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || ['srcdoc', 'action', 'formaction'].includes(attr.name)) el.removeAttribute(attr.name);
      if (['href', 'src', 'xlink:href'].includes(attr.name) && /^\s*(javascript|vbscript):/i.test(attr.value.replace(/[\r\n\t]/g, ''))) el.removeAttribute(attr.name);
    }
  }
  compactDocumentStyles(doc);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

/** Compact existing versions without removing their scripts or changing content. */
export function compactCaptureHtml(html: string): string {
  if (html.length < 100_000) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (!compactDocumentStyles(doc)) return html;
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

function compactDocumentStyles(doc: Document): boolean {
  // Large computed-style snapshots contain longhands, not authored shorthand.
  // Small authored styles (including the wrapper) remain inline and untouched.
  const elements = Array.from(doc.querySelectorAll<HTMLElement>('[style]')).filter(el => el.style.length > 100 && !el.hasAttribute('data-proto-style'));
  if (elements.length) {
    const packed = packCaptureStyles(elements.map(el => Array.from(el.style).map(property => [property, el.style.getPropertyValue(property) + (el.style.getPropertyPriority(property) ? ' !important' : '')])));
    const prefix = `p${doc.querySelectorAll('style').length}-`;
    packed.css = packed.css.replace(/data-proto-style~="c/g, `data-proto-style~="${prefix}c`);
    packed.tokens = packed.tokens.map(tokens => tokens.split(' ').map(token => prefix + token).join(' '));
    const sheet = doc.createElement('style');
    sheet.textContent = packed.css.replace(/<\/style/gi, '<\\/style');
    elements.forEach((el, index) => {
      el.setAttribute('data-proto-style', packed.tokens[index]);
      el.removeAttribute('style');
    });
    doc.head.append(sheet);
  }
  return elements.length > 0;
}
