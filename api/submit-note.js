const fs = require('fs');

function readLocalEnvFile() {
  const out = {};
  try {
    if (!fs.existsSync('.env.local')) return out;
    const lines = fs.readFileSync('.env.local', 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      out[key] = val;
    }
  } catch {}
  return out;
}

async function moderateTextWithClaude(text, anthropicKey, model) {
  const prompt = `You are moderating content for the SIOP 2026 Annual Conference notes hub - a professional I-O psychology academic conference.

Legitimate topics include: workplace psychology, AI in assessment, DEI research, leadership, selection and assessment, performance management, well-being, statistics, coaching, mentoring, HR tech, and related academic/practitioner content.

Content to review:
"${text}"

Is this appropriate for a professional academic conference platform?

REJECT if it contains: profanity, sexual content, hate speech, spam, personal attacks, or content completely unrelated to work/psychology.
APPROVE if it is professional, relevant, or even tangentially related to the conference themes.

Respond ONLY with valid JSON (no markdown): {"pass": true, "reason": ""} or {"pass": false, "reason": "brief reason"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Moderation API failed: ${response.status}`);
  }

  const data = await response.json();
  const raw = data?.content?.[0]?.text || '{"pass":true,"reason":""}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  return { pass: Boolean(parsed?.pass), reason: parsed?.reason || '' };
}

function getFileExtension(fileName) {
  return ((fileName || '').split('.').pop() || '').toLowerCase();
}

function getAttachmentMediaType(fileName) {
  const ext = getFileExtension(fileName);
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  return '';
}

async function moderateAttachmentWithClaude(fileBuffer, mediaType, anthropicKey, model) {
  const prompt = `You are moderating an uploaded file for the SIOP 2026 Annual Conference notes hub, a professional I-O psychology platform.

REJECT if it contains profanity, sexual content, hate speech, spam, personal attacks, or clearly unrelated/unprofessional content.
APPROVE if it is professional and reasonably related to conference content.

Respond ONLY with valid JSON (no markdown): {"pass": true, "reason": ""} or {"pass": false, "reason": "brief reason"}`;

  const source = {
    type: 'base64',
    media_type: mediaType,
    data: fileBuffer.toString('base64'),
  };

  const content = mediaType.startsWith('image/')
    ? [{ type: 'image', source }, { type: 'text', text: prompt }]
    : [{ type: 'document', source }, { type: 'text', text: prompt }];

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 120,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Attachment moderation API failed: ${response.status}`);
  }
  const data = await response.json();
  const raw = data?.content?.[0]?.text || '{"pass":true,"reason":""}';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  return { pass: Boolean(parsed?.pass), reason: parsed?.reason || '' };
}


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const localEnv = readLocalEnvFile();
  const supabaseUrl = process.env.SUPABASE_URL || localEnv.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || localEnv.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_KEY || localEnv.ANTHROPIC_KEY;
  if (!supabaseUrl || !serviceRoleKey || !anthropicKey) {
    return res.status(500).json({ error: 'Missing required server env vars' });
  }

  const moderationModel =
    process.env.ANTHROPIC_MODEL_MODERATION || localEnv.ANTHROPIC_MODEL_MODERATION || 'claude-sonnet-4-20250514';
  const sessionId = String(req.body?.sessionId || '').trim();
  const text = String(req.body?.text || '').trim();
  const fileUrl = req.body?.fileUrl ? String(req.body.fileUrl).trim() : null;
  const fileName = req.body?.fileName ? String(req.body.fileName).trim() : null;
  const fileType = req.body?.fileType ? String(req.body.fileType).trim() : null;

  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  if (!text && !fileUrl) return res.status(400).json({ error: 'Missing content' });

  try {
    if (text) {
      const textModeration = await moderateTextWithClaude(text, anthropicKey, moderationModel);
      if (!textModeration.pass) {
        return res.status(200).json({ pass: false, reason: textModeration.reason || 'Text failed moderation' });
      }
    }

    if (fileUrl && fileName) {
      const mediaType = getAttachmentMediaType(fileName);
      if (!mediaType) {
        return res.status(200).json({
          pass: false,
          reason: 'Unsupported file type. Please upload PDF, DOCX, PNG, JPG, or GIF.',
        });
      }

      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) {
        return res.status(200).json({ pass: false, reason: 'Unable to read uploaded attachment for moderation.' });
      }

      const fileBuffer = Buffer.from(await fileRes.arrayBuffer());
      const fileModeration = await moderateAttachmentWithClaude(
        fileBuffer,
        mediaType,
        anthropicKey,
        moderationModel
      );
      if (!fileModeration.pass) {
        return res.status(200).json({
          pass: false,
          reason: fileModeration.reason || 'Attachment content was flagged by moderation',
        });
      }
    }

    // Keep submission fast: no attachment extraction at submit time.
    let extractedText = null;
    let extractionStatus = fileUrl ? 'disabled' : 'not_applicable';
    let extractedAt = null;

    const notePayload = {
      session_id: sessionId,
      free_text: text || null,
      file_url: fileUrl,
      file_name: fileName,
      file_type: fileType,
      extracted_text: extractedText,
      extraction_status: extractionStatus,
      extracted_at: extractedAt,
      moderation_status: 'approved',
    };

    const insertRes = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/notes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(notePayload),
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      return res.status(500).json({ error: err || 'Failed to save note' });
    }

    const inserted = await insertRes.json();
    return res.status(200).json({ pass: true, note: Array.isArray(inserted) ? inserted[0] : inserted });
  } catch (error) {
    return res.status(500).json({ error: `Submission moderation failed: ${error?.message || 'unknown error'}` });
  }
};
