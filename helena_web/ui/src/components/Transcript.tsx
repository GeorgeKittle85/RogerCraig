import { memo } from "react";
import type { Item } from "../types";
import { Markdown } from "./Markdown";
import { PermissionCard } from "./PermissionCard";
import { ToolCard } from "./ToolCard";

const STATUS_MARK: Record<string, string> = {
  completed: "✔",
  in_progress: "▸",
  pending: "○",
};

const USAGE_LABELS: [string, (value: number) => string][] = [
  ["prompt_tokens", (v) => `${v.toLocaleString()} in`],
  ["completion_tokens", (v) => `${v.toLocaleString()} out`],
  ["total_seconds", (v) => `${v.toFixed(1)}s`],
  ["tool_calls", (v) => `${v} tool call${v === 1 ? "" : "s"}`],
];

function Block({ item, onAnswer }: { item: Item; onAnswer: (id: string, answer: string) => void }) {
  const depth = "depth" in item ? item.depth : 0;
  const className = `item${depth ? " nested" : ""}`;

  switch (item.kind) {
    case "user":
      return (
        <div className="user-msg">
          <div className="bubble">
            {item.text}
            {item.files.length > 0 && (
              <span className="attachment">📎 {item.files.join(", ")}</span>
            )}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className={`${className} assistant`}>
          <div className="who">{item.label}</div>
          <Markdown text={item.text} />
          {item.streaming && <span className="caret" />}
        </div>
      );

    case "markdown":
      return (
        <div className={className}>
          <Markdown text={item.text} />
        </div>
      );

    case "note":
      return (
        <div className={className}>
          <div className={`note ${item.tone}`}>{item.text}</div>
        </div>
      );

    case "divider":
      return <div className="divider">{item.label || "—"}</div>;

    case "banner":
      return (
        <div className={className}>
          <div className="card banner-card">
            <span><b>model</b> {item.model || "(server default)"}</span>
            <span><b>workspace</b> {item.workspace}</span>
            <span><b>permissions</b> {item.mode}</span>
            <span><b>server</b> {item.server}</span>
          </div>
        </div>
      );

    case "tool":
      return (
        <div className={className}>
          <ToolCard item={item} />
        </div>
      );

    case "todos":
      return (
        <div className={className}>
          <ul className="todos card">
            {item.items.map((todo, index) => (
              <li key={index} className={todo.status}>
                <span className="mark">{STATUS_MARK[todo.status] ?? "○"}</span>
                <span>{todo.task}</span>
              </li>
            ))}
          </ul>
        </div>
      );

    case "code":
      return (
        <div className={className}>
          <pre className="card mono">{item.text}</pre>
        </div>
      );

    case "table":
      return (
        <div className={className}>
          <div className="card">
            {item.title && <h3>{item.title}</h3>}
            <div className="table-scroll">
              <table className="grid">
                {item.columns.length > 0 && (
                  <thead>
                    <tr>
                      {item.columns.map((column) => (
                        <th key={column}>{column}</th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {item.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      );

    case "usage": {
      const bits = USAGE_LABELS.filter(([key]) => item.stats[key]).map(([key, format]) =>
        format(item.stats[key]),
      );
      if (bits.length === 0) return null;
      return (
        <div className="item">
          <div className="usage">{bits.join(" · ")}</div>
        </div>
      );
    }

    case "permission":
      return (
        <div className="item">
          <PermissionCard item={item} onAnswer={(answer) => onAnswer(item.id, answer)} />
        </div>
      );

    default:
      return null;
  }
}

export const Transcript = memo(function Transcript({
  items,
  onAnswer,
}: {
  items: Item[];
  onAnswer: (id: string, answer: string) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <Block key={item.seq} item={item} onAnswer={onAnswer} />
      ))}
    </>
  );
});
