import { useState } from "react";
import type { Item } from "../types";
import { Diff } from "./Diff";
import { ChevronIcon } from "./Icons";

/** Same glyphs as helena_harness/ui.py, so the two surfaces read alike. */
export const TOOL_ICONS: Record<string, string> = {
  read_file: "◆", write_file: "✎", edit_file: "✎", delete_path: "✖",
  list_dir: "▤", find_files: "⌕", search_text: "⌕", run_command: "❯",
  check_job: "◷", web_search: "🌐", fetch_url: "🌐", analyze_image: "▣",
  todo_write: "☑", spawn_agent: "⛬", get_weather: "☁", get_stock: "$",
  add_reminder: "⏰", remember: "✦", get_time: "◷", ask_user_question: "❓",
};

type ToolItem = Extract<Item, { kind: "tool" }>;

export function ToolCard({ item }: { item: ToolItem }) {
  const expandable = Boolean(item.output || item.diff || item.detail);
  const [open, setOpen] = useState(false);

  return (
    <div className="tool">
      <button
        className="tool-head"
        onClick={() => expandable && setOpen(!open)}
        style={{ cursor: expandable ? "pointer" : "default" }}
        title={expandable ? (open ? "Hide output" : "Show output") : undefined}
      >
        <span className="tool-icon">{TOOL_ICONS[item.tool] ?? "•"}</span>
        <span className="tool-name">{item.tool}</span>
        <span className="tool-preview">{item.preview}</span>
        {!item.done ? (
          <span className="spinner" />
        ) : (
          <span className={`tool-status${item.ok ? "" : " bad"}`}>
            {item.summary || (item.ok ? "done" : "failed")}
          </span>
        )}
        {expandable && (
          <ChevronIcon
            size={13}
            className={`tool-chevron${open ? " open" : ""}`}
          />
        )}
      </button>
      {open && expandable && (
        <div className="tool-body">
          {item.diff ? <Diff patch={item.diff} /> : null}
          {item.detail ? <pre>{item.detail}</pre> : null}
          {item.output ? <pre>{item.output}</pre> : null}
        </div>
      )}
    </div>
  );
}
