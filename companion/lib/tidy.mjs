// Text cleanup before anything is shown in the in-game panel.
//
// The panel renders: headings (short lines ending in ":") in gold, lines
// starting with "!" in orange, "- " lines as bullets, and indented "+"/"-"
// lines as green/red sub-points (used by the free reports for pros and cons).
// Square brackets are markup to the game, so they never reach it.

const brackets = (s) => s.replace(/\[/g, "(").replace(/\]/g, ")");
const squeeze = (s) => s.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

// Model answers: markdown out, bullets flat, no self-introductions.
export function tidyAnswer(text) {
  let s = String(text ?? "").replace(/\r/g, "");
  s = s
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|\s)\*(\S[^*]*?)\*(?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s*(.+?)\s*:?\s*$/gm, "$1:")
    .replace(/^\s*(?:[*•‣◦]|\d+[.)])\s+/gm, "- ")
    .replace(/^\s+-\s+/gm, "- ")
    .replace(/^\s*-{3,}\s*$/gm, "")
    .replace(/^(?:copilot|assistant)\s*:\s*/i, "");
  return squeeze(brackets(s));
}

// The free reports are laid out on purpose; only tidy whitespace.
export function tidyReport(text) {
  return squeeze(brackets(String(text ?? "").replace(/\r/g, "")));
}
