const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const mammoth = require('mammoth');
const JSZip = require('jszip');

function sanitizePdfText(value) {
  return String(value || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x20-\x7E\n\r\t]/g, '');
}

function getFileExtension(fileName) {
  return ((fileName || '').split('.').pop() || '').toLowerCase();
}

function isImageFileName(fileName) {
  const ext = getFileExtension(fileName);
  return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);
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

function wrapText(text, maxCharsPerLine = 100) {
  const words = sanitizePdfText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharsPerLine) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function createSummaryPdf(session, notes, options = {}) {
  const embedAttachments = options.embedAttachments !== false;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([612, 792]);
  let y = 760;
  const margin = 48;
  const lineHeight = 15;

  function ensureSpace(linesNeeded = 1) {
    if (y - linesNeeded * lineHeight < 50) {
      page = pdfDoc.addPage([612, 792]);
      y = 760;
    }
  }

  function drawLine(text, opts = {}) {
    const {
      size = 11,
      useBold = false,
      color = rgb(0, 0, 0),
    } = opts;
    ensureSpace(1);
    page.drawText(sanitizePdfText(text), {
      x: margin,
      y,
      size,
      font: useBold ? bold : font,
      color,
    });
    y -= lineHeight;
  }

  async function drawImageFromUrl(imageUrl, fileName) {
    try {
      const response = await fetch(imageUrl);
      if (!response.ok) return false;
      const contentType = response.headers.get('content-type') || '';
      const ext = getFileExtension(fileName);
      const imageBytes = Buffer.from(await response.arrayBuffer());

      let embedded = null;
      if (contentType.includes('png') || ext === 'png') {
        embedded = await pdfDoc.embedPng(imageBytes);
      } else if (contentType.includes('jpeg') || contentType.includes('jpg') || ext === 'jpg' || ext === 'jpeg') {
        embedded = await pdfDoc.embedJpg(imageBytes);
      } else {
        return false;
      }

      const maxWidth = 500;
      const maxHeight = 280;
      const scale = Math.min(maxWidth / embedded.width, maxHeight / embedded.height, 1);
      const width = embedded.width * scale;
      const height = embedded.height * scale;
      ensureSpace(Math.ceil((height + 10) / lineHeight));
      page.drawImage(embedded, { x: margin, y: y - height, width, height });
      y -= (height + 8);
      return true;
    } catch {
      return false;
    }
  }

  async function appendPdfAttachment(pdfUrl) {
    try {
      const response = await fetch(pdfUrl);
      if (!response.ok) return false;
      const bytes = await response.arrayBuffer();
      const sourcePdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pageIndices = sourcePdf.getPageIndices();
      if (!pageIndices.length) return false;
      const copiedPages = await pdfDoc.copyPages(sourcePdf, pageIndices);
      copiedPages.forEach((p) => pdfDoc.addPage(p));
      return true;
    } catch {
      return false;
    }
  }

  async function appendDocxAttachmentAsPdfSection(fileUrl, fileName) {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) return false;
      const buffer = Buffer.from(await response.arrayBuffer());
      const parsed = await mammoth.extractRawText({ buffer });
      const text = sanitizePdfText(parsed?.value || '').trim();
      if (!text) return false;

      page = pdfDoc.addPage([612, 792]);
      y = 760;
      drawLine(`Attachment Appendix: ${fileName || 'DOCX file'}`, { size: 13, useBold: true });
      drawLine('');
      wrapText(text, 95).forEach((line) => drawLine(line));
      drawLine('');
      return true;
    } catch {
      return false;
    }
  }

  drawLine('SIOP 2026 Annual Conference - Session Notes Summary', { size: 14, useBold: true });
  drawLine('');
  drawLine(`Session: ${session?.title || ''}`, { useBold: true });
  drawLine(`ID: ${session?.session_id || ''}`);
  drawLine(`Track: ${session?.track || ''}`);
  drawLine(`Day: ${session?.day || ''}`);
  drawLine(`Time: ${session?.time_slot || ''}`);
  drawLine(`Location: ${session?.location || 'TBD'}`);
  drawLine(`Speakers: ${session?.speakers || ''}`);
  drawLine('');
  drawLine(`Contributed notes (${notes.length} total)`, { useBold: true });
  drawLine('');

  for (let idx = 0; idx < notes.length; idx++) {
    const note = notes[idx];
    drawLine(`[Note ${idx + 1}] ${note.created_at ? new Date(note.created_at).toLocaleString() : ''}`, { useBold: true });

    if (note.free_text) {
      wrapText(note.free_text, 95).forEach((l) => drawLine(l));
    }

    if (note.file_url) {
      drawLine(`Attachment: ${note.file_name || 'Attachment'}`);
      wrapText(note.file_url, 90).forEach((l) => drawLine(l, { size: 10, color: rgb(0.1, 0.1, 0.6) }));
      if (embedAttachments) {
        const embedded = await drawImageFromUrl(note.file_url, note.file_name || '');
        if (embedded) {
          drawLine('Image embedded above.', { size: 10, color: rgb(0.25, 0.25, 0.25) });
        } else {
          const ext = getFileExtension(note.file_name || '');
          if (ext === 'pdf') {
            const appended = await appendPdfAttachment(note.file_url);
            drawLine(
              appended ? 'PDF attachment appended at the end of this download.' : 'PDF attachment could not be appended.',
              { size: 10, color: rgb(0.25, 0.25, 0.25) }
            );
          } else if (ext === 'docx') {
            const appendedDocx = await appendDocxAttachmentAsPdfSection(note.file_url, note.file_name || '');
            drawLine(
              appendedDocx ? 'DOCX attachment converted and appended as text section.' : 'DOCX attachment could not be converted.',
              { size: 10, color: rgb(0.25, 0.25, 0.25) }
            );
          } else if (ext === 'doc') {
            drawLine('DOC attachment is linked above. Please convert to DOCX for in-PDF conversion.', {
              size: 10,
              color: rgb(0.25, 0.25, 0.25),
            });
          }
        }
      }
    }

    drawLine('');
  }

  drawLine(`Generated: ${new Date().toLocaleString()}`, { size: 10, color: rgb(0.35, 0.35, 0.35) });
  return pdfDoc.save();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionId = String(req.query?.sessionId || '').trim();
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

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
  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Missing required server env vars' });
  }

  const base = supabaseUrl.replace(/\/$/, '');
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  try {
    const sessionRes = await fetch(
      `${base}/rest/v1/sessions?select=*&session_id=eq.${encodeURIComponent(sessionId)}&limit=1`,
      { headers }
    );
    if (!sessionRes.ok) return res.status(500).json({ error: 'Failed to load session' });
    const sessions = await sessionRes.json();
    const session = Array.isArray(sessions) ? sessions[0] : null;
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const notesRes = await fetch(
      `${base}/rest/v1/notes?select=*&session_id=eq.${encodeURIComponent(sessionId)}&moderation_status=eq.approved&order=created_at.desc`,
      { headers }
    );
    if (!notesRes.ok) return res.status(500).json({ error: 'Failed to load notes' });
    const notes = await notesRes.json();
    const noteList = Array.isArray(notes) ? notes : [];

    const zipThreshold = Number(process.env.DOWNLOAD_ZIP_THRESHOLD || localEnv.DOWNLOAD_ZIP_THRESHOLD || 80);
    const useZipPackage = noteList.length >= zipThreshold;

    if (useZipPackage) {
      // For large sessions, return a lighter package for faster download.
      const summaryPdf = await createSummaryPdf(session, noteList, { embedAttachments: false });
      const zip = new JSZip();
      zip.file(`SIOP2026_Session${sessionId}_Summary.pdf`, summaryPdf);

      const attachmentLines = [];
      noteList.forEach((n, i) => {
        if (n.file_url) {
          attachmentLines.push(
            `Note ${i + 1} | ${n.file_name || 'Attachment'} | ${n.file_url}`
          );
        }
      });

      const readme = [
        `SIOP 2026 Session ${sessionId} Download Package`,
        ``,
        `This session exceeded ${zipThreshold} notes, so delivery was automatically switched to ZIP for performance.`,
        `The PDF includes note summaries and metadata.`,
        `Attachment links are listed in ATTACHMENT_LINKS.txt.`,
        ``,
        `Generated: ${new Date().toLocaleString()}`,
      ].join('\n');

      zip.file('README.txt', readme);
      zip.file(
        'ATTACHMENT_LINKS.txt',
        attachmentLines.length ? attachmentLines.join('\n') : 'No attachments in this session.'
      );

      const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=\"SIOP2026_Session${sessionId}_Package.zip\"`);
      return res.status(200).send(zipBytes);
    }

    const pdfBytes = await createSummaryPdf(session, noteList, { embedAttachments: true });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=\"SIOP2026_Session${sessionId}_Notes.pdf\"`);
    return res.status(200).send(Buffer.from(pdfBytes));
  } catch (error) {
    return res.status(500).json({ error: `PDF generation failed: ${error?.message || 'unknown error'}` });
  }
};
