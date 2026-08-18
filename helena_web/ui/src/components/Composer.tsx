import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandInfo, ModelInfo } from "../types";
import { ArrowUpIcon, ChevronIcon, CloseIcon, GlobeIcon, PlusIcon, StopIcon } from "./Icons";

export interface Attachment {
  path: string;
  name: string;
  isImage: boolean;
}

/**
 * The one input. It carries the terminal's affordances across: slash-command
 * completion with the same list the REPL completes from, a model switcher that
 * runs `/model`, and web search that runs `/search`.
 */
export function Composer({
  busy,
  model,
  models,
  commands,
  attachments,
  onSend,
  onStop,
  onAttach,
  onRemoveAttachment,
  onPickModel,
  centered,
}: {
  busy: boolean;
  model: string;
  models: ModelInfo[];
  commands: CommandInfo[];
  attachments: Attachment[];
  onSend: (text: string, webSearch: boolean) => void;
  onStop: () => void;
  onAttach: (files: FileList | File[]) => void;
  onRemoveAttachment: (path: string) => void;
  onPickModel: (name: string) => void;
  centered: boolean;
}) {
  const [text, setText] = useState("");
  const [webSearch, setWebSearch] = useState(false);
  const [menu, setMenu] = useState<"none" | "model" | "plus">("none");
  const [highlight, setHighlight] = useState(0);
  const [dragging, setDragging] = useState(false);

  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  // Slash completion mirrors the terminal completer: only while the line is a
  // single bare `/word`.
  const matches = useMemo(() => {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/") || /\s/.test(trimmed)) return [];
    return commands.filter((command) => command.name.startsWith(trimmed.toLowerCase()));
  }, [text, commands]);

  useEffect(() => setHighlight(0), [text]);

  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    if (menu === "none") return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu("none");
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const submit = (value = text) => {
    const body = value.trim();
    if (!body && attachments.length === 0) return;
    onSend(body, webSearch);
    setText("");
    setWebSearch(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && matches.length > 0 && text.trim() !== matches[highlight].name)) {
        event.preventDefault();
        setText(`${matches[highlight].name} `);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setText("");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0) {
      event.preventDefault();
      onAttach(files);
    }
  };

  const ready = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className={`composer-wrap${centered ? " centered" : ""}`}>
      <div
        className={`composer${dragging ? " dragging" : ""}`}
        ref={root}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length) onAttach(event.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((attachment) => (
              <span className="chip" key={attachment.path}>
                {attachment.isImage ? "▣" : "◆"} {attachment.name}
                <button onClick={() => onRemoveAttachment(attachment.path)} aria-label="Remove">
                  <CloseIcon size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textarea}
          value={text}
          rows={1}
          placeholder={webSearch ? "Search the web" : "Send a message"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          autoFocus
          spellCheck={false}
        />

        <div className="composer-row">
          <button
            className="round"
            onClick={() => setMenu(menu === "plus" ? "none" : "plus")}
            title="Attach a file"
            aria-label="Attach a file"
          >
            <PlusIcon />
          </button>
          <button
            className={`round${webSearch ? " on" : ""}`}
            onClick={() => setWebSearch(!webSearch)}
            title="Web search — sends this message as /search"
            aria-label="Toggle web search"
          >
            <GlobeIcon />
          </button>

          <div className="spacer" />

          <button
            className="model-pill"
            onClick={() => setMenu(menu === "model" ? "none" : "model")}
            title="Switch model (/model)"
          >
            <span>{model || "server default"}</span>
            <ChevronIcon />
          </button>

          {busy ? (
            <button className="round stop" onClick={onStop} title="Stop (Esc)" aria-label="Stop">
              <StopIcon />
            </button>
          ) : (
            <button
              className={`round send${ready ? " ready" : ""}`}
              onClick={() => submit()}
              disabled={!ready}
              title="Send (Enter)"
              aria-label="Send"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>

        {matches.length > 0 && (
          <div className="popover above left" style={{ minWidth: "min(520px, 100%)" }}>
            {matches.map((command, index) => (
              <button
                key={command.name}
                className={`row${index === highlight ? " active" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => {
                  setText(`${command.name} `);
                  textarea.current?.focus();
                }}
              >
                <span className="key mono">{command.name}</span>
                <span className="meta">{command.description}</span>
              </button>
            ))}
          </div>
        )}

        {menu === "model" && (
          <div className="popover above right" style={{ right: 44, minWidth: 280 }}>
            <div className="section">Installed models</div>
            {models.length === 0 && <div className="empty">No models pulled — try /pull qwen2.5:7b-instruct</div>}
            {models.map((info) => (
              <button
                key={info.name}
                className={`row${info.name === model ? " active" : ""}`}
                onClick={() => {
                  onPickModel(info.name);
                  setMenu("none");
                }}
              >
                <span className="key mono">{info.name}</span>
                <span className="meta">
                  {[info.parameter_size, info.supports_tools ? "tools" : "", info.supports_vision ? "vision" : ""]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))}
          </div>
        )}

        {menu === "plus" && (
          <div className="popover above left" style={{ left: 4, minWidth: 260 }}>
            <button
              className="row"
              onClick={() => {
                imageInput.current?.click();
                setMenu("none");
              }}
            >
              <span className="key">▣ Attach an image</span>
              <span className="meta">/image</span>
            </button>
            <button
              className="row"
              onClick={() => {
                fileInput.current?.click();
                setMenu("none");
              }}
            >
              <span className="key">◆ Load a file</span>
              <span className="meta">/read</span>
            </button>
          </div>
        )}

        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            if (event.target.files?.length) onAttach(event.target.files);
            event.target.value = "";
          }}
        />
        <input
          ref={fileInput}
          type="file"
          hidden
          onChange={(event) => {
            if (event.target.files?.length) onAttach(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      <div className="hint">
        <kbd>/</kbd> commands · <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline ·{" "}
        <kbd>Esc</kbd> interrupt
      </div>
    </div>
  );
}
