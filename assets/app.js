// 도서모음 — 기기(localStorage) 저장 정적 앱. 책 그리드 + 4탭(목차/내용/내용요약/메모).
'use strict';
const STORE = 'doso-books-v1';
const TOKEN_KEY = 'doso-edit-token';
const API_BASE = 'https://book-collection-api.junyoung-cha83.workers.dev';
const SYNC_DEBOUNCE_MS = 800;
const IMG_MAX = 1200;   // 업로드 이미지 다운스케일 최대 변

let state = { books: [] };
let curId = null;        // 열려 있는 책 id
let editId = null;       // 다이얼로그 수정 대상(없으면 추가)
let saveTimer = null;    // 텍스트 입력 → localStorage 디바운스
let _syncTimer = null, _syncCtrl = null;

// ── 저장/로드 + 서버 동기화 ──────────────────
function load() {
  try { const raw = localStorage.getItem(STORE); if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.books)) state = migrate(d); } } catch (e) {}
}
function cacheLocal() { try { localStorage.setItem(STORE, JSON.stringify(state)); return true; } catch (e) { return false; } }
// 저장: 로컬 캐시 + (토큰 있으면) 서버 동기화 예약. 로컬 저장 성공 여부 반환.
function save() { const ok = cacheLocal(); scheduleSync(); return ok; }

function getEditToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
function setSyncStatus(s) {
  const el = document.getElementById('syncStatus'); if (!el) return;
  const map = { saving: '동기화중…', saved: '동기화됨 ✓', error: '오프라인', readonly: '로컬 전용', '': '' };
  el.textContent = map[s] ?? ''; el.className = 'sync-status ' + (s || '');
}
function updateLockUI() {
  const b = document.getElementById('btnLock'); if (!b) return;
  const has = !!getEditToken();
  b.textContent = has ? '🔓' : '🔒';
  b.title = has ? '동기화 켜짐 (탭하여 변경/해제)' : '동기화 잠금 — 탭하여 비밀번호 입력';
}
function migrate(d) {
  const books = (d && Array.isArray(d.books) ? d.books : []).map(b => ({
    id: b.id || genId(),
    title: String(b.title || ''), author: String(b.author || ''),
    created_at: b.created_at || new Date().toISOString(),
    toc: String(b.toc || ''), content: String(b.content || ''),
    summary: String(b.summary || ''), memo: String(b.memo || ''),
    images: Array.isArray(b.images) ? b.images.filter(x => typeof x === 'string') : [],
  }));
  return { version: 1, books };
}
async function fetchFromServer() {
  try {
    const res = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = await res.json();
    if (j && Array.isArray(j.books)) return j;
  } catch (e) {}
  return null;
}
function scheduleSync() {
  if (!getEditToken()) { setSyncStatus('readonly'); return; }
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(pushToServer, SYNC_DEBOUNCE_MS);
}
async function pushToServer() {
  const token = getEditToken(); if (!token) return;
  if (_syncCtrl) _syncCtrl.abort();
  _syncCtrl = new AbortController();
  setSyncStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify(state), signal: _syncCtrl.signal,
    });
    if (res.ok) setSyncStatus('saved');
    else if (res.status === 401) { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} updateLockUI(); setSyncStatus('error'); alert('편집 비밀번호가 잘못됐습니다 — 다시 입력하세요.'); }
    else if (res.status === 413) { setSyncStatus('error'); alert('데이터가 너무 커서 동기화할 수 없어요(그림 용량). 그림 수를 줄여 주세요.'); }
    else setSyncStatus('error');
  } catch (e) { if (e.name !== 'AbortError') setSyncStatus('error'); }
}
function promptEditToken() {
  const cur = getEditToken();
  const v = prompt(cur ? '동기화 비밀번호 (지우고 확인 시 잠금)' : '동기화 비밀번호를 입력하세요', cur);
  if (v === null) return;
  try { if (v.trim()) localStorage.setItem(TOKEN_KEY, v.trim()); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  updateLockUI();
  if (getEditToken()) pushToServer(); else setSyncStatus('readonly');
}
// 시작 시 서버에서 불러오기(있으면 채택, 서버가 비었고 로컬이 있으면 업로드)
async function syncInitial() {
  setSyncStatus(getEditToken() ? 'saved' : 'readonly');
  const remote = await fetchFromServer();
  if (remote && remote.books.length > 0) {
    state = migrate(remote); cacheLocal();
    if (curId && !bookById(curId)) backHome();
    else if (curId) openBook(curId);
    else renderHome();
    setSyncStatus(getEditToken() ? 'saved' : 'readonly');
  } else if (remote) {                 // 서버 비어 있음
    if (getEditToken() && state.books.length) pushToServer();
    else setSyncStatus(getEditToken() ? 'saved' : 'readonly');
  } else {                             // 오프라인/오류 → 로컬 유지
    setSyncStatus('error');
  }
}
function flashSaved() {
  const h = document.getElementById('saveHint');
  h.classList.add('show'); clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => h.classList.remove('show'), 900);
}
function genId() { return 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function bookById(id) { return state.books.find(b => b.id === id); }

// ── 홈: 그리드 ───────────────────────────────
function renderHome() {
  const grid = document.getElementById('grid');
  const add = `<button class="tile add" id="tileAdd" aria-label="책 추가"><span class="plus">＋</span><span class="add-label">책 추가</span></button>`;
  const cards = state.books.map(b => `
    <button class="tile book" data-id="${b.id}">
      <span class="cover">📖</span>
      <span class="b-title">${esc(b.title || '(제목 없음)')}</span>
      <span class="b-author">${esc(b.author || '')}</span>
    </button>`).join('');
  grid.innerHTML = add + cards;
  document.getElementById('bookCount').textContent = state.books.length ? `${state.books.length}권` : '';
  document.getElementById('tileAdd').onclick = () => openDialog(null);
  grid.querySelectorAll('.tile.book').forEach(t => t.onclick = () => openBook(t.dataset.id));
}

// ── 책 추가/수정 다이얼로그 ──────────────────
function openDialog(id) {
  editId = id;
  const b = id ? bookById(id) : null;
  document.getElementById('dialogTitle').textContent = id ? '책 정보 수정' : '책 추가';
  document.getElementById('fBookTitle').value = b ? (b.title || '') : '';
  document.getElementById('fBookAuthor').value = b ? (b.author || '') : '';
  document.getElementById('bookDialog').showModal();
  setTimeout(() => document.getElementById('fBookTitle').focus(), 50);
}
function saveDialog() {
  const title = document.getElementById('fBookTitle').value.trim();
  const author = document.getElementById('fBookAuthor').value.trim();
  if (!title) { document.getElementById('fBookTitle').focus(); return; }
  if (editId) {
    const b = bookById(editId); if (b) { b.title = title; b.author = author; }
  } else {
    state.books.unshift({ id: genId(), title, author, created_at: new Date().toISOString(),
      toc: '', content: '', summary: '', memo: '', images: [] });
  }
  save();
  document.getElementById('bookDialog').close();
  if (curId) { renderDetailHeader(); } else { renderHome(); }
}

// ── 상세: 4탭 ────────────────────────────────
function openBook(id) {
  curId = id;
  const b = bookById(id); if (!b) return;
  renderDetailHeader();
  setEditorHTML('fToc', b.toc);
  setEditorHTML('fContent', b.content);
  setEditorHTML('fSummary', b.summary);
  setEditorHTML('fMemo', b.memo);
  renderImages();
  setTab('toc');
  document.getElementById('homeView').classList.add('hidden');
  document.getElementById('bookView').classList.remove('hidden');
  document.querySelector('.detail-main').scrollTop = 0;
}
function renderDetailHeader() {
  const b = bookById(curId); if (!b) return;
  document.getElementById('dTitle').textContent = b.title || '(제목 없음)';
  document.getElementById('dAuthor').textContent = b.author || '';
}
function setTab(tab) {
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const map = { toc: 'panelToc', content: 'panelContent', summary: 'panelSummary', memo: 'panelMemo' };
  Object.entries(map).forEach(([k, id]) => document.getElementById(id).classList.toggle('hidden', k !== tab));
}
function backHome() {
  curId = null;
  document.getElementById('bookView').classList.add('hidden');
  document.getElementById('homeView').classList.remove('hidden');
  renderHome();
}

// 저장된 값 → 편집기 HTML. 옛 평문(태그 없음)은 이스케이프+줄바꿈 변환.
function setEditorHTML(id, val) {
  const el = document.getElementById(id);
  val = val || '';
  if (/[<][a-zA-Z/]/.test(val)) el.innerHTML = val;               // 이미 서식(HTML)
  else el.innerHTML = esc(val).replace(/\n/g, '<br>');            // 평문 마이그레이션
}
// 편집 내용 자동 저장(디바운스) — contenteditable 은 innerHTML 저장
function onFieldInput(e) {
  const b = bookById(curId); if (!b) return;
  const el = e.currentTarget;
  b[el.dataset.field] = el.innerHTML;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { save(); flashSaved(); }, 400);
}
function saveActiveField() {
  const ed = activeEditor(); if (!ed) return;
  const b = bookById(curId); if (!b) return;
  b[ed.dataset.field] = ed.innerHTML;
  save(); flashSaved();
}

// ── 서식 툴바 ────────────────────────────────
let fmtScope = 'sel';   // 'sel' 선택영역 / 'all' 전체
let savedRange = null;  // 편집기 안의 마지막 선택(버튼 탭으로 포커스 잃어도 복원)
function activeEditor() {
  for (const id of ['panelToc', 'panelContent', 'panelSummary', 'panelMemo']) {
    const p = document.getElementById(id);
    if (p && !p.classList.contains('hidden')) return p.querySelector('.edit');
  }
  return null;
}
function selectAllIn(ed) {
  const r = document.createRange(); r.selectNodeContents(ed);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
// 선택을 유지한 채 명령 실행. scope='all'이면 전체 선택, 'sel'이면 마지막 선택 복원.
function withScope(run) {
  const ed = activeEditor(); if (!ed) return;
  ed.focus();
  const s = window.getSelection();
  if (fmtScope === 'all') selectAllIn(ed);
  else if (savedRange && ed.contains(savedRange.commonAncestorContainer)) { s.removeAllRanges(); s.addRange(savedRange); }
  try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
  run();
  saveActiveField();
}
function fmtAlign(cmd) { withScope(() => document.execCommand(cmd)); }
function fmtSize(sz) { withScope(() => document.execCommand('fontSize', false, sz)); }
function fmtColor(c) { withScope(() => document.execCommand('foreColor', false, c)); }

// ── 내용 탭: 그림/그래프 ─────────────────────
function renderImages() {
  const b = bookById(curId); if (!b) return;
  const box = document.getElementById('imgGrid');
  box.innerHTML = (b.images || []).map((src, i) => `
    <div class="img-item">
      <img src="${src}" data-i="${i}" alt="그림 ${i + 1}" />
      <button class="img-del" data-i="${i}" aria-label="삭제">✕</button>
    </div>`).join('');
  box.querySelectorAll('img').forEach(im => im.onclick = () => openLightbox(im.src));
  box.querySelectorAll('.img-del').forEach(btn => btn.onclick = () => {
    if (!confirm('이 그림을 삭제할까요?')) return;
    b.images.splice(+btn.dataset.i, 1); save(); renderImages(); flashSaved();
  });
}
function addImageFiles(fileEl) {
  const files = Array.from(fileEl.files || []); fileEl.value = '';
  if (!files.length) return;
  const b = bookById(curId); if (!b) return;
  b.images = b.images || [];
  let done = 0, full = false;
  const next = () => {
    if (done >= files.length) { if (!save()) { alert('저장 공간이 부족해요. 그림 수를 줄여 주세요.'); } if (full) alert('일부 그림은 용량 때문에 추가하지 못했어요.'); renderImages(); flashSaved(); return; }
    downscale(files[done], (durl) => { if (durl) b.images.push(durl); else full = true; done++; next(); });
  };
  next();
}
function downscale(file, cb) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    let w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, IMG_MAX / Math.max(w, h));
    w = Math.max(1, Math.round(w * s)); h = Math.max(1, Math.round(h * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    let durl = ''; try { durl = c.toDataURL('image/jpeg', 0.85); } catch (e) {}
    cb(durl || null);
  };
  img.onerror = () => { URL.revokeObjectURL(url); cb(null); };
  img.src = url;
}
function openLightbox(src) {
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}

// ── 초기화 ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  load();
  renderHome();
  updateLockUI();
  document.getElementById('btnLock').onclick = promptEditToken;
  syncInitial();   // 서버에서 최신 목록 받아오기(비동기)
  document.getElementById('btnBack').onclick = backHome;
  document.getElementById('btnDelete').onclick = () => {
    const b = bookById(curId); if (!b) return;
    if (!confirm(`'${b.title}'을(를) 삭제할까요? 되돌릴 수 없어요.`)) return;
    state.books = state.books.filter(x => x.id !== curId); save(); backHome();
  };
  document.getElementById('btnEditInfo').onclick = () => openDialog(curId);
  document.querySelectorAll('#tabs .tab').forEach(t => t.onclick = () => setTab(t.dataset.tab));
  document.querySelectorAll('.edit').forEach(t => t.addEventListener('input', onFieldInput));

  // ── 서식 툴바 배선 ──
  // 편집기 안 선택을 계속 기억(버튼 탭으로 포커스가 옮겨가도 복원용)
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection(); if (!s.rangeCount) return;
    const ed = activeEditor();
    if (ed && ed.contains(s.anchorNode) && ed.contains(s.focusNode)) savedRange = s.getRangeAt(0).cloneRange();
  });
  document.querySelectorAll('#fmtScope button').forEach(btn => btn.onclick = () => {
    fmtScope = btn.dataset.scope;
    document.querySelectorAll('#fmtScope button').forEach(b => b.classList.toggle('on', b === btn));
  });
  // 버튼은 pointerdown+preventDefault 로 편집기 선택을 뺏지 않음
  const bindFmt = (sel, fn) => document.querySelectorAll(sel).forEach(btn =>
    btn.addEventListener('pointerdown', e => { e.preventDefault(); fn(btn); }));
  bindFmt('#fmtBar [data-cmd]', btn => fmtAlign(btn.dataset.cmd));
  bindFmt('#fmtBar [data-size]', btn => fmtSize(btn.dataset.size));
  bindFmt('#fmtColors [data-color]', btn => fmtColor(btn.dataset.color));
  const cp = document.getElementById('fmtColorPick');
  cp.addEventListener('input', () => fmtColor(cp.value));
  document.getElementById('dialogSave').onclick = saveDialog;
  document.getElementById('dialogCancel').onclick = () => document.getElementById('bookDialog').close();
  document.getElementById('fBookTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveDialog(); } });
  document.getElementById('btnAddImg').onclick = () => document.getElementById('imgFile').click();
  document.getElementById('imgFile').onchange = e => addImageFiles(e.target);
  document.getElementById('lightbox').onclick = () => document.getElementById('lightbox').classList.add('hidden');
});
