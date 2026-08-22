import { useState } from "react";
import type { Item } from "../types";

type QuestionItem = Extract<Item, { kind: "question" }>;

export function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem;
  onAnswer: (answer: string) => void;
}) {
  const [text, setText] = useState("");
  const answered = item.answer !== null;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onAnswer(value);
    setText("");
  };

  return (
    <div className={`question${answered ? " answered" : ""}`}>
      <div className="head">
        <span>❓</span>
        <span style={{ color: "var(--faint)" }}>asked a question</span>
      </div>
      <div className="what">{item.question}</div>

      {!answered && item.options.length > 0 && (
        <div className="actions">
          {item.options.map((option) => (
            <button key={option.label} className="yes" onClick={() => onAnswer(option.label)}>
              {option.label}
              {option.description && <span className="option-hint">{option.description}</span>}
            </button>
          ))}
        </div>
      )}

      {!answered && (
        <div className="freeform">
          <input
            type="text"
            value={text}
            placeholder={item.options.length > 0 ? "Or write your own answer…" : "Your answer…"}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <button onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        </div>
      )}

      {answered && (
        <div className="resolved">
          {item.answer ? `You answered: ${item.answer}` : `No answer${item.note ? ` — ${item.note}` : ""}.`}
        </div>
      )}
    </div>
  );
}
