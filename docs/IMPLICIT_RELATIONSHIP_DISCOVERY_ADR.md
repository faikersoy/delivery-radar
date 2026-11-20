# ADR: Implicit Relationship Discovery

- Status: Accepted for incremental implementation planning
- Scope: Delivery Radar prototype, in-memory review
- Repository checkpoint inspected: `1deef757cc9adb6b73994021e0458b98f1401f81` (`master`)
- Benchmark v2: frozen; this ADR does not change its files or outputs

## 1. Purpose and product boundary

Delivery Radar relates statements in meeting notes to structured project tasks. The following are distinct objects and events: task mention, task candidate, relationship suggestion, PM review, and delivery finding. A suggestion is a system proposal about what a source statement means. It is not verified task state.

An implicit suggestion must never become an explicit task-ID link, change a task, create or update a finding, or alter a finding decision automatically. The current deterministic pipeline remains authoritative for the explicit-ID behavior it implements. Relationship discovery is an additional, reviewable analysis layer.

## 2. Current architecture and integration point

`src/ingestion/csv.mjs` validates CSV and returns tasks with `task_id`, `title`, `status`, nullable `owner` and `due_date`, and `blocked_by` as an array. `src/analysis/notes.mjs` splits non-empty lines into segments with exact text and zero-based, end-exclusive JavaScript string offsets; it separately extracts rule-based signals with evidence, state, and extractor version. `src/analysis/task-linking.mjs` links a signal only when its evidence contains an imported task ID.

`src/analysis/findings.mjs` creates one narrow finding for a blocked task with an explicitly linked active blocker or pending-decision signal. `src/review/decisions.mjs` stores finding decisions separately, keyed by project and finding fingerprint, and compares evidence snapshots while ignoring offsets and extractor-version-only changes. `src/app.js` currently holds tasks and decisions in memory and refreshes signals, explicit links, findings, and review UI on input changes.

Add implicit discovery alongside this flow, after the app has task and segment inputs. It may read extracted signals as context but must not consume the explicit-link result as its output channel. Keep its suggestions in a separate UI section and data collection.

## 3. Decisions and rationale

1. Keep explicit task-ID linking unchanged and deterministic.
2. Put implicit discovery in a separate, pure analysis module. Candidate retrieval and relationship classification have separate contracts and metrics; they may run in one implementation or one model call unless evidence shows separate calls improve results.
3. V1 supports exactly `progress`, `completion`, `blocker`, and `dependency`. Defer the `conflict` relationship type and all cross-segment contradiction reasoning.
4. Do not equate mentions with relationships or relationships with risks. Do not use suggestions as findings or update task status.
5. Return zero or more task candidates per segment. Emit no relationship suggestion when evidence does not support one; `NO_LINK`/abstention is valid.
6. Keep PM suggestion decisions separate from finding decisions. Preserve the original suggestion, evidence, and provenance beside each decision.
7. Keep the engine provider-neutral. V1 needs no LLM, external dependency, persistence, embeddings, or vector database.

## 4. Minimal data contract

Existing inputs are passed without mutation:

```js
{
  segment: {
    segment_id: "segment:120:220",
    source_ref: { source_id: "meeting_notes" },
    start_offset: 120,
    end_offset: 220,
    text: "...exact source segment..."
  },
  tasks: [{ task_id, title, status, owner, due_date, blocked_by }],
  signals: [] // optional contextual input; never a required gate
}
```

Keep candidate records separate from relationship suggestions:

```js
{
  candidate_id: "candidate:<stable-id>",
  claim_id: "claim:1",
  segment_id: "segment:120:220",
  task_id: "T-211",
  retrieval_basis: ["task title terminology matches the API work phrase"]
}
```

```js
{
  suggestion_id: "suggestion:<stable-id>",
  candidate_id: "candidate:<stable-id>",
  claim_id: "claim:1",
  relationship_type: "progress",
  evidence_assessment: "strong", // strong | weak | uncertain
  candidate_ambiguity: "unique", // unique | multiple; for this claim/evidence span
  evidence_span: { text: "...exact quote...", start_offset: 133, end_offset: 180 },
  context_span: { text: "...full source segment...", start_offset: 120, end_offset: 220 },
  rationale: "The speaker describes this task's API wiring as currently underway.",
  related_task_id: null, // optional; only if both imported task endpoints are evidence-supported
  dependency_role: null, // for dependency: prerequisite | gated_task, relative to task_id/related_task_id
  provenance: {
    method: "deterministic_rules",
    provider: null,
    model: null,
    prompt_version: null,
    extractor_version: "implicit-linking-v1",
    source_ref: { source_id: "meeting_notes" }
  }
}
```

`claim_id` groups the candidate results and suggestions for one evidence claim within one segment's analysis result. It is unique only within that result and is not a persisted identity or PM-decision key; no stability across re-ingestion is promised. Suggestion/review identity uses the caller-supplied source identity and semantic fields instead.

`candidate_ambiguity` reports whether one or multiple tasks remain plausible for this claim; `evidence_assessment` reports how well the text supports this particular relationship. Neither field is a numeric risk score. Model confidence, if later retained for diagnostics, is not authoritative and cannot independently promote a suggestion to strong.

Return results grouped by claim/evidence span within each source segment, for example `{ segment_id, claims: [{ claim_id, evidence_span, candidate_results }] }`. Each `candidate_result` contains a `candidate` and either a `suggestion` or a `no_link_reason` (`ambiguous_candidates` or `insufficient_evidence`). A claim with no candidates has an empty `candidate_results` array and may use `no_link_reason: "no_plausible_candidate"`. This keeps candidate records distinct from relationship suggestions while allowing one segment to contain multiple claims, multiple suggestions, and a mix of suggestions and abstentions. `NO_LINK` applies to the claim/candidate result, never globally to a segment that has a valid suggestion. A candidate by itself is not a relationship.

For example, one claim in a segment may have a valid suggestion while another claim has `no_link_reason: "ambiguous_candidates"`; the first remains reviewable and the second abstains independently.

`candidate_ambiguity` is assessed against the plausible task set for that specific claim/evidence span, not against every candidate anywhere in the segment. A segment may therefore have a unique candidate for one claim and multiple unresolved candidates for another.

## 5. Relationship taxonomy and rules

Return one primary relationship type per segment/task suggestion. Do not impose a precedence order when evidence is genuinely mixed; mark the assessment `uncertain` or abstain instead of hiding the ambiguity.

| Type | Positive example | Negative contrast |
|---|---|---|
| `progress` | “I am currently wiring the inventory reservation API calls.” | “We discussed the inventory API.” Mentioning it does not establish work underway. |
| `completion` | “The standard operating procedures have been published and signed off.” | “The procedures are in staging for review.” A staging or partial state is not completion. |
| `blocker` | “Missing production credentials prevent the team from starting settlement testing.” | “Credentials are needed before the next phase.” This may be a dependency without saying work is presently halted. |
| `dependency` | “Settlement testing can start only after production credentials arrive.” | “Settlement testing is underway.” That is progress unless a prerequisite is stated. |

For a dependency suggestion, `task_id` is the primary candidate. `related_task_id` optionally identifies the other imported task endpoint, and is present only when evidence supports both endpoints. Direction is defined relative to those fields:

- `dependency_role: "prerequisite"`: the primary `task_id` is the prerequisite; `related_task_id` is the gated task.
- `dependency_role: "gated_task"`: the primary `task_id` is gated; `related_task_id` is its prerequisite.

For example, T-212 as `task_id`, T-213 as `related_task_id`, and role `prerequisite` means T-212 gates T-213. Reversing the two IDs and using `gated_task` expresses the same direction. If the prerequisite is external or no second imported task is evidenced, omit `related_task_id`; the primary candidate can still have role `gated_task`, with the external prerequisite described in evidence and rationale. Do not require a second ID for every dependency. `blocked_by` may help retrieve or rank candidates, but can never establish a note-to-task relationship by itself.

V1 does not output `conflict`. Existing signal state `conflicting_evidence` is not the same thing as a relationship type; it may warn the classifier to abstain, but it must not be relabeled as a fifth relationship. Cross-segment conflict analysis remains out of scope.

## 6. Evidence validation and identity

`evidence_span` must be a verbatim slice of the original note source: integer, in-range offsets and `sourceText.slice(start_offset, end_offset) === text`. Validate every span before a suggestion can be shown as reviewable; discard or abstain on invalid evidence. Validate context the same way. Offsets use JavaScript string indexing, matching the existing segmenter.

Store exact evidence/context spans separately from canonical identity inputs. The caller supplies `source_id`; it is not inferred. It must match `provenance.source_ref.source_id`. Source identity is an input to the review fingerprint, separate from `suggestion_id`.

For the review-relevant semantic fingerprint, hash a canonical serialization containing stable source ID, NFC-normalized evidence text, every context value actually consumed by classification (also canonically normalized), task ID, a fingerprint of task fields actually consumed by retrieval/classification, and relationship type. Context that is merely available but not consumed need not affect the signature. Pass consumed context spans with their source offsets; serialize them in source order (start offset, then end offset), not UI or input-array presentation order. Offsets determine ordering only and are not hashed, so offset shifts preserving source order do not change the fingerprint; a change in meaningful source order does. Changes to semantic evidence, consumed context, relevant task fields, or relationship type require `review_needed`. Formatting-only changes that canonicalize identically, offset/line-number changes that preserve context order, UI-order changes, and provider/model, prompt, or extractor-version changes alone do not invalidate a decision.

Canonicalize only JSON-compatible primitives, dense arrays, and plain objects. Sort object keys deterministically; preserve array order except that consumed context spans are first ordered by source position. Reject dates, maps, sets, class instances, sparse arrays, cycles, accessors, symbol keys/values, undefined, functions, non-finite numbers, and other non-JSON values rather than silently serializing or dropping them.

Keep relationship type out of the stable suggestion identity so reclassification of the same source claim/task pair can find its previous PM decision. Include the current relationship type in the reviewed semantic signature: if that type changes, preserve the old decision and snapshot and mark the suggestion `review_needed` rather than treating the changed type as accepted or creating a silently unrelated decision.

Use SHA-256 via the platform crypto API, with the canonical fields and signature version recorded for reproducibility. Preserve exact raw spans separately; canonicalization is for identity, never for displayed evidence. Provenance records method and source reference; provider/model/prompt fields are null for the deterministic prototype. Do not invent speaker or timestamp metadata absent from the source.

## 7. Candidate discovery and classification

Candidate discovery answers “which tasks are plausible?” using only imported task information and source wording. Start with transparent title/phrase retrieval and show its basis. Status, owner, due date, signals, and dependencies may be context only if their use is explicitly listed in `retrieval_basis`; they must not be presented as textual evidence.

Relationship classification answers “what does this segment say about that task?” It consumes a candidate, exact evidence/context, and limited task context, then returns one of the four types and an evidence assessment. The classifier must be able to reject all candidates. Keep these stages logically separate for measurement, without requiring separate LLM calls.

Examples (illustrative; task names use the frozen sample schema):

- **Task-specific progress:** “I am currently wiring the inventory reservation API calls between the order service and the warehouse system.” Candidate: T-211, “Map real-time stock allocation endpoints to warehouse WMS”; relationship: `progress`.
- **Explicit completion:** “The standard operating procedures and quick-reference job aids have been published and signed off.” Candidate: T-222, “Publish standard operating procedures and quick-reference job aids”; relationship: `completion`.
- **Missing credential blocker:** “Until PaySphere releases production keys, I cannot start the settlement feed.” Candidates: T-212 as prerequisite context and T-213 as the gated work; relationship suggestions must cite the clauses and state their roles. Do not infer that the feed is delayed beyond this claim.
- **Generic statement:** “We had a productive check-in yesterday.” No candidate; `NO_LINK/no_plausible_candidate`.
- **Two supported candidates:** “Production keys arrived, and we have started tokenization and settlement reconciliation.” Candidates may include T-212 (completion) and T-213 (progress), each supported by a distinct span.
- **Mention without relation:** “Procurement mentioned the supplier catalog migration.” T-205 may be a candidate, but the sentence says neither progress, completion, blocker, nor dependency; return `NO_LINK/insufficient_evidence`.

## 8. Abstention and uncertainty rules

- **Strong:** unhedged, task-specific evidence directly states the relationship; the span validates; and the candidate is discriminated by the evidence. If several tasks each have distinct supporting clauses, each may receive a strong suggestion.
- **Weak:** a plausible relationship is supported mostly by context or broad terminology, with a real possibility of a wrong task or relation. It is surfaced for PM review, never treated as confirmed.
- **Uncertain:** the text hedges whether the relationship is true, or the same evidence materially supports incompatible interpretations. V1 does not turn this into `conflict`.
- **NO_LINK / `no_plausible_candidate`:** retrieval finds no relevant task.
- **NO_LINK / `ambiguous_candidates`:** several candidates remain plausible for this claim and its evidence span does not distinguish them. Do not make broad many-to-many suggestions.
- **NO_LINK / `insufficient_evidence`:** a task is mentioned or contextually similar, but the text does not establish one of the four relationships.

These are evidence and ambiguity rules, not calibrated probabilities. A low model confidence alone cannot choose the outcome. Apply them per claim/evidence span, not once to the whole segment. If one claim has a valid suggestion and another has unresolved candidates, retain the suggestion and record `ambiguous_candidates` for the latter candidate result. Do not invent a strict type precedence when a statement has mixed evidence.

## 9. PM suggestion review lifecycle

Keep a distinct `relationship_reviews` map/store; do not call `saveDecision` or `reconcileDecisions`, which operate on generated findings. V1 states are `pending`, `confirmed`, `rejected`, and `review_needed`. Do not add `needs_clarification` in v1: use a pending weak/uncertain suggestion with a reason, or abstain, and let the PM record a note.

Record each review with project ID, stable suggestion key, status, PM note/reason when supplied, decision time, the original suggestion snapshot, exact evidence/context, task-context snapshot, and the reviewed semantic signature. PM review never edits the source task or model suggestion. If the PM accepts a different type, preserve the proposed type and store the PM-accepted type in the decision payload; do not rewrite the suggestion.

- Same evidence and relevant task content: retain confirmed/rejected decisions across reruns; a rejected item stays suppressed from the pending queue but remains available in review history.
- Evidence content, consumed context, relevant task content, or relationship type changes: expose the new output as `review_needed`, preserving the old decision and snapshots. Never overwrite it with new model output.
- Offset, line number, formatting, UI order, or provider/model/prompt/extractor version changes alone: do not invalidate the decision.
- Suggestion absent from a later run: retain its decision as historical/not currently observed; absence does not mean resolved or rejected.

Current browser project IDs and decisions are session-only. Persistent IDs/storage are out of scope; a future persisted workflow will need stable project and source-document IDs.

## 10. Benchmark and evaluation plan

Do not change Benchmark v2, its manifest, frozen predictions, results, or `benchmarks/v2/run.mjs`. Add a separate evaluation tool outside `benchmarks/v2/` that reads its frozen inputs and writes new experiment outputs outside that directory. Ground truth is evaluator-only and must never enter candidate retrieval, classifier context, or prompts.

Report separate measures:

1. **Candidate discovery:** candidate recall at the chosen candidate cap, candidate-set size, and unresolved multi-candidate rate. This tests retrieval before classification. Score candidate task discovery against all relevant labeled task pairs, including conflict-labeled pairs; finding a candidate counts as discovery even if the v1 classifier later abstains on its unsupported relationship type.
2. **Task links:** report strong pair precision/recall/F1 and negative-control segment FPR from the task-discovery output, plus multi-task exact set and Jaccard. Report ambiguous suggestion strength/abstention and `NO_LINK` reasons by cohort. Do not let the relationship-type gate erase candidate discovery.
3. **Relationship type:** conditional accuracy and per-type precision/recall/support only on correctly linked pairs whose expected relationship type is one of v1's four supported types, with strong and ambiguous cohorts separate. This metric must never hide the task-link result.
4. **End-to-end:** exact task-set plus relationship-type agreement on adjudicated strong and negative examples whose expected positive relationship types are supported by v1. Wrong task, wrong supported type, and abstention are failures within this in-scope cohort. Report conflict-labeled examples separately as out-of-scope coverage; do not penalize v1 for abstaining on an intentionally unsupported `conflict` relationship. Continue evaluating task-link discovery on all relevant labeled pairs, including conflict-labeled examples. Benchmark v2 and its outputs remain unchanged.
5. **Evidence fidelity:** exact quote equality and offset recovery from source; invalid spans are invalid suggestions, not partial credit.

Compare the new engine and frozen Antigravity prediction file against the same `ground_truth_v2.csv`, task CSV, and notes. Report absolute deltas and denominators. The frozen baseline records 85/85 strong task recall, mean task-link Jaccard 69/71 (0.9718), strong relationship accuracy 66/85, ambiguous relationship accuracy 5/11, and combined five-type relationship accuracy 71/96. These historical baseline figures include `conflict`; compare v1 relationship metrics only after filtering to supported relationship types, and show conflict coverage separately. These are synthetic results, not production accuracy. The set is only 30 tasks and 78 note segments, English-only, and based on a static task snapshot; it is too small for broad generalization claims or repeated tuning without a new held-out benchmark version.

## 11. V1 exclusions

No cross-meeting conflict detection, cross-segment temporal contradiction reasoning, embeddings/vector database, multi-provider execution, confidence calibration, automatic feedback learning, notifications, cross-project analysis, risk scoring, task-status updates, backend/authentication/database persistence, or automatic confirmation. No relationship suggestion automatically creates a delivery finding.

## 12. Open questions

1. **Stable source identity and duplicate text:** the current textarea exposes only `source_id: meeting_notes`. A stable per-document source ID is needed if multiple note files or persisted reviews are introduced. Identical repeated lines in one source need a disambiguation rule that remains stable under offset-only edits; content-only identity can collide. V1 can scope decisions to one notes document and flag duplicate keys for review rather than guess.
2. **PM correction UX:** the review record can preserve an accepted PM type separately, but the UI and required reason policy for changing a proposed type need product approval before implementation.
3. **Strong/weak thresholds:** rules above are testable starting criteria, but actual phrase/ambiguity cases need adjudicated examples. Do not tune numeric confidence cutoffs on the same 78-segment set and call the result generalizable.

## 13. Incremental implementation plan

1. Add the suggestion contracts and pure evidence/identity validators with unit tests; no UI change.
2. Add candidate retrieval over all note segments, including multiple candidates and reasoned abstention. Test candidate recall and negative controls independently.
3. Add the four-type classifier and evidence-strength/ambiguity rules. Test positive/negative contrasts, partial completion, blocker vs dependency, multiple candidates, exact spans, and no mutation.
4. Add an isolated evaluator outside the frozen benchmark directory. Compare task links, conditional relationship labels, evidence fidelity, abstention, and end-to-end results with the frozen baseline.
5. Add a separate suggestion UI and in-memory PM review state. Verify suggestions cannot change explicit links, findings, task status, or finding decisions.
6. Only after acceptance, consider a provider adapter implementing a provider-neutral candidate/classification contract. Keep output schema validation and evidence verification inside the application boundary.

## 14. Risks and failure modes

- Similar ERP terminology can retrieve the wrong task; candidate recall alone does not prove relevance.
- Generic statements can create many-to-many false positives; enforce the ambiguity/abstention rules and show retrieval basis.
- Progress can be confused with completion; staging, partial, and planned work are not completion without explicit finality.
- A dependency can be mistaken for an active blocker; only call it blocker when the text says the impediment is currently preventing progress.
- Sparse task titles and metadata limit semantic grounding. `blocked_by` is not note evidence.
- An LLM could invent IDs, relationships, spans, or unsupported metadata. Constrain outputs to retrieved task IDs, validate schema and source slices, and abstain on unverifiable output.
- Review decisions may attach to the wrong duplicate segment if source identity is weak; do not key by array position or offsets.
- Repeated tuning on this small synthetic set can overfit. Keep frozen artifacts unchanged and create a new benchmark version for new adjudications.
- Reusing finding decisions would conflate suggestions and risks; maintain separate UI, keys, snapshots, and state.
