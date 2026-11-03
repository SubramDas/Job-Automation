// Structured personalization for modes/_profile.md — the pure logic behind
// /api/personalization and the setPersonalization action.
//
// Why this exists: doctorState() lists four user-layer prerequisites, and the
// web could already write three of them (cv.md via the CV editor,
// config/profile.yml + portals.yml via the confirm-gated setProfile). The
// fourth, modes/_profile.md, only ever received appended "web notes" — its
// eight structured sections (archetypes, framing, narrative, comp, location…)
// stayed identical to the shipped template, so doctor kept warning that
// "evaluations score against the template author's targeting, not yours".
// This module fills exactly those sections, by heading, and nothing else.
//
// Contract with the rest of the file: every `## Your …` section the template
// ships is addressed by its heading; a write replaces ONLY the body of the
// sections it was given, keeps every other byte (other sections, the
// `<!-- co-web-notes -->` block the assistant appends to, anything the CLI
// intake mode or the user wrote by hand), and appends a section whose heading
// is missing rather than reordering the file. Plain .mjs so tests import it.
//
// This half is also imported by the action registry, which runs in the browser:
// it must stay free of node:fs. The merge and the file access live in
// personalization-file.mjs.

/** The eight template sections, in template order. `id` is the API/JSON key. */
export const SECTIONS = [
  { id: "targetRoles", heading: "## Your Target Roles" },
  { id: "adaptiveFraming", heading: "## Your Adaptive Framing" },
  { id: "exitNarrative", heading: "## Your Exit Narrative" },
  { id: "crossCuttingAdvantage", heading: "## Your Cross-cutting Advantage" },
  { id: "portfolio", heading: "## Your Portfolio / Demo" },
  { id: "compTargets", heading: "## Your Comp Targets" },
  { id: "negotiationScripts", heading: "## Your Negotiation Scripts" },
  { id: "locationPolicy", heading: "## Your Location Policy" },
];

const str = (v, max = 600) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined);
const strList = (v, max = 8) =>
  Array.isArray(v) ? v.map((x) => str(x, 300)).filter(Boolean).slice(0, max) : undefined;
// Markdown table cells cannot contain a pipe or a newline; scrub rather than reject.
const cell = (v) => (str(v, 200) ?? "").replace(/\|/g, "/");

/**
 * Hand-validate a raw setPersonalization payload (house style: no zod; keep
 * only well-formed fields). Unknown keys are dropped, junk rows are dropped,
 * and an empty result means "nothing to write".
 */
export function coercePersonalization(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};

  if (Array.isArray(raw.targetRoles)) {
    const rows = raw.targetRoles
      .map((r) => (r && typeof r === "object" ? { archetype: str(r.archetype, 80), axes: str(r.axes, 200), buys: str(r.buys, 200) } : null))
      .filter((r) => r && r.archetype)
      .slice(0, 8);
    if (rows.length) out.targetRoles = rows;
  }
  if (Array.isArray(raw.adaptiveFraming)) {
    const rows = raw.adaptiveFraming
      .map((r) => (r && typeof r === "object" ? { role: str(r.role, 80), emphasize: str(r.emphasize, 200), proof: str(r.proof, 160) } : null))
      .filter((r) => r && r.role && r.emphasize)
      .slice(0, 8);
    if (rows.length) out.adaptiveFraming = rows;
  }
  const exit = str(raw.exitNarrative, 1200);
  if (exit) out.exitNarrative = exit;
  const cross = str(raw.crossCuttingAdvantage, 600);
  if (cross) out.crossCuttingAdvantage = cross;
  if (raw.portfolio && typeof raw.portfolio === "object") {
    const url = str(raw.portfolio.url, 300);
    if (url && /^https?:\/\//i.test(url)) {
      out.portfolio = { url, description: str(raw.portfolio.description, 300), whenToShare: str(raw.portfolio.whenToShare, 200) };
    }
  }
  const comp = str(raw.compTargets, 800);
  if (comp) out.compTargets = comp;
  const scripts = strList(raw.negotiationScripts, 6);
  if (scripts?.length) out.negotiationScripts = scripts;
  const loc = strList(raw.locationPolicy, 8);
  if (loc?.length) out.locationPolicy = loc;
  return out;
}

/** Render one section body (no heading) from its coerced value. */
export function renderSection(id, value) {
  switch (id) {
    case "targetRoles":
      return [
        "| Archetype | Thematic axes | What they buy |",
        "|-----------|---------------|---------------|",
        ...value.map((r) => `| **${cell(r.archetype)}** | ${cell(r.axes)} | ${cell(r.buys)} |`),
      ].join("\n");
    case "adaptiveFraming":
      return [
        "| If the role is... | Emphasize about you... | Proof point sources |",
        "|-------------------|------------------------|---------------------|",
        ...value.map((r) => `| ${cell(r.role)} | ${cell(r.emphasize)} | ${cell(r.proof) || "cv.md"} |`),
      ].join("\n");
    case "exitNarrative":
    case "crossCuttingAdvantage":
    case "compTargets":
      // Prose passthrough — but never let a body open with its own `## `: the
      // merge finds sections by heading, so that would silently start a new
      // section instead of filling this one.
      return String(value).replace(/^\s*#{1,6}\s+/, "");
    case "portfolio":
      return [
        `- url: ${value.url}`,
        value.description ? `- what: ${value.description}` : null,
        value.whenToShare ? `- when_to_share: ${value.whenToShare}` : null,
      ].filter(Boolean).join("\n");
    case "negotiationScripts":
      return value.map((s) => `> "${s.replace(/^["“]|["”]$/g, "")}"`).join("\n\n");
    case "locationPolicy":
      return value.map((l) => `- ${l}`).join("\n");
    default:
      return "";
  }
}

/**
 * Locate every `# ` / `## ` heading by SOURCE OFFSET — nothing is normalized,
 * so a caller can splice the original string and keep every other byte.
 * A `## ` line inside a code fence is not a heading. `unsure` names the first
 * thing that makes the boundaries ambiguous (a heading-looking line inside an
 * HTML comment, a comment or fence that never closes), or is null.
 */
export function scanHeadings(text) {
  const heads = [];
  let unsure = null;
  let fence = null;
  let inComment = false;
  for (let pos = 0; pos < text.length; ) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, end).replace(/\r?\n$/, "");
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !line.slice(mark[0].length).trim()) fence = null;
    } else {
      const heading = /^##? /.test(line);
      if (heading && inComment) unsure ??= `a heading-looking line ("${line.trim().slice(0, 60)}") sits inside an HTML comment`;
      else if (heading) heads.push({ level: line.startsWith("## ") ? 2 : 1, heading: line.trim(), start: pos, bodyStart: end });
      else if (mark && !inComment) fence = mark[1];
      if (!fence) {
        for (let i = 0; i < line.length; ) {
          const j = line.indexOf(inComment ? "-->" : "<!--", i);
          if (j === -1) break;
          inComment = !inComment;
          i = j + (inComment ? 4 : 3);
        }
      }
    }
    pos = end;
  }
  if (fence) unsure ??= "a code fence is never closed";
  if (inComment) unsure ??= "an HTML comment is never closed";
  heads.forEach((h, i) => { h.end = i + 1 < heads.length ? heads[i + 1].start : text.length; });
  return { heads, unsure };
}

/** Normalize a body for template comparison: drop HTML comments + whitespace noise. */
function normBody(body) {
  let s = String(body ?? "");
  // Scanned by index, until stable: one pass over `<!<!-- a -->-- b -->` leaves
  // a fresh `<!--` behind. An opener that is never closed hides everything
  // after it when rendered, so it is dropped with the rest of the body.
  for (;;) {
    let out = "";
    let from = 0;
    for (;;) {
      const start = s.indexOf("<!--", from);
      if (start === -1) { out += s.slice(from); break; }
      out += s.slice(from, start);
      const end = s.indexOf("-->", start + 4);
      if (end === -1) break;
      from = end + 3;
    }
    if (out === s) break;
    s = out;
  }
  return s.replace(/\s+/g, " ").trim();
}

/** `## ` sections of a document as [heading, normalized body] pairs. */
function sectionBodies(md) {
  const text = String(md ?? "");
  return scanHeadings(text).heads.filter((h) => h.level === 2).map((h) => [h.heading, normBody(text.slice(h.bodyStart, h.end))]);
}

/**
 * Per-section state of a user's _profile.md against the shipped template:
 * "filled" (differs from the template), "template" (still the shipped text),
 * or "missing" (heading not present). Drives the onboarding panel and the
 * assistant's SETUP STATE, so the model asks only about what is still generic.
 */
export function sectionState(userMd, templateMd) {
  const user = new Map(sectionBodies(userMd));
  const tpl = new Map(sectionBodies(templateMd));
  return SECTIONS.map((s) => {
    if (!user.has(s.heading)) return { id: s.id, heading: s.heading, state: "missing" };
    const same = user.get(s.heading) === (tpl.get(s.heading) ?? "");
    return { id: s.id, heading: s.heading, state: same ? "template" : "filled" };
  });
}
