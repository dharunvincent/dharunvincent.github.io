// "should i" was deliberately dropped: it's a substring of the spec's own
// section 9 GENERAL acceptance test ("What should I do to become a Product
// Manager?"), so keeping it made that test always misroute to ADVICE.
const ADVICE_KEYWORDS = [
  "help me",
  "advice",
  "relationship",
  "career",
  "life",
  "virtue",
  "struggling",
  "confused about my",
];

const PORTFOLIO_PATTERNS = [
  /\bdharun\b/i,
  /\byou(r)?\s+(work|skills?|projects?|experience)\b/i,
  /\bthis site\b/i,
  /\bhe\b|\bhis\b/i,
  /\bhire\b/i,
  /\bresume\b/i,
  /\bblog\b/i,
];

// Named projects, features, and companies from knowledge/*.md that a visitor
// might ask about without mentioning Dharun by name.
const PORTFOLIO_ENTITIES = [
  "r21",
  "offline download",
  "upi autopay",
  "ottplay",
  "uncle john",
  "experience bank",
  "hbo max",
  "discovery+",
  "warner bros",
  "robosoft",
  "ai sidekick",
];

// 1. Quick-reply buttons send mode: "advice" explicitly — trust it.
// 2. Else keyword check for advice.
// 3. Else keyword/entity check for portfolio.
// 4. Else general. Default to portfolio when unsure (cheap, cached, safer
//    than a vague general answer about Dharun).
export function routeMessage(message, explicitMode) {
  if (explicitMode === "advice") return "advice";

  const lower = message.toLowerCase();

  if (ADVICE_KEYWORDS.some((kw) => lower.includes(kw))) return "advice";
  if (PORTFOLIO_PATTERNS.some((re) => re.test(message))) return "portfolio";
  if (PORTFOLIO_ENTITIES.some((e) => lower.includes(e))) return "portfolio";

  return "general";
}
