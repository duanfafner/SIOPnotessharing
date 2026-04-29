/* ============================================
   app.js — SIOP 2026 Conference Notes Hub
   ============================================ */

// ── Supabase API helper ──────────────────────
function sbFetch(path, opts = {}) {
  return fetch(`${CONFIG.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: CONFIG.SUPABASE_KEY,
      Authorization: `Bearer ${CONFIG.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...opts.headers,
    },
    ...opts,
  }).then(async (r) => {
    const text = await r.text();
    if (!r.ok) {
      throw new Error(text || `Supabase request failed: ${r.status}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  });
}

// ── State ────────────────────────────────────
let SESSIONS = [];
let NOTES = [];
let selectedSession = null;
let selectedFile = null;

// ── Init ─────────────────────────────────────
async function init() {
  try {
    SESSIONS = await sbFetch('sessions?select=*&order=session_id');
    if (!Array.isArray(SESSIONS)) SESSIONS = [];
  } catch (e) {
    console.error('Failed to load sessions:', e);
    SESSIONS = [];
  }

  populateBrowseFilters();
  await loadNotes();
  bindEvents();
}

function populateBrowseFilters() {
  const daySelect = document.getElementById('f-day');
  const trackSelect = document.getElementById('f-track');
  if (!daySelect || !trackSelect) return;

  const dayValues = [...new Set(SESSIONS.map((s) => (s.day || '').trim()).filter(Boolean))].sort();
  const trackValues = [...new Set(SESSIONS.map((s) => (s.track || '').trim()).filter(Boolean))].sort();

  daySelect.innerHTML = '<option value="">All days</option>' +
    dayValues.map((d) => `<option value="${d}">${d}</option>`).join('');

  trackSelect.innerHTML = '<option value="">All tracks</option>' +
    trackValues.map((t) => `<option value="${t}">${t}</option>`).join('');
}

async function loadNotes() {
  try {
    NOTES = await sbFetch(
      'notes?select=*&moderation_status=eq.approved&order=created_at.desc'
    );
    if (!Array.isArray(NOTES)) NOTES = [];
  } catch (e) {
    NOTES = [];
  }
}

// ── Event bindings ───────────────────────────
function bindEvents() {
  // Tab switching
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab, tab));
  });

  // Session search
  const searchInput = document.getElementById('session-search');
  searchInput.addEventListener('input', () => filterSessions(searchInput.value));
  searchInput.addEventListener('focus', () => filterSessions(searchInput.value));

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      document.getElementById('session-dd').classList.add('hidden');
    }
  });

  // File upload
  const fileInput = document.getElementById('file-input');
  const uploadZone = document.getElementById('upload-zone');
  uploadZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFile(fileInput));
  uploadZone.addEventListener('dragenter', onDragOverZone);
  uploadZone.addEventListener('dragover', onDragOverZone);
  uploadZone.addEventListener('dragleave', onDragLeaveZone);
  uploadZone.addEventListener('drop', onDropFile);

  // Submit
  document.getElementById('submit-btn').addEventListener('click', submitNote);

  // Browse filters
  document.getElementById('browse-search').addEventListener('input', renderBrowse);
  document.getElementById('f-day').addEventListener('change', renderBrowse);
  document.getElementById('f-track').addEventListener('change', renderBrowse);
  document.getElementById('f-notes').addEventListener('change', renderBrowse);
}

// ── Tab switching ────────────────────────────
function switchTab(tabName, el) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  el.classList.add('active');

  document.getElementById('tab-contribute').classList.toggle('hidden', tabName !== 'contribute');
  document.getElementById('tab-browse').classList.toggle('hidden', tabName !== 'browse');

  if (tabName === 'browse') renderBrowse();
}

// ── Session search ───────────────────────────
function filterSessions(query) {
  const dd = document.getElementById('session-dd');
  const q = (query || '').trim().toLowerCase();
  const matches = q
    ? SESSIONS.filter(
        (s) =>
          s.title?.toLowerCase().includes(q) ||
          s.session_id?.toString().includes(q) ||
          s.speakers?.toLowerCase().includes(q)
      ).slice(0, 8)
    : SESSIONS.slice(0, 8);

  if (!matches.length) { dd.classList.add('hidden'); return; }

  dd.innerHTML = matches
    .map(
      (s) => `
      <div class="dd-item" data-id="${s.session_id}">
        <div class="dd-name">${s.title?.substring(0, 90) || ''}</div>
        <div class="dd-meta">ID ${s.session_id} · ${s.day || ''} · ${s.time_slot || ''}</div>
      </div>`
    )
    .join('');

  dd.querySelectorAll('.dd-item').forEach((item) => {
    item.addEventListener('click', () => selectSession(item.dataset.id));
  });

  dd.classList.remove('hidden');
}

function selectSession(id) {
  selectedSession = SESSIONS.find((s) => String(s.session_id) === String(id));
  if (!selectedSession) return;

  document.getElementById('session-search').value = selectedSession.title || '';
  document.getElementById('session-dd').classList.add('hidden');

  const display = document.getElementById('sel-display');
  display.classList.remove('hidden');
  display.innerHTML = `
    <div class="sel-session">
      <div class="sel-title">${selectedSession.title || ''}</div>
      <div class="sel-meta">
        ID ${selectedSession.session_id} · ${selectedSession.track || ''} ·
        ${selectedSession.day || ''}, ${selectedSession.time_slot || ''}
      </div>
    </div>`;
}

// ── File handling ────────────────────────────
const ALLOWED_FILE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'docx'];

function isSupportedFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return ALLOWED_FILE_EXTENSIONS.includes(ext);
}

function setSelectedFile(file) {
  if (!file) return;
  if (!isSupportedFile(file)) {
    showFeedback('error', 'Unsupported file type. Please upload PDF, image, or Word files.');
    return;
  }

  selectedFile = file;
  const prev = document.getElementById('file-prev');
  prev.classList.remove('hidden');
  prev.innerHTML = `
    <div class="file-card">
      <span class="fname">📎 ${selectedFile.name}</span>
      <button id="remove-file">Remove</button>
    </div>`;
  document.getElementById('remove-file').addEventListener('click', clearFile);
}

function handleFile(input) {
  if (!input.files.length) return;
  setSelectedFile(input.files[0]);
}

function onDragOverZone(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('upload-zone').classList.add('dragover');
}

function onDragLeaveZone(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('upload-zone').classList.remove('dragover');
}

function onDropFile(e) {
  e.preventDefault();
  e.stopPropagation();
  const uploadZone = document.getElementById('upload-zone');
  uploadZone.classList.remove('dragover');

  const files = e.dataTransfer?.files;
  if (!files || !files.length) return;

  const file = files[0];
  setSelectedFile(file);
}

function clearFile() {
  selectedFile = null;
  document.getElementById('file-input').value = '';
  document.getElementById('file-prev').classList.add('hidden');
}

// ── Submit note ──────────────────────────────
async function submitNote() {
  const text = document.getElementById('note-text').value.trim();

  if (!selectedSession) { showFeedback('error', 'Please select a session first.'); return; }
  if (!text && !selectedFile) { showFeedback('error', 'Please add some notes or attach a file.'); return; }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  showFeedback('loading', 'Reviewing and saving your submission...');

  try {
    // 1. Upload file if present
    let fileUrl = null, fileName = null, fileType = null;
    if (selectedFile) {
      const upload = await uploadFile(selectedFile);
      if (upload) {
        fileUrl = upload.url;
        fileName = upload.name;
        fileType = upload.type;
      }
    }

    // 2. Submit through server-side moderation route
    const submitRes = await fetch('/api/submit-note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: selectedSession.session_id,
        text,
        fileUrl,
        fileName,
        fileType,
      }),
    });
    const submitData = await submitRes.json().catch(() => ({}));
    if (!submitRes.ok || submitData?.pass === false) {
      const reason = submitData?.reason || submitData?.error || 'Submission failed moderation.';
      showFeedback('error', `Submission not accepted: ${reason}`);
      btn.disabled = false;
      return;
    }

    // 4. Reset form
    showFeedback('success', 'Your notes have been shared. Thank you for contributing!');
    document.getElementById('note-text').value = '';
    clearFile();
    document.getElementById('session-search').value = '';
    document.getElementById('sel-display').classList.add('hidden');
    selectedSession = null;

    await loadNotes();
    setTimeout(() => { document.getElementById('submit-feedback').innerHTML = ''; }, 5000);
  } catch (e) {
    console.error('Submit error:', e);
    showFeedback('error', 'Something went wrong. Please try again.');
  }

  btn.disabled = false;
}

// ── File upload to Supabase Storage ──────────
async function uploadFile(file) {
  try {
    const ext = file.name.split('.').pop();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `notes/${Date.now()}_${safeName}`;

    const res = await fetch(
      `${CONFIG.SUPABASE_URL}/storage/v1/object/conference-notes/${path}`,
      {
        method: 'POST',
        headers: {
          apikey: CONFIG.SUPABASE_KEY,
          Authorization: `Bearer ${CONFIG.SUPABASE_KEY}`,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      }
    );

    if (!res.ok) { console.error('Upload failed:', await res.text()); return null; }

    return {
      url: `${CONFIG.SUPABASE_URL}/storage/v1/object/public/conference-notes/${path}`,
      name: file.name,
      type: ext,
    };
  } catch (e) {
    console.error('Upload error:', e);
    return null;
  }
}

// ── Browse & render sessions ─────────────────
function renderBrowse() {
  const container = document.getElementById('browse-list');
  const q = document.getElementById('browse-search').value.toLowerCase();
  const day = document.getElementById('f-day').value;
  const track = document.getElementById('f-track').value;
  const notesFilter = document.getElementById('f-notes').value;

  const filtered = SESSIONS.filter((s) => {
    if (day && s.day !== day) return false;
    if (track && s.track !== track) return false;
    if (
      q &&
      !s.title?.toLowerCase().includes(q) &&
      !s.speakers?.toLowerCase().includes(q) &&
      !String(s.session_id || '').toLowerCase().includes(q) &&
      !String(s.track || '').toLowerCase().includes(q)
    ) return false;
    if (notesFilter === 'has-notes') {
      if (!NOTES.some((n) => String(n.session_id) === String(s.session_id))) return false;
    }
    return true;
  });

  if (!filtered.length) {
    container.innerHTML = '<div class="empty">No sessions match your filters.</div>';
    return;
  }

  container.innerHTML = filtered
    .map((s) => {
      const notes = NOTES.filter((n) => String(n.session_id) === String(s.session_id));
      const count = notes.length;
      const trackShort = (s.track || '').split('/')[0];
      const speakerFirst = s.speakers?.split(';')[0]?.trim() || '';

      return `
        <div class="session-card">
          <div class="sc-header" data-id="${s.session_id}">
            <div style="flex:1;min-width:0">
              <div class="sc-badges">
                <span class="badge badge-track">${trackShort}</span>
                <span class="badge badge-count">${count} ${count === 1 ? 'note' : 'notes'}</span>
              </div>
              <div class="sc-title">${s.title?.substring(0, 100) || ''}</div>
              <div class="sc-meta">
                <span>${speakerFirst}</span>
                <span>·</span>
                <span>${s.day || ''}</span>
                <span>·</span>
                <span>${s.time_slot || ''}</span>
              </div>
            </div>
            <span class="chevron" id="chev-${s.session_id}">▼</span>
          </div>
          <div id="body-${s.session_id}" class="hidden">
            <div class="sc-body">
              ${
                count === 0
                  ? '<p class="no-notes-yet">No notes yet — be the first to contribute!</p>'
                  : notes
                      .map(
                        (n) => `
                <div class="note-item">
                  <div class="note-ts">${formatDate(n.created_at)}</div>
                  ${n.free_text ? `<div class="note-text">${n.free_text}</div>` : ''}
                  ${n.file_url ? `<a class="note-file" href="${n.file_url}" target="_blank">📎 ${n.file_name || 'Attachment'}</a>` : ''}
                </div>`
                      )
                      .join('')
              }
              ${count > 0 ? `<button class="dl-btn" data-session="${s.session_id}">Download compiled summary</button>` : ''}
            </div>
          </div>
        </div>`;
    })
    .join('');

  // Bind toggle events
  container.querySelectorAll('.sc-header').forEach((header) => {
    header.addEventListener('click', () => toggleSession(header.dataset.id));
  });

  // Bind download events
  container.querySelectorAll('.dl-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Downloading...';
      showFeedback('loading', 'Generating your PDF summary. This can take a few seconds...');
      try {
        downloadSummary(btn.dataset.session);
      } finally {
        // Keep visible loading state briefly since browser handles file download out-of-band.
        setTimeout(() => {
          btn.disabled = false;
          btn.textContent = original;
        }, 6000);
        setTimeout(() => {
          const fb = document.getElementById('submit-feedback');
          if (fb && fb.textContent.includes('Generating your PDF summary')) {
            fb.innerHTML = '';
          }
        }, 7000);
      }
    });
  });
}

function toggleSession(id) {
  const body = document.getElementById(`body-${id}`);
  const chev = document.getElementById(`chev-${id}`);
  const isOpen = !body.classList.contains('hidden');
  body.classList.toggle('hidden', isOpen);
  chev.classList.toggle('open', !isOpen);
}

// ── Download summary ─────────────────────────
async function downloadSummary(sessionId) {
  const url = `/api/download-summary-pdf?sessionId=${encodeURIComponent(sessionId)}`;
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ── Feedback helper ──────────────────────────
function showFeedback(type, msg) {
  const fb = document.getElementById('submit-feedback');
  const classMap = { success: 'msg-success', error: 'msg-error', loading: 'msg-loading' };
  fb.innerHTML = `<div class="${classMap[type]}">${msg}</div>`;
}

// ── Date formatting ──────────────────────────
function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Start ────────────────────────────────────
init();
