"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MessagePart } from "@/lib/types";
import { messageText } from "@/lib/mentions";
import type { Mentionable } from "@/lib/mentions";
import { isImageFile, prepareImage } from "@/lib/images";
import { KindIcon, kindIconSvg, kindTextClass, mentionChipClass, outputKind } from "./nodeKinds";

/**
 * Plain-text chat input with @mention chips. The DOM is the source of truth
 * while typing; `serialize` preserves chip IDs alongside their readable labels. Typing "@" opens an autocomplete over the canvas's node names.
 */
export default function MentionInput({
  options,
  placeholder,
  disabled,
  extraAttachments,
  allowEmpty,
  onSubmit,
}: {
  options: Mentionable[];
  placeholder: string;
  /** While true, Enter keeps the draft instead of submitting into a busy node. */
  disabled?: boolean;
  /** Widgets shown in the same row as attached photos (annotation chips, etc). */
  extraAttachments?: ReactNode;
  /** Allow submit with no text and no images (e.g. annotations waiting above). */
  allowEmpty?: boolean;
  onSubmit: (text: string, images: string[], parts: MessagePart[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [images, setImages] = useState<string[]>([]);

  useEffect(() => {
    ref.current?.querySelectorAll<HTMLElement>("[data-node-id]").forEach((chip) => {
      const target = options.find((option) => option.id === chip.dataset.nodeId);
      if (!target) return;
      chip.dataset.mention = target.name;
      if (chip.firstChild?.nodeType === Node.TEXT_NODE) chip.firstChild.textContent = `@${target.name}`;
    });
  }, [options]);

  async function addImages(files: FileList | File[]) {
    const accepted = [...files].filter(isImageFile);
    if (!accepted.length) return;
    const prepared = await Promise.all(accepted.map(prepareImage));
    setImages((current) => [...current, ...prepared]);
  }

  const filtered =
    query === null
      ? []
      : options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()));

  // Keep the highlight in range as the query narrows the list.
  const activeIndex = Math.min(active, Math.max(filtered.length - 1, 0));

  /** The "@query" run of text immediately before the caret, if any. */
  function caretMention(): { node: Text; start: number; end: number; query: string } | null {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !ref.current) return null;
    const range = selection.getRangeAt(0);
    if (!range.collapsed || !ref.current.contains(range.startContainer)) return null;
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
    const node = range.startContainer as Text;
    const upToCaret = (node.textContent ?? "").slice(0, range.startOffset);
    const match = upToCaret.match(/@([^\s@]*)$/);
    if (!match) return null;
    return {
      node,
      start: upToCaret.length - match[0].length,
      end: range.startOffset,
      query: match[1],
    };
  }

  function refreshMenu() {
    const hit = caretMention();
    if (!hit) {
      setQuery(null);
      return;
    }
    if (hit.query !== query) setActive(0);
    setQuery(hit.query);
  }

  function insertMention(option: Mentionable) {
    const hit = caretMention();
    if (!hit) return setQuery(null);

    hit.node.deleteData(hit.start, hit.end - hit.start);
    const rest = hit.node.splitText(hit.start);

    // Colored by the node's output type at insertion time; the transcript chip
    // re-resolves the type on every render once the message is sent.
    const kind = outputKind(option.tab);
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.mention = option.name;
    chip.dataset.nodeId = option.id;
    chip.className = mentionChipClass(kind);
    chip.textContent = `@${option.name}`;
    const icon = document.createElement("span");
    icon.className = "inline-flex";
    icon.innerHTML = kindIconSvg(kind);
    chip.appendChild(icon);

    const space = document.createTextNode(" ");
    rest.parentNode!.insertBefore(chip, rest);
    rest.parentNode!.insertBefore(space, rest);

    const selection = window.getSelection()!;
    const caret = document.createRange();
    caret.setStart(space, 1);
    caret.collapse(true);
    selection.removeAllRanges();
    selection.addRange(caret);

    setQuery(null);
  }

  function serialize(el: Node): MessagePart[] {
    const parts: MessagePart[] = [];
    function text(value: string) {
      const last = parts.at(-1);
      if (last?.type === "text") last.value += value;
      else parts.push({ type: "text", value });
    }
    function visit(parent: Node) {
      parent.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) text((child.textContent ?? "").replace(/ /g, " "));
        else if (child instanceof HTMLElement && child.dataset.mention && child.dataset.nodeId) {
          const current = options.find((option) => option.id === child.dataset.nodeId);
          parts.push({ type: "mention", nodeId: child.dataset.nodeId, name: current?.name ?? child.dataset.mention });
        } else if (child.nodeName === "BR") text("\n");
        else if (child instanceof HTMLElement) { text("\n"); visit(child); }
      });
    }
    visit(el);
    if (parts[0]?.type === "text") parts[0].value = parts[0].value.trimStart();
    const last = parts.at(-1);
    if (last?.type === "text") last.value = last.value.trimEnd();
    return parts.filter((part) => part.type !== "text" || part.value);
  }

  function submit() {
    if (!ref.current || disabled) return;
    const parts = serialize(ref.current);
    const text = messageText(parts);
    if (!text && !images.length && !allowEmpty) return;
    ref.current.innerHTML = "";
    setQuery(null);
    setImages([]);
    onSubmit(text, images, parts);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (query !== null && filtered.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        return setActive((a) => (a + 1) % filtered.length);
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        return setActive((a) => (a - 1 + filtered.length) % filtered.length);
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        return insertMention(filtered[activeIndex]);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        return setQuery(null);
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void addImages(e.dataTransfer.files);
      }}
    >
      {query !== null && filtered.length > 0 && (
        <div className="nodrag absolute bottom-full left-0 right-0 z-20 mb-2 max-h-40 overflow-y-auto border border-neutral-300 bg-white">
          {filtered.map((option, i) => (
            <button
              key={option.id}
              className={`flex w-full items-center gap-2 px-2 py-1 text-left ${
                i === activeIndex ? "bg-neutral-100 text-neutral-900" : "text-neutral-600"
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(option)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="min-w-0 flex-1 truncate">@{option.name}</span>
              <KindIcon kind={outputKind(option.tab)} className={kindTextClass(outputKind(option.tab))} />
            </button>
          ))}
        </div>
      )}
      {(images.length > 0 || extraAttachments) && (
        <div className="nodrag mb-1 flex shrink-0 flex-wrap gap-1">
          {extraAttachments}
          {images.map((src, i) => (
            <span key={i} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL thumbnail */}
              <img src={src} alt="attached" className="h-10 border border-neutral-300" />
              <button
                className="absolute -top-1 -right-1 h-4 w-4 border border-neutral-300 bg-white leading-none text-neutral-500 hover:text-red-600"
                onClick={() => setImages((current) => current.filter((_, j) => j !== i))}
                title="remove image"
                aria-label="remove image"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div
        ref={ref}
        className="nodrag nowheel min-h-0 w-full flex-1 cursor-text overflow-y-auto whitespace-pre-wrap break-words outline-none"
        contentEditable
        data-placeholder={placeholder}
        spellCheck={false}
        onInput={refreshMenu}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(null)}
        onPaste={(event) => {
          // Screenshots arrive as clipboard files; everything else stays plaintext,
          // since pasted HTML would otherwise land as markup.
          event.preventDefault();
          const files = [...event.clipboardData.files].filter(isImageFile);
          if (files.length) {
            void addImages(files);
            return;
          }
          document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
        }}
      />
    </div>
  );
}
