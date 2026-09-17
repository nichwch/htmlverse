"use client";

import { useEffect, useRef, useState } from 'react';
import { captureHtml, MAX_CAPTURE_SIZE, parseCapture } from '@/lib/capture';

export default function CapturePane({ onImport, hasHtml, disabled }: { onImport: (html: string) => void; hasHtml: boolean; disabled: boolean }) {
  const bookmark = useRef<HTMLAnchorElement>(null);
  const [code, setCode] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showInstall, setShowInstall] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/capture.js', { signal: controller.signal, cache: 'no-store' })
      .then(response => { if (!response.ok) throw new Error('Could not load bookmarklet. Reopen this tab to retry.'); return response.text(); })
      .then(script => {
        const url = 'javascript:' + encodeURIComponent(script);
        setCode(url);
        // React deliberately blocks javascript href props; this trusted local
        // script is a draggable bookmark, never an application navigation link.
        bookmark.current?.setAttribute('href', url);
      }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, []);
  function importText(value: string) {
    if (disabled) return;
    try {
      const capture = parseCapture(value);
      const html = captureHtml(capture.html);
      onImport(html);
      setText(''); setError('');
      setNotice(`Imported ${capture.title || 'component'} (${Math.round(html.length / 1024)} KB${html.length < capture.html.length ? `, reduced from ${Math.round(capture.html.length / 1024)} KB` : ''}). Open Chat to iterate, or HTML to edit.`);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not import capture.'); }
  }
  return <div className="nodrag nowheel min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-xs leading-relaxed">
    <div><h3 className="font-medium text-neutral-900">Capture a component</h3><p className="mt-1 text-neutral-500">Bring a view from your running project into this node as editable HTML.</p></div>
    <div className="space-y-2">
      <p><strong>1.</strong> Drag this button to your bookmarks bar.</p>
      <a ref={bookmark} draggable={Boolean(code)} aria-disabled={!code} onClick={event => { event.preventDefault(); setShowInstall(true); }} className="inline-block cursor-grab border border-neutral-300 bg-neutral-50 px-3 py-2 font-medium text-neutral-900">{code ? 'Send to canvas ↗' : 'Loading bookmarklet…'}</a>
      <details open={showInstall} onToggle={event => setShowInstall(event.currentTarget.open)} className="text-neutral-500"><summary className="cursor-pointer">Install manually / troubleshoot</summary><p className="my-1">This button installs a bookmark; clicking it here does not start capture. Drag it to your bookmarks bar, then click the saved bookmark on your other project’s page.</p><p className="my-1">Alternatively, create a bookmark and paste the code below into its URL field. It must begin with javascript:. Replace any older capture bookmark with this one.</p><textarea aria-label="Bookmarklet URL" readOnly value={code} onFocus={event => event.target.select()} className="h-16 w-full border border-neutral-300 p-1 text-[10px]" /><p className="my-1">If the saved bookmark still does nothing, check the browser console for an error. Bookmarklets cannot run on browser settings or new-tab pages, and some sites block them.</p></details>
    </div>
    <p><strong>2.</strong> Open your other project and click the bookmark. Hover and click a component; press ↑ to select its parent, or Esc to cancel.</p>
    <div className="space-y-2"><p><strong>3.</strong> Paste the capture below, or import the downloaded file.</p>
      <textarea aria-label="Component capture" value={text} onChange={event => setText(event.target.value)} placeholder="Paste your capture here…" className="h-24 w-full resize-y border border-neutral-300 p-2 outline-none focus:border-neutral-900" />
      <div className="flex flex-wrap gap-2"><button disabled={disabled || !text.trim()} onClick={() => importText(text)} className="border border-neutral-300 px-2 py-1 disabled:opacity-40">Import capture</button>
      <label className="cursor-pointer border border-neutral-300 px-2 py-1">Import file<input type="file" accept=".json,application/json" aria-label="Import capture file" disabled={disabled} className="sr-only" onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (!file) return;
        if (file.size > MAX_CAPTURE_SIZE) { setError('Capture is too large. Select a smaller component.'); return; }
        try { importText(await file.text()); } catch { setError('Could not read this file.'); }
      }} /></label></div>
    </div>
    {hasHtml && <p className="text-neutral-500">Import replaces this node’s HTML. The previous version is kept for restore through Chat.</p>}
    {disabled && <p className="text-neutral-500">Wait for generation to finish before importing.</p>}
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {notice && <p role="status" className="text-neutral-700">{notice}</p>}
    <p className="text-neutral-400">Captures include visible content and form values. They are static snapshots, not connected to your source code. Some sites block bookmarklets; custom fonts, embedded views, and private images may not transfer.</p>
  </div>;
}
