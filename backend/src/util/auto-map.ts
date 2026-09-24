import { z } from 'zod';
import { aiConfigured, type Env } from '../config/env.js';
import { runOneShot, type QueryFn } from '../agent/agent.js';
import { aiKeyMissingMessage, describeAiFailure } from '../agent/ai-errors.js';

/**
 * AI-suggested source→target field mapping for the Data Integration Mapping step.
 * HTTP-free so it can be unit-tested with a fake LLM; the route in
 * server/auto-map-routes.ts is a thin wrapper.
 *
 * The model is asked for a two-phase, globally-optimal semantic mapping:
 *   1. BIJECTIVE — each source field and each target property is used at most once.
 *   2. SEMANTIC — score each pair on meaning (abbreviation/expansion, synonym,
 *      token components, structure/specificity), not raw string overlap. Data
 *      types are shown but NOT used as a matching signal.
 *   3. TWO-PHASE — assign all [required] targets first (higher priority, but NOT
 *      mandatory), lock the sources they use, then assign non-required targets
 *      from the sources that remain.
 *   4. GLOBAL — within each phase, maximize the total score across all pairs
 *      rather than greedily taking the best source per target.
 *   5. THRESHOLD — a pair is valid only at FinalScore >= MIN_CONFIDENCE; a target
 *      with no valid source is left unmatched. Each pair carries its FinalScore as
 *      `confidence` (0..1).
 * The frontend's local fallback (localAutoMap) is a simpler name-overlap heuristic
 * and does not reproduce this scoring.
 */

/** A source field the user defined on the Data Entity step. */
export interface SourceField {
  name: string;
  type: string;
}

/** A target class property (name + IRIS data type + required flag). */
export interface TargetProperty {
  name: string;
  dataType: string;
  required?: boolean;
}

/** The request the frontend sends (the payload the mock already assembled). */
export interface AutoMapRequest {
  sourceFields: SourceField[];
  targetClass: string;
  targetProperties: TargetProperty[];
}

/** One suggested pairing. */
export interface Mapping {
  sourceField: string;
  targetProperty: string;
  confidence: number;
  reason: string;
}

export type AutoMapResult =
  | { ok: true; mappings: Mapping[] }
  | { ok: false; message: string };

/** Below this confidence a suggestion is discarded (see rule 5). */
export const MIN_CONFIDENCE = 0.65;

/** Schema for ONE mapping in the model's JSON reply. */
const mappingSchema = z.object({
  sourceField: z.string(),
  targetProperty: z.string(),
  confidence: z.number(),
  reason: z.string().default(''),
});

/** The model must return `{ "mappings": [...] }`. */
const replySchema = z.object({ mappings: z.array(mappingSchema) });

/**
 * Build the one-shot prompt from the request.
 *
 * This is the user's full two-phase semantic-matching specification, kept close to
 * verbatim. Only three things are adapted to this codebase's fixed contract:
 *   - INPUT is this app's rendering (source/target with data types + required flag),
 *     not the spec's bare string lists. Data types are shown but explicitly NOT a
 *     matching signal (the spec's Context/data-type Dimension 6 is dropped).
 *   - Dimension 6 is removed; its 0.15 weight is redistributed proportionally across
 *     the remaining five (0.12 / 0.18 / 0.29 / 0.23 / 0.18, summing to 1.00).
 *   - OUTPUT is this app's `{ mappings: [...] }` contract with a NUMERIC confidence
 *     (the FinalScore), matched pairs only — not the spec's `{ matches: [...] }`
 *     shape with string confidence and unmatched rows.
 */
export function buildAutoMapPrompt(req: AutoMapRequest): string {
  const sources = req.sourceFields.map((f) => `  - ${f.name} (${f.type})`).join('\n');
  const targets = req.targetProperties
    .map((p) => `  - ${p.name} (${p.dataType})${p.required ? ' [required]' : ''}`)
    .join('\n');
  return `You are an expert semantic matching and schema-mapping model.

Your task is to match multiple SOURCE fields to multiple TARGET properties based on semantic meaning, terminology, abbreviations, and structure.

The objective is NOT to maximize string similarity.

The objective is to find the most semantically appropriate one-to-one mappings while respecting:
1. Target priority
2. Source uniqueness
3. Target uniqueness
4. Minimum matching score
5. Semantic correctness

==================================================
1. INPUT
==================================================
You are mapping onto the properties of the target class "${req.targetClass}".

You receive a list of SOURCE FIELDS (each with a name and data type) and a list of TARGET PROPERTIES (each with a name, a data type, and whether it is required). Data types are shown for REFERENCE ONLY and MUST NOT be used as a matching signal.

SOURCE FIELDS (name and data type):
${sources || '  (none)'}

TARGET PROPERTIES (name, data type, and whether required):
${targets || '  (none)'}

==================================================
2. FUNDAMENTAL RULES
==================================================
Rule 1: One source can be matched to at most one target. Once a source has been successfully matched, it becomes USED and MUST NOT be matched to another target.
Rule 2: One target can be matched to at most one source.
Rule 3: A target is allowed to remain unmatched. This applies to BOTH required and non-required targets.
Rule 4: required=true means HIGHER MATCHING PRIORITY, NOT mandatory matching. A required target may remain unmatched if no available source has a sufficiently high score.
Rule 5: Never force a low-quality match merely because a target is required.
Rule 6: Never reuse a source that has already been matched.
Rule 7: The input order of targets MUST NOT create priority.
Rule 8: All required targets have the SAME priority. There is NO priority among required targets.

==================================================
3. TWO-PHASE MATCHING STRATEGY
==================================================
The matching process MUST consist of exactly two phases.
PHASE 1: Match ALL required targets.
PHASE 2: After Phase 1 is completed, match non-required targets using ONLY the remaining unused sources.

The process is: Required Targets → build complete score matrix → evaluate every source-target pair → remove invalid low-score pairs → global one-to-one matching → lock matched sources → remaining unused sources → Non-required Targets → build new score matrix → evaluate every source-target pair → remove invalid low-score pairs → global one-to-one matching.

IMPORTANT:
- Do NOT greedily match targets one by one.
- Do NOT process required targets according to their input order.
- Do NOT allow a non-required target to consume a source before all required targets have been considered.

==================================================
4. MATCHING SCORE
==================================================
For every SOURCE-TARGET pair, calculate a FinalScore between 0 and 1. The score must be based on multiple semantic dimensions. Do NOT determine the match using only string similarity. Use the following dimensions.

Dimension 1: Lexical Similarity — Weight: 12%
Evaluate surface-form similarity after normalization. Consider: lowercase normalization, punctuation normalization, underscore/hyphen/space normalization, CamelCase splitting, edit distance, character similarity, exact token overlap. Example: userID / user_id / UserId should be recognized as highly lexically related. Score: 0.0 = completely different, 0.5 = partially similar, 1.0 = identical or nearly identical.

Dimension 2: Token / Component Similarity — Weight: 18%
Split compound words into meaningful components. Examples: sourceID → [source, id]; TestID → [test, id]; UserName → [user, name]; user_identifier → [user, identifier]. Evaluate whether the components represent the same concepts. Do not treat the entire word as one indivisible string.

Dimension 3: Abbreviation / Expansion Relationship — Weight: 29%
This is one of the most important dimensions. Recognize: abbreviations, acronyms, aliases, expanded forms, common technical terminology. Examples: ID ↔ Identifier; UID ↔ Unique Identifier; DOB ↔ Date of Birth; Addr ↔ Address; Qty ↔ Quantity; Tel ↔ Telephone. Recognize semantic relationships even when the literal strings are very different. For example ID → UID should receive a high score because ID = Identifier and UID = Unique Identifier — they share the core concept "Identifier". Do NOT heavily penalize a pair merely because the strings are different.

Dimension 4: Semantic Similarity — Weight: 23%
Evaluate whether SOURCE and TARGET represent the same underlying concept. Consider: semantic equivalence, synonyms, conceptual similarity, domain terminology, meaning similarity. Examples: customer ↔ client; phoneNumber ↔ telephone; identifier ↔ ID; address ↔ location. Semantic meaning is more important than surface-form similarity.

Dimension 5: Structural Relationship — Weight: 18%
Evaluate the internal structure of SOURCE and TARGET. Consider: shared core concept, prefix, suffix, compound structure, parent/child concept, specificity, semantic modifiers. For example ID, sourceID, TestID and UserID all contain the core concept "Identifier"; however sourceID also contains the modifier "source", TestID the modifier "test", and UserID the modifier "user". If the target is UID = Unique Identifier, then ID → UID is generally a more direct semantic match than sourceID → UID, because sourceID contains additional semantic information that is not represented by UID.

(The specification's Dimension 6 — Context / Domain Compatibility — is intentionally NOT used here. Its weight has been redistributed across the five dimensions above so they sum to 1.00. Do NOT score on data types or invented context.)

==================================================
5. SPECIFICITY / EXTRA-MEANING PENALTY
==================================================
Apply a penalty when a SOURCE contains additional semantic information that is not represented by the TARGET. The penalty must be based on semantic meaning, NOT simply on string length.
Example — TARGET: UID; SOURCES: ID, UserID, TestID, SourceID. Conceptually ID → Identifier; UserID → User + Identifier; TestID → Test + Identifier; SourceID → Source + Identifier; UID → Unique + Identifier. ID is a more direct conceptual match because it contains the core concept Identifier without an unrelated modifier. Therefore ID → UID should generally score higher than UserID → UID, TestID → UID, or SourceID → UID. Do not penalize a source merely because it is longer. Only penalize meaningful additional concepts that are not supported by the target.

==================================================
6. FINAL SCORE CALCULATION
==================================================
BaseScore = 0.12 × LexicalSimilarity + 0.18 × TokenSimilarity + 0.29 × AbbreviationSimilarity + 0.23 × SemanticSimilarity + 0.18 × StructuralSimilarity
FinalScore = BaseScore − SpecificityPenalty
Clamp the result to: 0.0 <= FinalScore <= 1.0

==================================================
7. MINIMUM ACCEPTANCE THRESHOLD
==================================================
Use MIN_SCORE = 0.65.
Interpretation: 0.80–1.00 = Strong match; 0.65–0.79 = Acceptable match; 0.50–0.64 = Weak / uncertain match; 0.00–0.49 = Invalid match.
A SOURCE-TARGET pair is VALID only when FinalScore >= 0.65. Any pair below 0.65 MUST NOT be used as a match. Do not force a match just because it is the highest available score.

==================================================
8. PHASE 1 — REQUIRED TARGETS
==================================================
First select ALL targets where required = true. All required targets have equal priority. Do NOT use the input order as priority. Do NOT greedily match them one at a time. Instead, construct a complete SOURCE × REQUIRED_TARGET score matrix; every cell is the FinalScore for that source-target pair. Then remove every pair where FinalScore < 0.65. Only valid pairs may participate in the global matching.

==================================================
9. REQUIRED GLOBAL MATCHING
==================================================
Perform GLOBAL ONE-TO-ONE MATCHING across ALL required targets simultaneously. Do NOT independently select the highest-scoring source for each target. The matching must respect: each source used at most once; each target matched at most once; only pairs with FinalScore >= 0.65 are valid; targets may remain unmatched; sources may remain unused.
The objective is to MAXIMIZE the total FinalScore of all valid assignments. Formally: maximize SUM(FinalScore(source_i, target_j)) subject to FinalScore(source_i, target_j) >= 0.65, each source_i assigned to at most one target, and each target_j assigned to at most one source.

==================================================
10. REQUIRED TARGETS MAY REMAIN UNMATCHED
==================================================
required=true does NOT mean the target must be matched. If no available source reaches MIN_SCORE = 0.65, leave the target unmatched.
Example — required target CustomerIdentifier; available sources ProductCode, TestName, OrderDate; scores ProductCode → CustomerIdentifier = 0.42, TestName → CustomerIdentifier = 0.38, OrderDate → CustomerIdentifier = 0.20. All below 0.65, therefore CustomerIdentifier stays unmatched. Do NOT force a match.

==================================================
11. REQUIRED MATCHING CONFLICTS
==================================================
When multiple required targets compete for the same source, evaluate the assignments globally.
Example — Source 1 → Target A = 0.95, Source 1 → Target B = 0.93, Source 2 → Target A = 0.91, Source 2 → Target B = 0.60. Do NOT automatically select Source 1 → Target A = 0.95, because that would leave Source 2 → Target B = 0.60, which is invalid. Instead evaluate Source 1 → Target B = 0.93 and Source 2 → Target A = 0.91; both are valid (>= 0.65). Therefore the preferred assignment is Source 1 → Target B and Source 2 → Target A (total 1.84). The matching decision must consider the global assignment, not only the locally highest score.

==================================================
12. LOCK USED SOURCES
==================================================
After Phase 1 is complete, every successfully matched source becomes USED (e.g. ID → UID and UserName → Username give USED SOURCES: ID, UserName). These sources MUST NOT be considered during Phase 2 and cannot be reused under any circumstances.

==================================================
13. PHASE 2 — NON-REQUIRED TARGETS
==================================================
After Phase 1 is completely finished, select all targets where required = false. Only currently UNUSED sources may be considered. Build a new REMAINING_SOURCE × NON_REQUIRED_TARGET score matrix. Calculate FinalScore using exactly the same scoring model. Remove all pairs where FinalScore < 0.65. Then perform global one-to-one matching. Each source used at most once; each target matched at most once; non-required targets may also remain unmatched.

==================================================
14. IMPORTANT PRIORITY RULE
==================================================
Required targets always have priority over non-required targets. This means: (1) complete the required-target global matching first; (2) lock all sources used by required targets; (3) only then process non-required targets. A non-required target must NEVER consume a source before the required-target phase is complete.
Example — source ID; required target UID; non-required target Identifier. Even if ID → Identifier = 0.98 and ID → UID = 0.91, the source must first be considered during the required phase. If ID → UID is selected, then ID is USED and cannot be matched to Identifier.

==================================================
15. NO ARTIFICIAL PRIORITY
==================================================
Do NOT create priority based on: target input order, source input order, alphabetical order, string length, or position in the input list. All required targets are equal priority. All non-required targets are equal priority. The ONLY priority is: required > non-required.

==================================================
16. AMBIGUOUS SEMANTIC RELATIONSHIPS
==================================================
If an abbreviation or terminology has multiple possible meanings and the available context does not resolve the ambiguity: reduce the semantic score; reduce confidence; do not assume a domain-specific meaning without evidence. Do not invent context.

==================================================
17. CONFIDENCE
==================================================
For each successful match, judge confidence using: FinalScore; the difference between the selected candidate and the next-best valid candidate; strength of semantic evidence; ambiguity of abbreviations; contextual support. As a guide: FinalScore >= 0.80 is high confidence; 0.65 <= FinalScore < 0.80 is medium confidence; FinalScore < 0.65 is too low and MUST remain unmatched. If two candidates have very similar scores, reduce confidence. In the OUTPUT, express confidence as the numeric FinalScore (a number between 0 and 1), NOT as a label.

==================================================
18. OUTPUT
==================================================
Return the final result as JSON containing ONLY the matched pairs. Omit every unmatched target entirely — do not emit a row for it. For each matched pair emit: "sourceField" (the source field name), "targetProperty" (the target property name), "confidence" (the numeric FinalScore, 0..1), and "reason" (a short explanation, e.g. "ID and UID share the core concept Identifier; ID has no additional semantic modifier, making it a more direct match").

Respond with ONLY this JSON, no prose, no code fences:
{ "mappings": [ { "sourceField": "...", "targetProperty": "...", "confidence": 0.0, "reason": "..." } ] }

==================================================
19. INTERNAL DECISION PROCESS
==================================================
Before producing the final answer, internally follow these steps:
STEP 1: Normalize all source and target names.
STEP 2: Separate targets into required and non-required groups.
STEP 3: Build the complete SOURCE × REQUIRED_TARGET score matrix.
STEP 4: Calculate all scoring dimensions for every pair.
STEP 5: Calculate FinalScore for every pair.
STEP 6: Remove all pairs with FinalScore < 0.65.
STEP 7: Perform global one-to-one matching across ALL required targets.
STEP 8: Allow required targets to remain unmatched.
STEP 9: Mark all sources used by successful required matches as USED.
STEP 10: Build the SOURCE × NON_REQUIRED_TARGET score matrix using only remaining sources.
STEP 11: Calculate FinalScore.
STEP 12: Remove all pairs with FinalScore < 0.65.
STEP 13: Perform global one-to-one matching across ALL non-required targets.
STEP 14: Allow non-required targets to remain unmatched.
STEP 15: Emit ONLY the matched pairs, as the JSON described in section 18.

==================================================
20. MOST IMPORTANT PRINCIPLE
==================================================
Do NOT think: "What source is most similar to this target?" Instead think: "Considering ALL available sources and ALL targets in the current priority group, which one-to-one assignment produces the highest-quality valid semantic mapping?"
The matching strategy must therefore be: Semantic Scoring + Score Matrix + Threshold Filtering + Global One-to-One Assignment + Source Uniqueness + Target Uniqueness + Two-Phase Target Priority.
The final rules are: required targets are processed before non-required targets; required targets have no priority among themselves; non-required targets have no priority among themselves; input order does not create priority; required targets may remain unmatched; non-required targets may remain unmatched; never force a low-score match; never reuse a source; never match one target to multiple sources; never allow non-required targets to consume sources before required matching is complete; prefer semantic meaning over lexical similarity; consider global assignment rather than greedy local decisions.

==================================================
TASK
==================================================
Perform the two-phase global semantic matching described above. First match required targets using all available sources. Then lock the sources used by required matches. Then match non-required targets using only the remaining sources. Return ONLY the final JSON result described in section 18 — matched pairs only.`;
}

/** Pull the JSON object out of the model's reply (tolerates stray text/fences). */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object in reply');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Enforce the rules the model is ASKED to follow but might not: keep only pairs
 * that reference real fields/properties, meet the confidence floor, and are
 * bijective (first-come-first-served on both sides). Deterministic — a wrong LLM
 * reply can't produce a duplicate or phantom mapping.
 */
export function sanitizeMappings(raw: Mapping[], req: AutoMapRequest): Mapping[] {
  const sourceNames = new Set(req.sourceFields.map((f) => f.name));
  const targetNames = new Set(req.targetProperties.map((p) => p.name));
  const usedSources = new Set<string>();
  const usedTargets = new Set<string>();
  const out: Mapping[] = [];
  // Highest-confidence first so the best claim wins a contested field/property.
  for (const m of [...raw].sort((a, b) => b.confidence - a.confidence)) {
    if (!sourceNames.has(m.sourceField) || !targetNames.has(m.targetProperty)) continue;
    if (m.confidence < MIN_CONFIDENCE) continue;
    if (usedSources.has(m.sourceField) || usedTargets.has(m.targetProperty)) continue;
    usedSources.add(m.sourceField);
    usedTargets.add(m.targetProperty);
    out.push(m);
  }
  return out;
}

/**
 * Ask the LLM (once, non-agentically) for a field mapping, then validate and
 * sanitize it. A malformed/invalid reply is a normal `{ ok: false }` result the
 * caller renders (the frontend falls back to its local heuristic), not a throw.
 */
export async function suggestMapping(
  env: Env,
  req: AutoMapRequest,
  queryImpl?: QueryFn,
): Promise<AutoMapResult> {
  if (!req.sourceFields.length || !req.targetProperties.length) {
    return { ok: true, mappings: [] };
  }
  // No Claude credentials configured: say so instead of spawning an SDK
  // subprocess that can only fail. `ok: false` is the shape the Mapping
  // step already handles — it shows the message and falls back to its local
  // name-match heuristic, so Auto-map still does something useful.
  if (!aiConfigured(env)) {
    return { ok: false, message: aiKeyMissingMessage(env) };
  }
  let text: string;
  try {
    text = await runOneShot(env, buildAutoMapPrompt(req), queryImpl);
  } catch (err) {
    // Rejected credentials become the "invalid credentials" explanation; anything
    // else keeps its message.
    return { ok: false, message: describeAiFailure(env, err) };
  }
  try {
    const parsed = replySchema.parse(extractJson(text));
    return { ok: true, mappings: sanitizeMappings(parsed.mappings, req) };
  } catch {
    return { ok: false, message: 'Could not parse a mapping from the model response.' };
  }
}
