import { describe, expect, it } from "vitest";
import { isQuestion } from "./question.js";

describe("isQuestion", () => {
  it.each([
    "whats the status of my cash",
    "What's my runway",
    "how much do I owe",
    "  ...Can we pay Evergreen early",
    "am I ok for payroll",
    "if rent goes up, what happens",
    "Tell me about Friday",
    "show me the lowest week",
    "status",
    "Evergreen late again?",
  ])("asks: %s", (t) => expect(isQuestion(t)).toBe(true));

  it.each([
    "Evergreen always pays two weeks late",
    "rent goes up to 7k in Feb",
    "Whatever, call Sam",
    "island trip in March",
    "statusquo is fine",
    "",
  ])("parks: %s", (t) => expect(isQuestion(t)).toBe(false));
});
