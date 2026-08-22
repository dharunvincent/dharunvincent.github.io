// Workers can't read repo files at runtime, so knowledge/*.md is bundled at
// build time as text imports (see wrangler.toml [[rules]] type = "Text").
// Redeploying the Worker refreshes portfolio knowledge.
import about from "../../knowledge/about.md";
import projects from "../../knowledge/projects.md";
import faq from "../../knowledge/faq.md";

let cached;

export function getPortfolioKnowledge() {
  if (!cached) {
    cached = [about, projects, faq].join("\n\n---\n\n");
  }
  return cached;
}
