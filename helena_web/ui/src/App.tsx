import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribe } from "./api";
import { applyEvents, emptyTranscript, pendingPermission } from "./transcript";
import type { Transcript as TranscriptState } from "./transcript";
import type { ChatSummary, CommandInfo, HelenaEvent, ModelInfo, SessionState } from "./types";
import { Composer, type Attachment } from "./components/Composer";
import { DownIcon, PanelIcon } from "./components/Icons";
import { LaunchPanel } from "./components/LaunchPanel";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";

const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
const isImageName = (name: string) => IMAGE_SUFFIXES.some((ext) => name.toLowerCase().endsWith(ext));

export default function App() {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [session, setSession] = useState<SessionState | null>(null);
  const [connected, setConnected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [modes, setModes] = useState<string[]>(["ask", "auto", "plan", "yolo"]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [toast, setToast] = useState("");
  const [pinned, setPinned] = useState(true);

  const scroller = useRef<HTMLDivElement>(null);
  const buffer = useRef<HelenaEvent[]>([]);
  const frame = useRef<number | null>(null);
  const activeIdRef = useRef<string | null>(null);

  const busy = session?.busy ?? false;
  const pending = useMemo(() => pendingPermission(transcript), [transcript]);
  const hasContent = transcript.items.length > 0;

  const complain = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 4000);
  }, []);

  // --- bootstrap ---------------------------------------------------------

  const refreshChats = useCallback(async () => {
    const { chats: rows } = await api.listChats();
    setChats(rows);
    return rows;
  }, []);

  useEffect(() => {
    api
      .commands()
      .then((data) => {
        setCommands(data.commands);
        setModes(data.modes);
      })
      .catch(() => complain("Could not load the command list."));

    api
      .models()
      .then((data) => {
        setModels(data.models ?? []);
        setDefaultModel(data.default_model ?? "");
      })
      .catch(() => undefined);

    refreshChats()
      .then(async (rows) => {
        if (rows.length > 0) {
          setActiveId(rows[0].id);
        } else {
          const chat = await api.newChat();
          setChats([chat]);
          setActiveId(chat.id);
        }
      })
      .catch((exc: Error) => complain(exc.message));
  }, [refreshChats, complain]);

  // --- the event stream --------------------------------------------------

  const flush = useCallback(() => {
    frame.current = null;
    const events = buffer.current;
    buffer.current = [];
    if (events.length === 0) return;
    setTranscript((state) => applyEvents(state, events));
    const last = events.filter((event) => event.type === "state").pop();
    if (last) setSession(last as unknown as SessionState);
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
    if (!activeId) return;
    setTranscript(emptyTranscript());
    setSession(null);
    buffer.current = [];

    const stop = subscribe(
      activeId,
      0,
      (event) => {
        if (activeIdRef.current !== activeId) return;
        buffer.current.push(event);
        // Coalesce to one render per frame: a fast model streams faster than
        // React should reconcile.
        if (frame.current === null) frame.current = requestAnimationFrame(flush);
      },
      setConnected,
    );
    return () => {
      stop();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [activeId, flush]);

  // Keep the sidebar's titles and busy dots current without polling hard.
  useEffect(() => {
    const id = window.setInterval(() => {
      refreshChats().catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(id);
  }, [refreshChats]);

  // --- scrolling ---------------------------------------------------------

  useEffect(() => {
    if (!pinned) return;
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcript, pinned]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setPinned(distance < 80);
  };

  // --- actions -----------------------------------------------------------

  const newChat = useCallback(async () => {
    if (activeId && transcript.items.length === 0) {
      document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
      return;
    }
    try {
      const chat = await api.newChat();
      setChats((rows) => [chat, ...rows]);
      setActiveId(chat.id);
      setAttachments([]);
      setPinned(true);
    } catch (exc) {
      complain((exc as Error).message);
    }
  }, [activeId, complain, transcript.items.length]);

  const deleteChat = useCallback(
    async (id: string) => {
      try {
        await api.deleteChat(id);
        const rows = await refreshChats();
        if (id === activeId) {
          if (rows.length > 0) setActiveId(rows[0].id);
          else await newChat();
        }
      } catch (exc) {
        complain((exc as Error).message);
      }
    },
    [activeId, complain, newChat, refreshChats],
  );

  const send = useCallback(
    async (text: string, webSearch: boolean) => {
      if (!activeId) return;
      const images = attachments.filter((item) => item.isImage).map((item) => item.path);
      const files = attachments.filter((item) => !item.isImage).map((item) => item.path);
      let body = text;
      if (webSearch && body && !body.startsWith("/")) body = `/search ${body}`;
      try {
        await api.send(activeId, body, images, files);
        setAttachments([]);
        setPinned(true);
      } catch (exc) {
        complain((exc as Error).message);
      }
    },
    [activeId, attachments, complain],
  );

  const runCommand = useCallback(
    (command: string) => {
      if (!activeId) return;
      api.send(activeId, command).catch((exc: Error) => complain(exc.message));
      setPinned(true);
    },
    [activeId, complain],
  );

  const stop = useCallback(() => {
    if (activeId) api.interrupt(activeId).catch(() => undefined);
  }, [activeId]);

  const answer = useCallback(
    (requestId: string, value: string) => {
      if (!activeId) return;
      api.answerPermission(activeId, requestId, value).catch((exc: Error) => complain(exc.message));
    },
    [activeId, complain],
  );

  const attach = useCallback(
    async (files: FileList | File[]) => {
      if (!activeId) return;
      for (const file of Array.from(files)) {
        try {
          const saved = await api.upload(activeId, file);
          setAttachments((rows) => [
            ...rows,
            {
              path: saved.path,
              name: saved.name,
              isImage: saved.content_type.startsWith("image/") || isImageName(saved.name),
            },
          ]);
        } catch (exc) {
          complain((exc as Error).message);
        }
      }
    },
    [activeId, complain],
  );

  // --- keyboard ----------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        newChat();
        return;
      }
      if (meta && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        if (launchOpen) {
          setLaunchOpen(false);
          return;
        }
        if (busy) stop();
        return;
      }
      // Terminal-style permission answers, but only when the composer is not
      // where the keystroke was meant to go.
      const target = event.target as HTMLElement | null;
      const typing = target && ["TEXTAREA", "INPUT"].includes(target.tagName);
      if (pending && !typing && !meta) {
        const choice = { y: "once", a: "always", s: "session", n: "no" }[event.key.toLowerCase()];
        if (choice) {
          event.preventDefault();
          answer(pending.id, choice);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer, busy, launchOpen, newChat, pending, stop]);

  // --- render ------------------------------------------------------------

  const activeChat = chats.find((chat) => chat.id === activeId);
  const model = session?.model || defaultModel;
  const mode = session?.mode || activeChat?.mode || "ask";

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        chats={chats}
        activeId={activeId}
        onToggle={() => setSidebarOpen(false)}
        onNew={newChat}
        onLaunch={() => setLaunchOpen(true)}
        onSelect={(id) => {
          setActiveId(id);
          setAttachments([]);
          setPinned(true);
        }}
        onDelete={deleteChat}
      />

      <main className="main">
        <div className="topbar">
          {!sidebarOpen && (
            <button
              className="icon-button"
              onClick={() => setSidebarOpen(true)}
              title="Show sidebar (⌘B)"
              aria-label="Show sidebar"
            >
              <PanelIcon />
            </button>
          )}
          <div className="crumb">
            <span className={`status-dot${connected ? (busy ? "" : " idle") : " off"}`} />
            <span className="path mono">{session?.workspace ?? ""}</span>
          </div>
          <div className="spacer" />
          <button
            className="pill ghost"
            title="Permission mode — click to change"
            onClick={() => setLaunchOpen(true)}
          >
            <span className={`mode-${mode}`}>{mode}</span>
          </button>
        </div>

        <div className={`conversation${hasContent ? "" : " blank"}`}>
          <div
            className={`scroll${hasContent ? "" : " empty"}`}
            ref={scroller}
            onScroll={onScroll}
          >
            {!hasContent && (
              <div className="hero">
                <h1>H.E.L.E.N.A</h1>
                <p>Highly Efficient Logic Engine Network Assistant</p>
              </div>
            )}
            {hasContent && (
              <div className="stream">
                <Transcript items={transcript.items} onAnswer={answer} />
              </div>
            )}
          </div>

          {!pinned && hasContent && (
            <button
              className="jump"
              onClick={() => {
                setPinned(true);
                const node = scroller.current;
                if (node) node.scrollTop = node.scrollHeight;
              }}
            >
              <DownIcon size={12} /> Jump to latest
            </button>
          )}

          <Composer
            busy={busy}
            model={model}
            models={models}
            commands={commands}
            attachments={attachments}
            centered={!hasContent}
            onSend={send}
            onStop={stop}
            onAttach={attach}
            onRemoveAttachment={(path) =>
              setAttachments((rows) => rows.filter((row) => row.path !== path))
            }
            onPickModel={(name) => runCommand(`/model ${name}`)}
          />
        </div>
      </main>

      {launchOpen && (
        <LaunchPanel
          onClose={() => setLaunchOpen(false)}
          onRun={runCommand}
          models={models}
          mode={mode}
          modes={modes}
          onMode={(value) => runCommand(`/mode ${value}`)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
