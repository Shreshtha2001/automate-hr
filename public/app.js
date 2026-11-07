/* global state */
const state = {
  candidates: [],
  stagedFiles: [],
  emailStatus: {},
  waReady: false,
};

// ── Tab navigation ──────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));

  if (name === 'screened')    renderScreenedTab();
  if (name === 'shortlisted') renderShortlistedTab();
  if (name === 'email')       renderEmailTab();
  if (name === 'docs')        renderDocsTab();
  if (name === 'indeed')      renderIndeedTab();
}

// ── File staging ────────────────────────────────
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  addFiles([...e.dataTransfer.files]);
});
dropzone.addEventListener('click', e => {
  if (e.target.tagName !== 'BUTTON') fileInput.click();
});
fileInput.addEventListener('change', () => {
  addFiles([...fileInput.files]);
  fileInput.value = '';
});

function addFiles(files) {
  const allowed = ['.pdf', '.doc', '.docx', '.txt'];
  files.forEach(f => {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    if (allowed.includes(ext) && !state.stagedFiles.some(s => s.name === f.name && s.size === f.size)) {
      state.stagedFiles.push(f);
    }
  });
  renderStagedList();
}

function clearFiles() {
  state.stagedFiles = [];
  renderStagedList();
}

function removeFile(index) {
  state.stagedFiles.splice(index, 1);
  renderStagedList();
}

function renderStagedList() {
  const wrap = document.getElementById('staged-list');
  const list = document.getElementById('staged-files');
  const btn  = document.getElementById('screen-btn');

  if (state.stagedFiles.length === 0) {
    wrap.style.display = 'none';
    btn.disabled = true;
    return;
  }

  wrap.style.display = 'block';
  btn.disabled = false;
  document.getElementById('staged-count').textContent = `${state.stagedFiles.length} file(s) ready to screen`;

  list.innerHTML = state.stagedFiles.map((f, i) => `
    <li>
      <span class="fi-icon">${fileIcon(f.name)}</span>
      <span class="fi-name" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="fi-size">${fmtSize(f.size)}</span>
      <button class="fi-remove" onclick="removeFile(${i})" title="Remove">×</button>
    </li>
  `).join('');
}

function fileIcon(name) {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  return ext === '.pdf' ? '📕' : ext === '.docx' || ext === '.doc' ? '📘' : '📄';
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Screening ───────────────────────────────────
async function screenResumes() {
  if (state.stagedFiles.length === 0) return;

  const progressWrap  = document.getElementById('progress-wrap');
  const progressFill  = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');

  progressWrap.style.display = 'block';
  document.getElementById('screen-btn').disabled = true;

  const BATCH = 10;
  const allResults = [];
  const files = state.stagedFiles;
  const total = files.length;

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const fd = new FormData();
    batch.forEach(f => fd.append('resumes', f));

    progressLabel.textContent = `Processing ${Math.min(i + BATCH, total)} of ${total} resume(s)…`;
    progressFill.style.width  = `${((i + BATCH) / total * 100).toFixed(0)}%`;

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      allResults.push(...(data.results || []));
    } catch (err) {
      batch.forEach(f => allResults.push({
        filename: f.name, name: f.name,
        email: null, phone: null, criteria: {}, status: 'review', shortlisted: false,
        error: err.message,
      }));
    }
  }

  progressFill.style.width  = '100%';
  progressLabel.textContent = `Done! Screened ${total} resume(s).`;

  // Preserve existing candidates (append new ones), reset only new entries
  const existingNames = new Set(state.candidates.map(c => c.filename));
  allResults.forEach(c => {
    if (!c.manualStatus) c.manualStatus = 'screened';
    if (!existingNames.has(c.filename)) {
      state.candidates.push(c);
      state.emailStatus[state.candidates.length - 1] = 'pending';
    }
  });

  saveState();
  setTimeout(() => { progressWrap.style.display = 'none'; }, 800);

  updateBadges();
  switchTab('screened');
  document.getElementById('screen-btn').disabled = false;
  clearFiles();
}

// ── Candidate card renderer ──────────────────────
const CRITERION_META = {
  location:             { label: 'Location (KWC)' },
  contact:              { label: 'Contact Info' },
  vehicle:              { label: "Driver's Licence / Vehicle" },
  contractor:           { label: 'Contractor Openness' },
  paid_experience:      { label: 'Paid Experience (2+ yrs)' },
  skill_breadth:        { label: 'Skill Breadth (4+ areas)' },
  own_tools:            { label: 'Owns Tools' },
  paid_cleaning:        { label: 'Paid Cleaning (1+ yr)' },
  residential_cleaning: { label: 'Residential Cleaning' },
  cert_309a:            { label: '309A Certificate' },
  lec_licence:          { label: 'ECRA/ESA LEC Licence' },
  cert_306a:            { label: '306A Certificate' },
  tssa_gas:             { label: 'TSSA Gas Licence' },
  canada:               { label: 'Canada' },
  experience:           { label: 'Experience' },
  language:             { label: 'Language' },
  criminal:             { label: 'Background' },
};

const ROLE_LABELS = {
  handyman:    'Handyman',
  cleaner:     'Cleaner',
  electrician: 'Electrician',
  plumber:     'Plumber',
};

function renderCandCard(c, idx, tab) {
  const rec = c.recommendation || (c.status === 'shortlisted' ? 'Phone screen' : c.status === 'review' ? 'Review' : 'Reject');
  const aiLabel = rec === 'Phone screen' ? 'Phone Screen'
                : rec === 'Review'       ? 'Review'
                :                          'Reject';

  const roleTag  = c.role && ROLE_LABELS[c.role] ? `<span class="role-tag">${ROLE_LABELS[c.role]}</span>` : '';
  const scorePts = c.score != null ? c.score : null;
  const scoreTag = scorePts != null
    ? `<span class="score-tag ${scorePts >= 70 ? 'score-pass' : 'score-fail'}">${scorePts}/100</span>`
    : '';

  const criteriaObj = c.criteria || c.knockouts || {};
  const criteriaHTML = Object.entries(CRITERION_META).map(([key, meta]) => {
    const crit = criteriaObj[key];
    if (!crit) return '';
    const icon       = crit.pass ? '✓' : crit.uncertain ? '~' : '✗';
    const dotClass   = crit.pass ? 'crit-dot-pass' : crit.uncertain ? 'crit-dot-warn' : 'crit-dot-fail';
    const labelClass = crit.pass ? 'crit-label'    : crit.uncertain ? 'crit-label-warn' : 'crit-label-fail';
    return `
      <div class="crit-row">
        <span class="crit-dot ${dotClass}">${icon}</span>
        <div class="crit-body">
          <span class="${labelClass}">${meta.label}</span>
          <span class="crit-reason">${esc(crit.reason || '')}</span>
        </div>
      </div>`;
  }).join('');

  const redFlagsHTML = (c.redFlags && c.redFlags.length > 0)
    ? `<div class="red-flags-block"><span class="red-flags-title">⚠️ Red Flags</span><ul class="red-flags-list">${c.redFlags.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>`
    : '';

  const scoreBreakdownHTML = (c.scoreBreakdown && c.scoreBreakdown.length > 0)
    ? `<details class="score-breakdown"><summary>Score breakdown (${scorePts}/100)</summary><table class="score-table"><thead><tr><th>Criterion</th><th>Max</th><th>Earned</th></tr></thead><tbody>${c.scoreBreakdown.map(r => `<tr><td>${esc(r.criterion)}${r.note ? ` <small>(${esc(r.note)})</small>` : ''}</td><td>${r.max}</td><td>${r.earned}</td></tr>`).join('')}</tbody></table></details>`
    : '';

  const contact = [
    c.email
      ? `<span>📧 <span class="contact-val">${esc(c.email)}</span> <button class="edit-btn" onclick="editEmail(${idx})" title="Edit email">✏️</button></span>`
      : `<span class="no-contact">No email — <button class="link-btn" onclick="editEmail(${idx})">add one</button></span>`,
    c.phone ? `<span>📱 <span class="contact-val">${esc(c.phone)}</span></span>` : '',
  ].filter(Boolean).join('');

  let actions = '';
  if (tab === 'screened') {
    const notesBtn = c.notes
      ? `<button class="btn btn-notes-filled" onclick="openAddNotes(${idx})">📝 Notes</button>`
      : `<button class="btn btn-outline" onclick="openAddNotes(${idx})">📝 Notes</button>`;
    const isRejected = c.manualStatus === 'hr_rejected';
    const isScheduled = c.manualStatus === 'interview_scheduled';
    actions = `
      <button class="btn btn-primary" onclick="shortlistCandidate(${idx})">⭐ Shortlist</button>
      ${notesBtn}
      ${c.email ? `<button class="btn btn-outline" onclick="sendOneEmail(${idx})">📧 Email</button>` : ''}
      ${isScheduled
        ? `<button class="btn btn-success" onclick="unscheduleInterview(${idx})">📅 Scheduled ✓</button>`
        : `<button class="btn btn-ghost" onclick="scheduleInterview(${idx})">📅 Interview Scheduled</button>`}
      ${isRejected
        ? `<button class="btn btn-ghost" onclick="undoReject(${idx})">↩ Undo Reject</button>`
        : `<button class="btn btn-danger" onclick="rejectCandidate(${idx})">✕ Reject</button>`}
      <button class="btn btn-ghost" onclick="removeCandidate(${idx})">🗑 Remove</button>
    `;
  } else if (tab === 'shortlisted') {
    const emailSent = state.emailStatus[idx] === 'sent';
    const emailFailed = state.emailStatus[idx] === 'failed';
    const notesBtn = c.notes
      ? `<button class="btn btn-notes-filled" onclick="openAddNotes(${idx})">📝 Notes</button>`
      : `<button class="btn btn-outline" onclick="openAddNotes(${idx})">📝 Notes</button>`;

    const emailBtn = emailSent
      ? `<span class="card-email-badge badge-sent">✅ Emailed</span>`
      : emailFailed
        ? `<span class="card-email-badge badge-failed">❌ Failed</span>
           ${c.email ? `<button class="btn btn-primary" onclick="sendOneEmail(${idx})">↩ Retry</button>` : ''}`
        : c.email ? `<button class="btn btn-primary" onclick="sendOneEmail(${idx})">📧 Email</button>` : '';

    const resumeFile = c.storedFilename || c.filename;
    const resumeBtn = c.resumeBase64
      ? `<button class="btn btn-outline" onclick="openResume(${idx})">📄 View Resume</button>`
      : resumeFile
        ? `<button class="btn btn-outline" onclick="openResume(${idx})">📄 View Resume</button>
           <label class="btn btn-ghost" title="Attach PDF to enable persistent viewing" style="cursor:pointer">
             📎 Attach Resume<input type="file" accept=".pdf,.doc,.docx" hidden onchange="attachResume(${idx}, this)">
           </label>`
        : `<label class="btn btn-ghost" style="cursor:pointer">
             📎 Attach Resume<input type="file" accept=".pdf,.doc,.docx" hidden onchange="attachResume(${idx}, this)">
           </label>`;

    const schedBtn = c.manualStatus === 'interview_done'
      ? `<button class="btn btn-success" onclick="markInterviewDone(${idx})" disabled>✅ Interview Done</button>`
      : c.manualStatus === 'interview_booked'
        ? `<button class="btn btn-warning" onclick="markInterviewDone(${idx})">✅ Interview Done</button>`
        : `<button class="btn btn-ghost" onclick="bookInterview(${idx})">📅 Schedule Interview</button>`;

    actions = `
      ${resumeBtn}
      ${emailBtn}
      ${notesBtn}
      ${schedBtn}
      <button class="btn btn-danger" onclick="rejectFromShortlist(${idx})">✕ Reject</button>
      <button class="btn btn-ghost" onclick="removeFromShortlist(${idx})" title="Remove from shortlist">🗑 Remove</button>
    `;
  }

  const interviewBadge = c.manualStatus === 'hr_rejected'
    ? `<span class="interview-badge rejected-badge">HR Rejected</span>`
    : c.manualStatus === 'interview_scheduled'
      ? `<span class="interview-badge scheduled-badge">Interview Scheduled</span>`
      : c.manualStatus === 'interview_booked'
        ? `<span class="interview-badge booked-badge">Interview Booked</span>`
        : c.manualStatus === 'interview_done'
          ? `<span class="interview-badge done-badge">Interview Done</span>`
          : '';

  const cardExtraClass = c.manualStatus === 'interview_scheduled' || c.manualStatus === 'interview_done'
    ? ' interview-done'
    : c.manualStatus === 'interview_booked'
      ? ' interview-booked'
      : '';

  return `
    <div class="cand-card status-${c.status}${cardExtraClass}" id="card-${idx}">
      <div class="cand-head">
        <span class="status-badge badge-${c.status}">${aiLabel}</span>
        ${roleTag}${scoreTag}
        ${interviewBadge}
        <span class="cand-filename" title="${esc(c.filename)}">${esc(c.filename)}</span>
      </div>
      <div class="cand-info">
        <div class="cand-name">${esc(c.name || 'Unknown')}</div>
        <div class="cand-contact">
          ${contact || '<span class="no-contact">No contact info found</span>'}
        </div>
      </div>
      <div class="cand-criteria">${criteriaHTML}</div>
      ${redFlagsHTML}
      ${scoreBreakdownHTML}
      ${actions ? `<div class="cand-actions">${actions}</div>` : ''}
    </div>`;
}

// ── Screened tab ────────────────────────────────
function renderScreenedTab() {
  const inner = document.getElementById('screened-inner');
  const visible = state.candidates.filter(c => c.manualStatus !== 'shortlisted');

  if (visible.length === 0) {
    inner.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <p>${state.candidates.length === 0
          ? 'No resumes screened yet.<br>Use <strong>Upload &amp; Screen</strong> to get started.'
          : 'All candidates have been shortlisted.'}
        </p>
      </div>`;
    return;
  }

  const grid = visible.map(c => {
    const idx = state.candidates.indexOf(c);
    return renderCandCard(c, idx, 'screened');
  }).join('');

  inner.innerHTML = `<div class="results-grid">${grid}</div>`;
}

// ── Shortlisted tab ─────────────────────────────
function renderShortlistedTab() {
  const inner = document.getElementById('shortlisted-inner');
  const sl = state.candidates.filter(c => c.manualStatus === 'shortlisted');

  if (sl.length === 0) {
    inner.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⭐</div>
        <p>${state.candidates.length === 0
          ? 'No resumes screened yet.'
          : 'No candidates shortlisted yet.<br>Go to <strong>Screened</strong> and click ⭐ Shortlist.'}
        </p>
      </div>`;
    return;
  }

  const grid = sl.map(c => {
    const idx = state.candidates.indexOf(c);
    return renderCandCard(c, idx, 'shortlisted');
  }).join('');

  inner.innerHTML = `
    <div class="shortlisted-header">
      <h2>⭐ ${sl.length} Shortlisted</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-success" onclick="exportShortlistedToExcel()">📊 Export Excel</button>
        <button class="btn btn-primary" onclick="switchTab('email')">📧 Email All</button>
      </div>
    </div>
    <div class="results-grid">${grid}</div>`;
}

// ── Manual actions ──────────────────────────────
function shortlistCandidate(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  c.manualStatus = 'shortlisted';
  saveState();
  updateBadges();
  renderScreenedTab();
  showToast(`⭐ ${c.name || 'Candidate'} added to shortlist!`, 'success');
}

function scheduleInterview(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  c.manualStatus = 'interview_scheduled';
  saveState();
  renderScreenedTab();
  showToast(`📅 Interview marked as scheduled for ${c.name || 'candidate'}.`, 'success');
}

function unscheduleInterview(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  c.manualStatus = 'screened';
  saveState();
  renderScreenedTab();
  showToast(`↩ Interview mark removed for ${c.name || 'candidate'}.`);
}

function openResume(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  if (c.resumeBase64) {
    const mime = c.resumeMimeType || 'application/pdf';
    const bytes = atob(c.resumeBase64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: mime }));
    window.open(url, '_blank');
    return;
  }
  const f = c.storedFilename || c.filename;
  if (f) window.open(`/api/resume/${encodeURIComponent(f)}`, '_blank');
  else showToast('Resume file not available — please re-upload.', 'error');
}

function attachResume(idx, input) {
  const c = state.candidates[idx];
  if (!c || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = function(e) {
    const base64 = e.target.result.split(',')[1];
    c.resumeBase64 = base64;
    c.resumeMimeType = file.type || 'application/pdf';
    saveState();
    renderShortlistedTab();
    showToast(`📎 Resume attached for ${c.name || 'candidate'}.`, 'success');
  };
  reader.readAsDataURL(file);
}

function bookInterview(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  c.manualStatus = 'interview_booked';
  saveState();
  renderShortlistedTab();
  showToast(`📅 Interview scheduled for ${c.name || 'candidate'}.`, 'success');
}

function markInterviewDone(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  c.manualStatus = 'interview_done';
  saveState();
  renderShortlistedTab();
  showToast(`✅ Interview done for ${c.name || 'candidate'}.`, 'success');
}

function rejectCandidate(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  if (!confirm(`Reject ${c.name || 'this candidate'}? They will stay visible with a Rejected badge.`)) return;
  c.manualStatus = 'hr_rejected';
  saveState();
  renderScreenedTab();
  showToast(`✕ ${c.name || 'Candidate'} marked as rejected.`);
}

function undoReject(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  c.manualStatus = 'screened';
  saveState();
  renderScreenedTab();
  showToast(`↩ ${c.name || 'Candidate'} rejection undone.`);
}

function rejectFromShortlist(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  if (!confirm(`Reject ${c.name || 'this candidate'} and move them back to Screened?`)) return;
  c.manualStatus = 'hr_rejected';
  saveState();
  updateBadges();
  renderShortlistedTab();
  renderScreenedTab();
  showToast(`✕ ${c.name || 'Candidate'} rejected and moved to Screened.`);
}

// ── Notes ───────────────────────────────────────
let _notesIdx = null;

function openAddNotes(idx) {
  _notesIdx = idx;
  const c = state.candidates[idx];
  document.getElementById('notes-modal-name').textContent = c.name || 'Candidate';
  document.getElementById('notes-textarea').value = c.notes || '';
  document.getElementById('notes-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('notes-textarea').focus(), 50);
}

function closeNotesModal(e) {
  if (e && e.target !== document.getElementById('notes-modal')) return;
  document.getElementById('notes-modal').style.display = 'none';
  _notesIdx = null;
}

function saveNotes() {
  if (_notesIdx === null) return;
  const notes = document.getElementById('notes-textarea').value.trim();
  state.candidates[_notesIdx].notes = notes;
  saveState();
  refreshCard(_notesIdx);
  document.getElementById('notes-modal').style.display = 'none';
  _notesIdx = null;
  showToast('📝 Notes saved.', 'success');
}

function removeFromShortlist(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  c.manualStatus = 'screened';
  saveState();
  updateBadges();
  renderShortlistedTab();
  showToast(`Removed ${c.name || 'candidate'} from shortlist.`);
}

function removeCandidate(idx) {
  const c = state.candidates[idx];
  if (!c) return;
  if (!confirm(`Remove ${c.name || 'this candidate'} from the list entirely?`)) return;

  state.candidates.splice(idx, 1);

  // Re-index emailStatus after removal
  const shifted = {};
  Object.entries(state.emailStatus).forEach(([k, v]) => {
    const i = parseInt(k);
    if (i < idx) shifted[i] = v;
    else if (i > idx) shifted[i - 1] = v;
  });
  state.emailStatus = shifted;

  saveState();
  updateBadges();
  renderScreenedTab();
  renderShortlistedTab();
  showToast(`Removed ${c.name || 'candidate'}.`);
}

// ── Email tab ───────────────────────────────────
function renderEmailTab() {
  const sl = state.candidates.filter(c => c.manualStatus === 'shortlisted');
  const subtitle = document.getElementById('email-subtitle');
  const listEl   = document.getElementById('email-candidate-list');
  const sendBtn  = document.getElementById('send-all-btn');
  document.getElementById('badge-email').textContent = sl.length;

  // Populate candidate dropdown
  const select = document.getElementById('email-candidate-select');
  if (select) {
    const prevVal = select.value;
    select.innerHTML = '<option value="">— Select a shortlisted candidate —</option>';
    sl.forEach(c => {
      const idx = state.candidates.indexOf(c);
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = (c.name || 'Unknown') + (state.emailStatus[idx] === 'sent' ? ' ✅' : '');
      select.appendChild(opt);
    });
    if (prevVal && select.querySelector(`option[value="${prevVal}"]`)) {
      select.value = prevVal;
      onCandidateSelect(prevVal, false);
    }
  }

  if (sl.length === 0) {
    subtitle.textContent = 'Shortlist candidates first to send emails.';
    sendBtn.disabled = true;
    listEl.innerHTML = `<div class="empty-state" style="margin:0;padding:24px 0"><p class="text-muted">Shortlisted candidates will appear here.</p></div>`;
    return;
  }

  subtitle.textContent = `${sl.length} shortlisted candidate(s) ready for email outreach.`;
  sendBtn.disabled = false;

  const rows = sl.map(c => {
    const idx = state.candidates.indexOf(c);
    return emailRow(c, idx, state.emailStatus[idx] || 'pending');
  }).join('');

  listEl.innerHTML = `
    <div class="email-list-header">
      <span>Name</span>
      <span>Email</span>
      <span>Status</span>
      <span>Action</span>
    </div>
    ${rows}`;
}

function onCandidateSelect(idxStr, updatePreview = true) {
  const emailField  = document.getElementById('send-email-field');
  const emailInput  = document.getElementById('email-to-input');
  const statusLine  = document.getElementById('send-status-line');
  const toNameEl    = document.getElementById('ep-to-name');
  const previewFrame = document.getElementById('email-preview-frame');

  if (!idxStr) {
    if (emailField) emailField.style.display = 'none';
    if (statusLine) statusLine.style.display = 'none';
    if (toNameEl) toNameEl.textContent = '—';
    if (previewFrame && updatePreview) previewFrame.src = '/api/email-preview';
    return;
  }

  const idx = parseInt(idxStr);
  const c = state.candidates[idx];
  if (!c) return;

  if (emailField) emailField.style.display = 'block';
  if (emailInput) emailInput.value = c.email || '';
  if (toNameEl) toNameEl.textContent = c.email ? `${c.name || ''} <${c.email}>` : (c.name || 'Unknown');

  if (previewFrame && updatePreview) {
    previewFrame.src = `/api/email-preview?name=${encodeURIComponent(c.name || '')}`;
  }

  const es = state.emailStatus[idx] || 'pending';
  if (statusLine) {
    statusLine.style.display = 'block';
    const labels = {
      pending:    '<span class="es-badge es-pending">⏳ Not sent yet</span>',
      sending:    '<span class="es-badge es-sending">🔄 Sending…</span>',
      sent:       '<span class="es-badge es-sent">✅ Email sent successfully</span>',
      failed:     '<span class="es-badge es-failed">❌ Failed — check SMTP config</span>',
      'no-email': '<span class="es-badge es-no-email">⚠️ No email address</span>',
    };
    statusLine.innerHTML = labels[es] || '';
  }
}

async function sendSelectedCandidate() {
  const select = document.getElementById('email-candidate-select');
  const idxStr = select?.value;
  if (!idxStr) { showToast('Please select a candidate first.', 'error'); return; }

  const idx = parseInt(idxStr);
  const c = state.candidates[idx];
  if (!c) return;

  const emailInput = document.getElementById('email-to-input');
  if (emailInput?.value.trim()) c.email = emailInput.value.trim();

  if (!c.email) {
    showToast('No email address. Add one first.', 'error');
    return;
  }

  const btn = document.getElementById('send-one-btn');
  if (btn) btn.disabled = true;

  state.emailStatus[idx] = 'sending';
  onCandidateSelect(idxStr, false);

  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: [c], customTemplate: getCustomTemplate() }),
    });
    const data = await res.json();

    if (!res.ok) {
      state.emailStatus[idx] = 'failed';
      showToast(`Email error: ${data.error || 'Unknown error'}`, 'error');
    } else {
      const r = data.results[0];
      state.emailStatus[idx] = r.status === 'sent' ? 'sent' : 'failed';
      if (r.status === 'sent') showToast(`✅ Email + documents sent to ${c.name || c.email}!`, 'success');
      else showToast(`Failed: ${r.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    state.emailStatus[idx] = 'failed';
    showToast(`Network error: ${err.message}`, 'error');
  }

  if (btn) btn.disabled = false;
  onCandidateSelect(idxStr, false);
  updateEmailRow(idx);
  saveState();
  refreshCard(idx);
  renderEmailTab(); // refresh dropdown label (adds ✅ if sent)
}

function emailRow(c, idx, status) {
  const badge = {
    pending:  '<span class="es-badge es-pending">⏳ Pending</span>',
    sending:  '<span class="es-badge es-sending">🔄 Sending…</span>',
    sent:     '<span class="es-badge es-sent">✅ Sent</span>',
    failed:   '<span class="es-badge es-failed">❌ Failed</span>',
    'no-email': '<span class="es-badge es-no-email">⚠️ No email</span>',
  }[status] || '';

  const actionBtn = c.email && status !== 'sent'
    ? `<button class="btn btn-primary" style="padding:4px 12px;font-size:12px" onclick="sendOneEmail(${idx})">📧 Send</button>`
    : '';

  return `
    <div class="email-row" id="erow-${idx}">
      <span class="email-name">${esc(c.name || 'Unknown')}</span>
      <span class="email-addr">${c.email ? esc(c.email) : '<em style="color:var(--muted)">—</em>'}</span>
      <span class="email-status">${badge}</span>
      <span>${actionBtn}</span>
    </div>`;
}

function updateEmailRow(idx) {
  const c   = state.candidates[idx];
  const row = document.getElementById(`erow-${idx}`);
  if (row) row.outerHTML = emailRow(c, idx, state.emailStatus[idx] || 'pending');
}

function refreshCard(idx) {
  const card = document.getElementById(`card-${idx}`);
  if (!card) return;
  const inShortlisted = document.getElementById('panel-shortlisted').classList.contains('active');
  card.outerHTML = renderCandCard(state.candidates[idx], idx, inShortlisted ? 'shortlisted' : 'screened');
}

// ── Email sending ───────────────────────────────
async function sendOneEmail(idx) {
  const c = state.candidates[idx];
  if (!c || !c.email) return;
  state.emailStatus[idx] = 'sending';
  updateEmailRow(idx);

  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: [c] }),
    });
    const data = await res.json();

    if (!res.ok) {
      state.emailStatus[idx] = 'failed';
      showToast(`Email error: ${data.error || 'Unknown error'}`, 'error');
    } else {
      const r = data.results[0];
      state.emailStatus[idx] = r.status === 'sent' ? 'sent' : 'failed';
      if (r.status === 'failed') showToast(`Failed: ${r.error}`, 'error');
      else showToast(`✅ Email sent to ${c.name || c.email}!`, 'success');
    }
  } catch (err) {
    state.emailStatus[idx] = 'failed';
    showToast(`Network error: ${err.message}`, 'error');
  }
  updateEmailRow(idx);
  refreshCard(idx);
}

async function sendAllEmails() {
  const sl = state.candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.manualStatus === 'shortlisted');

  if (sl.length === 0) return;

  const toSend = sl.filter(({ i }) => state.emailStatus[i] !== 'sent');
  if (toSend.length === 0) { showToast('All candidates already emailed.'); return; }

  if (!window.confirm(`Send emails to ${toSend.length} candidate(s)?`)) return;

  toSend.forEach(({ i }) => { state.emailStatus[i] = 'sending'; updateEmailRow(i); });

  try {
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidates: toSend.map(({ c }) => c), customTemplate: getCustomTemplate() }),
    });
    const data = await res.json();

    if (!res.ok) {
      toSend.forEach(({ i }) => { state.emailStatus[i] = 'failed'; updateEmailRow(i); });
      showToast(`Error: ${data.error || 'Unknown error'}`, 'error');
      return;
    }

    data.results.forEach((r, ri) => {
      const idx = toSend[ri]?.i;
      if (idx === undefined) return;
      state.emailStatus[idx] = r.status === 'sent' ? 'sent' : r.status === 'no-email' ? 'no-email' : 'failed';
      updateEmailRow(idx);
    });

    const sentCount = data.results.filter(r => r.status === 'sent').length;
    showToast(`✅ ${sentCount} email(s) sent successfully.`);
  } catch (err) {
    toSend.forEach(({ i }) => { state.emailStatus[i] = 'failed'; updateEmailRow(i); });
    showToast(`Network error: ${err.message}`, 'error');
  }
}

// ── Excel export ─────────────────────────────────
function buildExcelRows(candidates) {
  return candidates.map(c => {
    const kos = c.criteria || c.knockouts || {};
    const row = {
      'Name':           c.name || 'Unknown',
      'Email':          c.email || '',
      'Phone':          c.phone || '',
      'Resume File':    c.filename || '',
      'Role':           c.role || '',
      'AI Score':       c.score != null ? c.score : '',
      'Recommendation': c.recommendation || (c.status === 'shortlisted' ? 'Phone screen' : c.status === 'review' ? 'Review' : 'Reject'),
      'Red Flags':      (c.redFlags || []).join('; '),
      'AI Status':      c.status || '',
      'Interview':      c.manualStatus === 'hiring_ready' ? 'Done — Ready for Hiring Docs' : c.manualStatus === 'interview_scheduled' ? 'Scheduled' : c.manualStatus === 'hr_rejected' ? 'Rejected' : '',
      'Notes':          c.notes || '',
    };
    // Knock-out columns
    const koKeys = ['location', 'contact', 'vehicle', 'contractor',
                    'paid_experience', 'skill_breadth', 'own_tools',
                    'paid_cleaning', 'residential_cleaning',
                    'cert_309a', 'lec_licence', 'cert_306a', 'tssa_gas'];
    koKeys.forEach(k => {
      const meta = CRITERION_META[k];
      const ko = kos[k];
      if (ko) row[meta ? meta.label : k] = ko.pass ? `Pass — ${ko.reason}` : `Fail — ${ko.reason}`;
    });
    return row;
  });
}

function writeExcel(rows, filename, sheet) {
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = Object.keys(rows[0]).map(k => ({
    wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length), 10)
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  XLSX.writeFile(wb, filename);
}

function exportScreenedToExcel() {
  const candidates = state.candidates.filter(c => c.manualStatus !== 'shortlisted');
  if (candidates.length === 0) { showToast('No screened candidates to export.', 'error'); return; }
  writeExcel(buildExcelRows(candidates), `screened-${new Date().toISOString().slice(0,10)}.xlsx`, 'Screened');
}

function exportShortlistedToExcel() {
  const sl = state.candidates.filter(c => c.manualStatus === 'shortlisted');
  if (sl.length === 0) { showToast('No shortlisted candidates to export.', 'error'); return; }
  writeExcel(buildExcelRows(sl), `shortlisted-${new Date().toISOString().slice(0,10)}.xlsx`, 'Shortlisted');
}

// ── Badges ───────────────────────────────────────
function updateBadges() {
  const screened    = state.candidates.filter(c => c.manualStatus !== 'shortlisted').length;
  const shortlisted = state.candidates.filter(c => c.manualStatus === 'shortlisted').length;
  document.getElementById('badge-screened').textContent    = screened;
  document.getElementById('badge-shortlisted').textContent = shortlisted;
  document.getElementById('badge-email').textContent       = shortlisted;
}

// ── SMTP help toggle ─────────────────────────────
function toggleSmtpHelp() {
  const el = document.getElementById('smtp-help');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ── Docs Received tab ────────────────────────────
function renderDocsTab() {
  // Set Go to OneDrive button href
  const odBtn = document.getElementById('go-to-onedrive-btn');
  if (odBtn && odBtn.getAttribute('href') === '#') {
    fetch('/api/onedrive-folder-url').then(r => r.json()).then(d => {
      if (d.url) odBtn.href = d.url;
    }).catch(() => {});
  }

  // Populate candidate dropdown
  const select = document.getElementById('docs-candidate-select');
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '<option value="">— Select candidate —</option>';
  state.candidates.forEach((c, i) => {
    const opt = document.createElement('option');
    opt.value = c.name || `Candidate ${i}`;
    opt.textContent = c.name || `Candidate ${i}`;
    select.appendChild(opt);
  });
  if (prev) select.value = prev;

  // Refresh upload button state
  docsCheckUploadReady();

  // Load received docs list
  loadDocsReceived();

  // Update redirect URI hint
  const uriEl = document.getElementById('od-redirect-uri');
  if (uriEl) uriEl.textContent = `${location.origin}/api/onedrive-callback`;
}

function docsFileChosen() {
  const input = document.getElementById('docs-file-input');
  const listEl = document.getElementById('docs-file-list');
  const files = [...(input.files || [])];
  if (!files.length) { listEl.style.display = 'none'; return; }
  listEl.style.display = 'block';
  listEl.innerHTML = files.map(f => `<span class="docs-chip">📄 ${esc(f.name)}</span>`).join('');
  docsCheckUploadReady();
}

function docsCheckUploadReady() {
  const btn    = document.getElementById('docs-upload-btn');
  const select = document.getElementById('docs-candidate-select');
  const input  = document.getElementById('docs-file-input');
  if (btn) btn.disabled = !select?.value || !input?.files?.length;
}

async function uploadReceivedDocs() {
  const select = document.getElementById('docs-candidate-select');
  const input  = document.getElementById('docs-file-input');
  const status = document.getElementById('docs-upload-status');
  const btn    = document.getElementById('docs-upload-btn');
  const candidateName = select?.value;
  if (!candidateName || !input?.files?.length) return;

  btn.disabled = true;
  status.style.display = 'block';
  status.innerHTML = '<span class="docs-status-pending">🔄 Uploading &amp; verifying…</span>';

  const fd = new FormData();
  fd.append('candidateName', candidateName);
  [...input.files].forEach(f => fd.append('docs', f));

  try {
    const res  = await fetch('/api/receive-docs', { method: 'POST', body: fd });
    const data = await res.json();

    if (!res.ok) {
      status.innerHTML = `<span class="docs-status-fail">❌ ${esc(data.error || 'Upload failed')}</span>`;
    } else {
      const issues = data.files.filter(f => !f.verified).length;
      const odIcon = { uploaded: '☁️ OneDrive ✓', not_configured: '', error: '⚠️ OneDrive failed', folder_not_found: '⚠️ OneDrive folder not found' }[data.oneDrive?.status] || '';

      if (issues === 0) {
        status.innerHTML = `<span class="docs-status-ok">✅ ${data.files.length} file(s) verified &amp; saved. ${odIcon}</span>`;
      } else {
        const details = data.files
          .filter(f => !f.verified)
          .map(f => `<li><strong>${esc(f.filename)}</strong>: ${f.issues.map(i => esc(i)).join('; ')}</li>`)
          .join('');
        status.innerHTML = `
          <span class="docs-status-warn">⚠️ Uploaded ${odIcon} — AI flagged the following (file is saved, review manually):</span>
          <ul class="docs-issues-list">${details}</ul>`;
      }
      // Reset inputs
      input.value = '';
      document.getElementById('docs-file-list').style.display = 'none';
      btn.disabled = true;
      // Reload list
      loadDocsReceived();
      updateBadges();
    }
  } catch (err) {
    status.innerHTML = `<span class="docs-status-fail">❌ Network error: ${esc(err.message)}</span>`;
  }
  btn.disabled = false;
}

async function loadDocsReceived() {
  const listEl = document.getElementById('docs-received-list');
  if (!listEl) return;
  try {
    const res  = await fetch('/api/docs-received');
    const data = await res.json();
    if (!data.candidates?.length) {
      listEl.innerHTML = '<div class="empty-state" style="margin:0;padding:24px 0"><p class="text-muted">No documents received yet.</p></div>';
      return;
    }
    listEl.innerHTML = data.candidates.map(c => `
      <div class="docs-candidate-block">
        <div class="docs-cand-name">📁 ${esc(c.name)} <span class="docs-count">${c.files.length} file(s)</span></div>
        <div class="docs-files">
          ${c.files.map(f => `
            <div class="docs-file-row">
              <span class="docs-file-name">📄 ${esc(f.filename)}</span>
              <span class="docs-file-size">${(f.size / 1024).toFixed(0)} KB</span>
              <a class="btn btn-outline docs-dl-btn" href="/api/received-doc/${encodeURIComponent(c.name)}/${encodeURIComponent(f.filename)}" download>↓ Download</a>
              <button class="btn btn-ghost docs-del-btn" onclick="deleteReceivedDoc('${esc(c.name)}','${esc(f.filename)}')">✕</button>
            </div>`).join('')}
        </div>
      </div>`).join('');
    // update badge
    const badge = document.getElementById('badge-docs');
    if (badge) badge.textContent = data.candidates.reduce((n, c) => n + c.files.length, 0);
  } catch { /* silent */ }
}

async function deleteReceivedDoc(folder, filename) {
  if (!confirm(`Delete ${filename}?`)) return;
  await fetch(`/api/received-doc/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  loadDocsReceived();
  updateBadges();
}

// ── Toast notifications ──────────────────────────
function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => { requestAnimationFrame(() => { t.classList.add('toast-show'); }); });
  setTimeout(() => {
    t.classList.remove('toast-show');
    setTimeout(() => t.remove(), 350);
  }, 3500);
}

// ── Edit candidate email ─────────────────────────
function editEmail(idx) {
  const c = state.candidates[idx];
  const newEmail = window.prompt('Update email address:', c.email || '');
  if (newEmail === null) return;
  c.email = newEmail.trim();
  saveState();
  renderScreenedTab();
  if (document.getElementById('panel-shortlisted').classList.contains('active')) renderShortlistedTab();
  if (document.getElementById('panel-email').classList.contains('active')) renderEmailTab();
}

// ── Utilities ────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Persistence ──────────────────────────────────
function saveState() {
  const payload = { candidates: state.candidates, emailStatus: state.emailStatus };
  try { localStorage.setItem('automate_hr_state', JSON.stringify(payload)); } catch(e) {}
  fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
}

async function loadState() {
  let serverData  = null;
  let localData   = null;

  // Try server first
  try {
    const res = await fetch('/api/state');
    if (res.ok) {
      const parsed = await res.json();
      if (parsed.candidates && parsed.candidates.length > 0) serverData = parsed;
    }
  } catch(e) {}

  // Try localStorage
  try {
    const saved = localStorage.getItem('automate_hr_state');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.candidates && parsed.candidates.length > 0) localData = parsed;
    }
  } catch(e) {}

  // Use whichever has more candidates (protects against stale server overwriting richer local state)
  const best = (!serverData && !localData) ? null
             : (!serverData) ? localData
             : (!localData)  ? serverData
             : serverData.candidates.length >= localData.candidates.length ? serverData : localData;

  if (!best) return;

  state.candidates  = best.candidates;
  state.emailStatus = best.emailStatus || {};
  state.candidates.forEach(c => { if (!c.manualStatus) c.manualStatus = 'screened'; });
  updateBadges();
  switchTab('screened');

  // Push best back to server if it came from localStorage
  if (best === localData && localData) {
    fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(best) }).catch(() => {});
  }
}

function clearAllData() {
  if (!window.confirm('Clear all screened candidates?')) return;
  state.candidates = [];
  state.emailStatus = {};
  localStorage.removeItem('automate_hr_state');
  fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates: [], emailStatus: {} }) }).catch(() => {});
  updateBadges();
  renderScreenedTab();
  showToast('Data cleared.', 'success');
}

// ── Email template editor ────────────────────────
const TEMPLATE_KEY = 'automate_hr_email_template';

function getCustomTemplate() {
  return localStorage.getItem(TEMPLATE_KEY) || null;
}

async function openEditTemplate() {
  const modal = document.getElementById('edit-template-modal');
  const textarea = document.getElementById('template-editor');
  if (!modal || !textarea) return;

  const saved = getCustomTemplate();
  if (saved) {
    textarea.value = saved;
  } else {
    try {
      const r = await fetch('/api/email-template-default');
      const d = await r.json();
      textarea.value = d.body || '';
    } catch { textarea.value = ''; }
  }
  modal.style.display = 'flex';
  setTimeout(() => textarea.focus(), 50);
}

function closeEditTemplateModal(e) {
  if (e && e.target !== document.getElementById('edit-template-modal')) return;
  document.getElementById('edit-template-modal').style.display = 'none';
}

function saveTemplate() {
  const val = document.getElementById('template-editor').value.trim();
  if (!val) return;
  localStorage.setItem(TEMPLATE_KEY, val);
  document.getElementById('edit-template-modal').style.display = 'none';
  // Refresh the iframe preview
  const frame = document.getElementById('email-preview-frame');
  if (frame) frame.src = frame.src;
  showToast('✅ Email template saved.', 'success');
}

async function resetTemplateToDefault() {
  if (!window.confirm('Reset to the default email template?')) return;
  try {
    const r = await fetch('/api/email-template-default');
    const d = await r.json();
    document.getElementById('template-editor').value = d.body || '';
  } catch { showToast('Could not load default template.', 'error'); }
}

// ── Indeed tab ───────────────────────────────────
let indeedApps = [];

function renderIndeedTab() {
  const inner = document.getElementById('indeed-apps-inner');
  if (!inner) return;
  const visible = indeedApps.filter(a => !a.dismissed);
  if (visible.length === 0) {
    inner.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔗</div>
        <p>No Indeed applications detected yet.<br>New applications will appear here automatically.</p>
      </div>`;
    return;
  }
  inner.innerHTML = `
    <div class="indeed-list">
      ${visible.map(a => indeedAppRow(a)).join('')}
    </div>`;
}

function indeedAppRow(a) {
  const when = formatIndeedTime(a.receivedAt);
  return `
    <div class="indeed-row" id="irow-${CSS.escape(a.id)}">
      <div class="indeed-row-info">
        <span class="indeed-applicant">${esc(a.applicantName)}</span>
        <span class="indeed-job">${esc(a.jobTitle)}</span>
        <span class="indeed-time">${when}</span>
      </div>
      <div class="indeed-row-actions">
        <a class="btn btn-primary" href="${esc(a.indeedUrl)}" target="_blank" rel="noopener">View on Indeed →</a>
        <button class="btn btn-ghost" onclick="dismissIndeedApp('${esc(a.id)}')">Dismiss</button>
      </div>
    </div>`;
}

function formatIndeedTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMin = Math.round((now - d) / 60000);
    if (diffMin < 1)  return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24)   return `${diffH}h ago`;
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

async function dismissIndeedApp(id) {
  indeedApps = indeedApps.map(a => a.id === id ? { ...a, dismissed: true } : a);
  renderIndeedTab();
  updateIndeedBadge();
  try {
    await fetch(`/api/indeed-applications/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
  } catch (_) {}
}

function updateIndeedBadge() {
  const count = indeedApps.filter(a => !a.dismissed).length;
  const badge = document.getElementById('badge-indeed');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }
}

function setIndeedStatus(connected) {
  const dot  = document.getElementById('indeed-dot');
  const text = document.getElementById('indeed-status-text');
  if (dot)  dot.className = `indeed-dot ${connected ? 'dot-live' : 'dot-off'}`;
  if (text) text.textContent = connected ? 'Live — checking every 60s' : 'Disconnected';
}

// ── SSE connection to Indeed stream ──────────────
function initIndeedSSE() {
  const es = new EventSource('/api/indeed-stream');

  es.addEventListener('message', e => {
    try {
      const data = JSON.parse(e.data);

      if (data.type === 'init') {
        indeedApps = data.apps || [];
        setIndeedStatus(true);
        updateIndeedBadge();
        renderIndeedTab();
      }

      if (data.type === 'new_application' && data.app) {
        // Avoid duplicates
        if (!indeedApps.find(a => a.id === data.app.id)) {
          indeedApps.unshift(data.app);
        }
        updateIndeedBadge();
        renderIndeedTab();
        showToast(`🔗 New Indeed application: ${data.app.applicantName}`, 'success');
      }

      if (data.type === 'dismissed') {
        indeedApps = indeedApps.map(a => a.id === data.id ? { ...a, dismissed: true } : a);
        updateIndeedBadge();
        renderIndeedTab();
      }
    } catch (_) {}
  });

  es.onerror = () => setIndeedStatus(false);
  es.onopen  = () => setIndeedStatus(true);
}

loadState().finally(() => {
  document.getElementById('app-loading').classList.add('hidden');
});
initIndeedSSE();
