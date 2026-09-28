-- The extraction prompt as a per-project setting with a canonical default, the
-- same pattern as the perception prompt in 0001. The default is the shipped
-- prompt text (EXTRACTION_SYSTEM in worker/extraction.ts, and schema.test.ts
-- checks the two match), so a project that never edits the field extracts
-- with the code's prompt. Reset to default writes the same text from the code.
-- Existing rows take the DEFAULT.

ALTER TABLE projects
  ADD COLUMN extraction_prompt TEXT NOT NULL DEFAULT 'You extract brand mentions from an AI assistant''s answer. Return only JSON matching
the schema. Do not add commentary.

Schema:
{"answer_format":"ranked_list|unranked_list|prose|refusal","total_items":number|null,
 "brands":[{"name":string,"position":number|null,
 "mention_type":"ranked|recommended|mentioned|negative","linked_url":string|null,"evidence":string}]}

Rules:
1. List every company, product, or brand named as an option, including ones the
   answer discourages. Do not list generic categories.
2. Set position only when the answer presents an ordered preference (numbered list,
   or explicit ranking language such as "best", "second", "runner-up"). A bulleted
   list with no ordering has null positions and answer_format "unranked_list".
3. total_items is the number of distinct brands presented as options.
4. linked_url must be a URL that appears verbatim in the answer and is attributed to
   that brand. If a URL appears but belongs to a review site, a comparison article,
   or another brand, do not attach it. Use null when unsure.
5. evidence must be copied verbatim from the answer, at most 200 characters.
6. If the answer declines to recommend anything, use answer_format "refusal" with an
   empty brands array.';
