const EXTRACTOR = Object.freeze({ name: "delivery-radar-notes-rules", version: "1.0.0" });
const UNCERTAINTY_PATTERN = /\b(?:maybe|possibly|perhaps|might be|could be|unclear whether|not sure (?:if|whether))\b/i;

const SIGNAL_RULES = [
  {
    type: "blocker",
    active: /\b(?:blocked|blocker|blocking|can't proceed|cannot proceed|unable to proceed|stuck)\b/i,
    resolved: /\b(?:no longer blocked|unblocked|blocker (?:is |was |has been )?(?:resolved|cleared)|blocking issue (?:is |was )?(?:resolved|cleared))\b/i,
    negated: /\b(?:not blocked|isn't blocked|wasn't blocked|not a blocker|no blockers?|without a blocker)\b/i,
  },
  {
    type: "delay",
    active: /\b(?:delay(?:ed|s)?|slipped|slipping|pushed back|behind schedule|at risk of missing|will miss (?:the )?deadline)\b/i,
    resolved: /\b(?:delay (?:is |has been )?resolved|no longer delayed|back on schedule|caught up|on track again)\b/i,
    negated: /\b(?:not delayed|no delay|no delays|not behind schedule|not at risk of missing)\b/i,
  },
  {
    type: "dependency",
    active: /\b(?:depends on|dependent on|waiting (?:on|for)|awaiting|blocked by|requires? .{1,80} before)\b/i,
    resolved: /\b(?:dependency (?:is )?(?:resolved|cleared)|no longer waiting (?:on|for)|no longer dependent on|no longer blocked by|dependency no longer needed)\b/i,
    negated: /\b(?:not dependent on|doesn't depend on|does not depend on|not waiting (?:on|for))\b/i,
  },
  {
    type: "ownership_gap",
    active: /\b(?:unassigned|no owner|no one owns|ownership unclear|owner is missing|without an owner|responsibility unclear)\b/i,
    resolved: /\b(?:owner (?:is |has been )?assigned|now owned by|ownership assigned|responsibility assigned)\b/i,
    negated: /\b(?:not unassigned|has an owner|owner is assigned|ownership is clear)\b/i,
  },
  {
    type: "pending_decision",
    active: /\b(?:decision (?:is )?pending|pending decision|awaiting a decision|waiting for a decision|waiting for (?:\w+ )?approval|not yet decided|decision not yet made|needs? a decision|pending approval|awaiting approval|(?:approval|decision)[ \t]+(?:is[ \t]+)?still pending)\b/i,
    resolved: /\b(?:decision (?:(?:is|was|has been|already) )?(?:made|finalized|confirmed)|approved|approval granted|signed off)\b/i,
    negated: /\b(?:not pending|no pending decision|not awaiting (?:a )?decision)\b/i,
  },
];

/**
 * Split plain meeting notes into non-empty source lines. Offsets are zero-based,
 * end-exclusive JavaScript string offsets, so evidence is always recoverable
 * with notes.slice(start_offset, end_offset).
 */
export function segmentMeetingNotes(notes) {
  if (typeof notes !== "string" || notes.length === 0) return [];

  const segments = [];
  let lineStart = 0;

  for (let index = 0; index <= notes.length; index += 1) {
    const atEnd = index === notes.length;
    const atLineBreak = !atEnd && (notes[index] === "\n" || notes[index] === "\r");
    if (!atEnd && !atLineBreak) continue;

    let start = lineStart;
    let end = index;
    while (start < end && /\s/u.test(notes[start])) start += 1;
    while (end > start && /\s/u.test(notes[end - 1])) end -= 1;

    if (start < end) {
      segments.push({
        segment_id: `segment:${start}:${end}`,
        start_offset: start,
        end_offset: end,
        text: notes.slice(start, end),
      });
    }

    if (!atEnd && notes[index] === "\r" && notes[index + 1] === "\n") index += 1;
    lineStart = index + 1;
  }

  return segments;
}

/** Extract rule-based signals without task-list or risk-scoring context. */
export function analyzeMeetingNotes(notes) {
  const segments = segmentMeetingNotes(notes);
  const signals = [];

  for (const segment of segments) {
    const normalizedContent = segment.text.normalize("NFC").trim().toLowerCase().replace(/\s+/gu, " ");
    const uncertainContext = UNCERTAINTY_PATTERN.test(segment.text);

    for (const rule of SIGNAL_RULES) {
      const resolutionMatch = segment.text.match(rule.resolved);
      const negationMatch = segment.text.match(rule.negated);
      const textWithoutStatusPhrases = maskMatch(maskMatch(segment.text, resolutionMatch), negationMatch);
      const hasActiveOutsideStatusPhrase = rule.active.test(textWithoutStatusPhrases);
      const hasResolution = resolutionMatch !== null;
      const hasNegation = negationMatch !== null;
      const hasActivePhrase = rule.active.test(segment.text);

      let state;
      if ((hasResolution || hasNegation) && hasActiveOutsideStatusPhrase) {
        state = "conflicting_evidence";
      } else if (hasResolution) {
        state = "resolved";
      } else if (hasNegation) {
        continue;
      } else if (hasActivePhrase) {
        state = uncertainContext ? "uncertain" : "active";
      } else {
        continue;
      }

      signals.push({
        signal_id: `signal:${rule.type}:${segment.start_offset}:${segment.end_offset}`,
        signal_type: rule.type,
        source_ref: { source_id: "meeting_notes" },
        segment_id: segment.segment_id,
        start_offset: segment.start_offset,
        end_offset: segment.end_offset,
        evidence: notes.slice(segment.start_offset, segment.end_offset),
        normalized_content: normalizedContent,
        state,
        evidence_strength: state === "uncertain" || state === "conflicting_evidence" ? "uncertain" : "strong",
        extractor: EXTRACTOR,
      });
    }
  }

  return { segments, signals };
}

function maskMatch(text, match) {
  if (!match || match.index === undefined) return text;
  return `${text.slice(0, match.index)}${" ".repeat(match[0].length)}${text.slice(match.index + match[0].length)}`;
}
