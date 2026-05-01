const fs = require('fs');
const {
  buildTextModerationPrompt,
  ATTACHMENT_MODERATION_PROMPT,
  parseModerationResponse,
} = require('./moderation-shared');

/** Older Haiku IDs (e.g. claude-3-5-haiku-20241022) return 404 on the current Messages API. */
function resolveImageModerationModel(fromEnv, fromLocal) {
  const raw = (fromEnv || fromLocal || '').trim();
  const legacy =
    /^claude-3-5-haiku/i.test(raw) ||
    /^claude-3-haiku/i.test(raw) ||
    raw === 'claude-haiku-3-5-20241022';
  if (legacy) return 'claude-haiku-4-5';
  if (raw) return raw;
  return 'claude-haiku-4-5';
}

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

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';').map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) return decodeURIComponent(part.slice(name.length + 1));
  }
  return '';
}

async function moderateTextWithClaude(text, anthropicKey, model) {
  const prompt = buildTextModerationPrompt(text);

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
  const raw = data?.content?.[0]?.text;
  return parseModerationResponse(raw);
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

/** Smaller images = faster Claude vision calls; full file stays in Storage. */
async function prepareImageBufferForModeration(fileBuffer, mediaType) {
  if (!mediaType.startsWith('image/')) {
    return { buffer: fileBuffer, mediaType };
  }
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return { buffer: fileBuffer, mediaType };
  }
  try {
    const maxSide = 1280;
    const out = await sharp(fileBuffer, { animated: false, pages: 1 })
      .rotate()
      .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    return { buffer: out, mediaType: 'image/jpeg' };
  } catch (e) {
    console.error('prepareImageBufferForModeration', e);
    return { buffer: fileBuffer, mediaType };
  }
}

async function moderateDocxViaExtractedText(docxBuffer, anthropicKey, moderationModel) {
  const mammoth = require('mammoth');
  let text = '';
  try {
    const result = await mammoth.extractRawText({ buffer: docxBuffer });
    text = (result.value || '').trim();
  } catch (e) {
    console.error('mammoth moderation extract', e);
    return { pass: false, reason: 'Could not read this Word document for moderation.' };
  }
  if (text.length < 40) {
    return {
      pass: false,
      reason: 'Very little text in this document; add context in the text box or try a PDF.',
    };
  }
  const max = 100000;
  const sample =
    text.length > max ? `${text.slice(0, max)}\n\n[… excerpt truncated for moderation …]` : text;
  const wrapped = `[Moderation: extracted text from uploaded Word file for SIOP notes hub]\n\n${sample}`;
  return moderateTextWithClaude(wrapped, anthropicKey, moderationModel);
}

async function moderatePdfViaExtractedText(pdfBuffer, anthropicKey, moderationModel) {
  // pdf-parse v2 bundles PDF.js; Node needs DOMMatrix etc. from the worker entry (uses @napi-rs/canvas).
  try {
    require('pdf-parse/worker');
  } catch (e) {
    console.error('pdf-parse/worker preload failed', e);
    return {
      pass: false,
      reason:
        'Could not initialize PDF text extraction on the server. Try re-exporting the PDF or splitting the file.',
    };
  }
  const { PDFParse } = require('pdf-parse');
  let parser;
  let text = '';
  try {
    parser = new PDFParse({ data: pdfBuffer });
    const result = await parser.getText({ first: 100 });
    text = (result.text || '').trim();
  } catch (e) {
    console.error('pdf-parse moderation', e);
    return {
      pass: false,
      reason:
        'Could not read this PDF for moderation. Try fewer pages, re-export as PDF, or split the file.',
    };
  } finally {
    try {
      if (parser && typeof parser.destroy === 'function') await parser.destroy();
    } catch {}
  }
  if (text.length < 80) {
    return {
      pass: false,
      reason:
        'This PDF has almost no extractable text (it may be mostly slides-as-images). Try exporting with selectable text or fewer pages.',
    };
  }
  const max = 100000;
  const sample =
    text.length > max ? `${text.slice(0, max)}\n\n[… excerpt truncated for moderation …]` : text;
  const wrapped = `[Moderation: extracted text from the first pages of an uploaded PDF]\n\n${sample}`;
  return moderateTextWithClaude(wrapped, anthropicKey, moderationModel);
}

/**
 * PDF: Prefer public URL (tiny JSON; Anthropic fetches the file). Vision often 400s on long slide decks
 * (page/token limits), not because of file size — a 5–6 MB “combined slides” PDF can still exceed limits.
 * Fallback: base64 vision, then first-pages text (reliable for big decks).
 */
async function moderatePdfAttachment(fileBuffer, anthropicKey, moderationModel, publicFileUrl) {
  const tryVision = async (useUrl) => {
    return moderateAttachmentWithClaude(
      fileBuffer,
      'application/pdf',
      anthropicKey,
      moderationModel,
      useUrl ? publicFileUrl : null
    );
  };

  const bytes = fileBuffer.length;
  /** Above ~3 MB, a second full-PDF vision call (base64) usually repeats the same 400 as URL vision. */
  const largeDeck = bytes >= 3 * 1024 * 1024;

  if (publicFileUrl && /^https?:\/\//i.test(publicFileUrl)) {
    try {
      return await tryVision(true);
    } catch (e) {
      if (e.statusCode !== 400 && e.statusCode !== 413) throw e;
      console.error('PDF moderation (URL) failed:', e.detail || e.message);
      const detail = String(e.detail || '').toLowerCase();
      const urlFetchProblem =
        /unable to fetch|could not fetch|failed to download|fetch.*pdf|invalid.*url|retrieve.*document/.test(
          detail
        );
      if (largeDeck && !urlFetchProblem) {
        console.error(
          'PDF (~%s MB): skipping base64 vision; using text sample (large slide decks often exceed vision page limits).',
          (bytes / (1024 * 1024)).toFixed(1)
        );
        return moderatePdfViaExtractedText(fileBuffer, anthropicKey, moderationModel);
      }
    }
  }
  try {
    return await tryVision(false);
  } catch (e) {
    if (e.statusCode !== 400 && e.statusCode !== 413) throw e;
    console.error('PDF moderation (base64) failed:', e.detail || e.message);
    return moderatePdfViaExtractedText(fileBuffer, anthropicKey, moderationModel);
  }
}

async function moderateAttachmentWithClaude(fileBuffer, mediaType, anthropicKey, model, publicFileUrl) {
  const prompt = ATTACHMENT_MODERATION_PROMPT;

  let content;
  if (mediaType === 'application/pdf' && publicFileUrl && /^https?:\/\//i.test(publicFileUrl)) {
    content = [
      { type: 'document', source: { type: 'url', url: publicFileUrl } },
      { type: 'text', text: prompt },
    ];
  } else if (mediaType.startsWith('image/')) {
    const source = {
      type: 'base64',
      media_type: mediaType,
      data: fileBuffer.toString('base64'),
    };
    content = [{ type: 'image', source }, { type: 'text', text: prompt }];
  } else if (mediaType === 'application/pdf') {
    const source = {
      type: 'base64',
      media_type: mediaType,
      data: fileBuffer.toString('base64'),
    };
    content = [{ type: 'document', source }, { type: 'text', text: prompt }];
  } else {
    throw new Error(`Unsupported media type for Claude document API: ${mediaType}`);
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 180,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    let detail = errText;
    try {
      const j = JSON.parse(errText);
      detail = j?.error?.message || errText;
    } catch {}
    const err = new Error(`Attachment moderation API failed: ${response.status}`);
    err.statusCode = response.status;
    err.detail = detail;
    err.responseBody = errText;
    throw err;
  }
  const data = await response.json();
  const raw = data?.content?.[0]?.text;
  return parseModerationResponse(raw);
}


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const localEnv = readLocalEnvFile();
  const sitePassword = process.env.SITE_PASSWORD || localEnv.SITE_PASSWORD || '';
  if (sitePassword) {
    const cookieVal = readCookie(req, 'siop_access');
    if (cookieVal !== sitePassword) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

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

      let fileModeration;
      if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        fileModeration = await moderateDocxViaExtractedText(fileBuffer, anthropicKey, moderationModel);
      } else if (mediaType === 'application/pdf') {
        try {
          fileModeration = await moderatePdfAttachment(fileBuffer, anthropicKey, moderationModel, fileUrl);
        } catch (err) {
          const hint = (err.detail || err.message || '').slice(0, 600);
          console.error('PDF moderation error', err.responseBody || err);
          return res.status(500).json({
            error: `Submission moderation failed: ${hint || err.message}`,
          });
        }
      } else {
        const imageModel = resolveImageModerationModel(
          process.env.ANTHROPIC_MODEL_IMAGE_MODERATION,
          localEnv.ANTHROPIC_MODEL_IMAGE_MODERATION
        );
        const modelForAttachment = mediaType.startsWith('image/') ? imageModel : moderationModel;
        const { buffer: modBuffer, mediaType: modMediaType } = await prepareImageBufferForModeration(
          fileBuffer,
          mediaType
        );
        try {
          fileModeration = await moderateAttachmentWithClaude(
            modBuffer,
            modMediaType,
            anthropicKey,
            modelForAttachment,
            null
          );
        } catch (err) {
          const hint = (err.detail || err.message || '').slice(0, 600);
          console.error('Attachment moderation error', err.responseBody || err);
          return res.status(500).json({
            error: `Submission moderation failed: ${hint || err.message}`,
          });
        }
      }
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
