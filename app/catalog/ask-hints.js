// The example questions the Ask bar offers (app/main.js askHints). One shared list: the demo intent cache
// (scripts/intent-standins.ts) has an entry for each, and ai/ask/askHints.test.ts checks that every hint gets
// a real answer, in demo mode (no API key), for every sample business. So the text is fixed: no party names
// or profile words, which would change the cache key. Change a hint here, then add its intent stand-in.
//
// One cash-timing question, one what-if, one plan. Dates stay inside every sample's 13-week horizon, and
// each hint must also read correctly in the preview engine (app/mock/engine.js ask), which treats an amount
// as a one-off payment: no recurring costs here.

export const ASK_HINTS = [
  "Can I make payroll?",
  "What if I spend $10K in early January?",
  "Can I afford a $25K purchase on January 15?",
];
