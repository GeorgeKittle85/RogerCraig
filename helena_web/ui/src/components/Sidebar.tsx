import type { ChatSummary } from "../types";
import { NewChatIcon, PanelIcon, RocketIcon, TrashIcon } from "./Icons";

/** Buckets match how people think about their own history, not the clock. */
function bucketOf(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "Older";
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - then.getTime()) / 86_400_000);
  if (days < 0) return "Today";
  if (days === 0) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

const ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];

export function Sidebar({
  open,
  chats,
  activeId,
  onToggle,
  onNew,
  onLaunch,
  onSelect,
  onDelete,
}: {
  open: boolean;
  chats: ChatSummary[];
  activeId: string | null;
  onToggle: () => void;
  onNew: () => void;
  onLaunch: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const groups = new Map<string, ChatSummary[]>();
  for (const chat of chats) {
    const bucket = bucketOf(chat.updated_at || chat.created_at);
    const list = groups.get(bucket) ?? [];
    list.push(chat);
    groups.set(bucket, list);
  }

  return (
    <aside className={`sidebar${open ? "" : " closed"}`} aria-hidden={!open}>
      <div className="sidebar-head">
        <button className="icon-button" onClick={onToggle} title="Hide sidebar (⌘B)" aria-label="Hide sidebar">
          <PanelIcon />
        </button>
      </div>

      <button className="side-item primary" onClick={onNew} title="New chat (⌘K)">
        <NewChatIcon />
        <span>New Chat</span>
      </button>
      <button className="side-item" onClick={onLaunch} title="Server, models and diagnostics">
        <RocketIcon />
        <span>Launch</span>
      </button>

      <div className="chat-list">
        {chats.length === 0 && <div className="side-group">No conversations yet</div>}
        {ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => (
          <div key={bucket}>
            <div className="side-group">{bucket}</div>
            {groups.get(bucket)!.map((chat) => (
              <div key={chat.id} className={`chat-row${chat.id === activeId ? " selected" : ""}`}>
                <button
                  className="chat-title"
                  onClick={() => onSelect(chat.id)}
                  title={`${chat.title}\n${chat.updated_at}`}
                >
                  {chat.busy && <span className="dot" />}
                  {chat.title || "New chat"}
                </button>
                <button
                  className="chat-delete"
                  onClick={() => onDelete(chat.id)}
                  title="Delete chat"
                  aria-label="Delete chat"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
