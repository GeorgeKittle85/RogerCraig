/** A unified diff, coloured the way the terminal harness colours it. */
export function Diff({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="diff">
      {lines.map((line, index) => {
        const cls = line.startsWith("+++") || line.startsWith("---")
          ? "ctx"
          : line.startsWith("+")
            ? "add"
            : line.startsWith("-")
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : "ctx";
        return (
          <div key={index} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
