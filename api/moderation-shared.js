/**
 * Shared SIOP notes hub moderation criteria — keep text and attachment checks aligned.
 */

const CONFERENCE_INTRO =
  'You are moderating content for the SIOP 2026 Annual Conference notes hub — a professional I-O psychology academic conference.';

const LEGITIMATE_TOPICS =
  'Legitimate topics and materials include: workplace psychology, AI in assessment, DEI research, leadership, selection and assessment, performance management, well-being, statistics, coaching, mentoring, HR tech, session slides, handwritten or typed session notes, charts, whiteboard photos, and related academic or practitioner content.';

const REJECT_RULES =
  'REJECT if it contains or shows: profanity used offensively, sexual or graphic content, hate speech, slurs, spam, scams, personal attacks, harassment, or content completely unrelated to work, psychology, or conference themes.';

const APPROVE_RULES =
  'APPROVE if it is professional, relevant, or even tangentially related to the conference themes (including informal photos of session materials).';

const JSON_SUFFIX =
  'Respond ONLY with valid JSON (no markdown): {"pass": true, "reason": ""} or {"pass": false, "reason": "brief reason"}';

function buildTextModerationPrompt(text) {
  return `${CONFERENCE_INTRO}

${LEGITIMATE_TOPICS}

Content to review:
"${text}"

Is this appropriate for a professional academic conference platform?

${REJECT_RULES}
${APPROVE_RULES}

${JSON_SUFFIX}`;
}

const ATTACHMENT_MODERATION_PROMPT = `${CONFERENCE_INTRO}

${LEGITIMATE_TOPICS}

You are reviewing an uploaded file (image, PDF, or Word document) attached to a session note.

${REJECT_RULES}
${APPROVE_RULES}

${JSON_SUFFIX}`;

/** If the model output is not valid JSON with a boolean pass, treat as blocked (fail closed). */
function parseModerationResponse(rawText) {
  const cleaned = String(rawText || '')
    .replace(/```json|```/g, '')
    .trim();
  if (!cleaned) {
    return { pass: false, reason: 'Moderation did not return a result; try again.' };
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.pass !== 'boolean') {
      return { pass: false, reason: 'Moderation could not be verified; try again.' };
    }
    return { pass: parsed.pass, reason: String(parsed.reason || '') };
  } catch {
    return { pass: false, reason: 'Moderation could not be verified; try again.' };
  }
}

module.exports = {
  buildTextModerationPrompt,
  ATTACHMENT_MODERATION_PROMPT,
  parseModerationResponse,
};
