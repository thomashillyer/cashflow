// The example questions the Ask bar offers (app/main.js askHints). One shared list: the demo intent cache
// (scripts/intent-standins.ts) has an entry for each, and ai/ask/askHints.test.ts checks that every hint gets
// a real answer, in demo mode (no API key), for every sample business. So the text is fixed: no party names
// or profile words, which would change the cache key. Change a hint here, then add its intent stand-in.
//
// One cash-timing question, one what-if, one plan.

export const ASK_HINTS = [
  "Can I make payroll?",
  "What if I hire someone at $6K a month from March?",
  "Can I afford a $25K purchase in January?",
];
