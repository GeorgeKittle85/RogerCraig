import type { Item } from "../types";
import { Diff } from "./Diff";
import { TOOL_ICONS } from "./ToolCard";

type PermissionItem = Extract<Item, { kind: "permission" }>;

const ANSWERS: { key: string; answer: string; label: string; hint: string }[] = [
  { key: "y", answer: "once", label: "Yes, once", hint: "y" },
  { key: "a", answer: "always", label: "Always allow this", hint: "a" },
  { key: "s", answer: "session", label: "Allow this session", hint: "s" },
  { key: "n", answer: "no", label: "No", hint: "n" },
];

const RESOLVED_LABEL: Record<string, string> = {
  once: "Allowed once.",
  always: "Always allowed — a rule was saved to .helena/settings.json.",
  session: "Allowed for the rest of this session.",
  no: "Declined.",
};

export function PermissionCard({
  item,
  onAnswer,
}: {
  item: PermissionItem;
  onAnswer: (answer: string) => void;
}) {
  const answered = item.answer !== null;
  const isDiff = /^(---|\+\+\+|@@)/.test(item.detail.trimStart());

  return (
    <div className={`permission${answered ? " answered" : ""}`}>
      <div className="head">
        <span>{TOOL_ICONS[item.tool] ?? "•"}</span>
        <b>{item.tool}</b>
        <span style={{ color: "var(--faint)" }}>needs your OK</span>
        {item.agent && item.agent !== "helena" && (
          <span style={{ color: "var(--faint)" }}>· subagent: {item.agent}</span>
        )}
      </div>
      <div className="what mono">{item.preview}</div>
      {item.detail && !answered && (
        <div className="detail">
          {isDiff ? <Diff patch={item.detail} /> : <pre className="diff ctx">{item.detail}</pre>}
        </div>
      )}
      {item.danger && <div className="danger">⚠ This {item.danger}.</div>}

      {answered ? (
        <div className="resolved">
          {RESOLVED_LABEL[item.answer ?? "no"] ?? item.answer}
          {item.note ? ` (${item.note})` : ""}
        </div>
      ) : (
        <div className="actions">
          {ANSWERS.map((choice) => (
            <button
              key={choice.answer}
              className={choice.answer === "no" ? "" : "yes"}
              onClick={() => onAnswer(choice.answer)}
            >
              {choice.label}
              <kbd>{choice.hint}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
