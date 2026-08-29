// 도서모음 — 기기(localStorage) 저장 정적 앱. 책 그리드 + 4탭(목차/내용/원본/메모).
'use strict';
const STORE = 'doso-books-v1';
const LAST_KEY = 'doso-last';   // 마지막 읽던 위치(책/탭/스크롤/커서)
const TOKEN_KEY = 'doso-edit-token';
const BACKUP_KEY = 'doso-books-backup';   // 병합에서 밀려난 로컬본 보관(같은 책을 양쪽에서 고친 경우)
const MARK_KEY = 'doso-marks';            // 책갈피 {책id: {tab, idx, ratio, at}} — 이 기기에만 둔다
// 화면 상단에 띄우는 버전. 배포할 때 sw.js 의 CACHE 이름, index.html 의 ?v= 와 같이 올린다.
// (폰에서 "지금 새 버전이 맞나" 를 눈으로 확인하려고 띄운다)
const APP_VER = 'v14';
const API_BASE = 'https://book-collection-api.junyoung-cha83.workers.dev';
const SYNC_DEBOUNCE_MS = 800;
const IMG_MAX = 1200;   // 업로드 이미지 다운스케일 최대 변

let state = { books: [] };
let curId = null;        // 열려 있는 책 id
let curTab = 'toc';      // 현재 탭
let editId = null;       // 다이얼로그 수정 대상(없으면 추가)
let saveTimer = null;    // 텍스트 입력 → localStorage 디바운스
let _syncTimer = null, _syncCtrl = null;
let editMode = false;    // 편집 모드(끄면 읽기 전용) — 비밀번호와 별개, 저장하지 않는다
let _baseline = {};      // bookId → 마지막 동기화 시점의 내용 지문(바뀐 책 찾기용)
let _pulling = false;    // 서버에서 받아오는 중(중복 요청 방지)
let _lastTimer = null;
let lastRange = null;    // 편집기 안 마지막 커서 위치(접힌 선택 포함) — 삽입 지점
let selFigure = null;    // 선택된 본문 그림(figure.fig)
let curTable = null, curCell = null;   // 커서가 놓인 표/칸
let imgTarget = 'inline';              // 그림 파일 선택 용도: 'inline'(본문) | 'gallery'(보관함)

// ── 저장/로드 + 서버 동기화 ──────────────────
// 폰·맥북을 오가며 쓰므로 한쪽 수정이 다른 쪽 수정을 통째로 덮으면 안 된다. 그래서
//   · 책마다 updated_at 을 두고, 합칠 때 책 단위로 최신 것을 고른다
//   · 삭제는 목록에서 빼지 않고 deleted 표시만 남긴다 — 안 그러면 다른 기기에서 되살아난다
//   · 서버는 rev 를 세고, 내가 받아간 rev 가 아니면 PUT 을 거절한다(409) → 합치고 다시 올린다
function load() {
  try { const raw = localStorage.getItem(STORE); if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.books)) state = migrate(d); } } catch (e) {}
  resetBaseline();
}
function cacheLocal() { try { localStorage.setItem(STORE, JSON.stringify(state)); return true; } catch (e) { return false; } }
// 저장: 바뀐 책에 시각 도장 → 로컬 캐시 → (토큰 있으면) 서버 동기화 예약
function save() { stampChanges(); const ok = cacheLocal(); scheduleSync(); return ok; }

// 어떤 책이 바뀌었는지 알아야 updated_at 을 찍는다. save() 를 부르는 자리가 스무 곳이
// 넘어서 일일이 손대는 대신, 마지막 동기화 시점의 지문과 비교해 바뀐 책만 찍는다.
function bookSig(b) { return JSON.stringify([b.title, b.author, b.toc, b.content, b.original, b.memo, b.images, !!b.deleted]); }
function resetBaseline() { _baseline = {}; for (const b of state.books) _baseline[b.id] = bookSig(b); }
function stampChanges() {
  const now = new Date().toISOString();
  for (const b of state.books) {
    const sig = bookSig(b);
    if (_baseline[b.id] !== sig) { b.updated_at = now; _baseline[b.id] = sig; }
  }
}

function getEditToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
function setSyncStatus(s) {
  const el = document.getElementById('syncStatus'); if (!el) return;
  const map = { saving: '동기화중…', saved: '동기화됨 ✓', error: '오프라인', readonly: '로컬 전용', '': '' };
  el.textContent = map[s] ?? ''; el.className = 'sync-status ' + (s || '');
}
// 편집 권한(비밀번호)과 편집 '모드' 는 다르다.
// 비밀번호는 한 번 넣으면 남지만, 모드는 평소 꺼져 있어야 읽다가 실수로 지우지 않는다.
// 모드는 저장하지 않는다 — 앱을 새로 열거나 책을 옮기면 항상 읽기부터 시작한다.
function hasEditRight() { return !!getEditToken(); }
function canEdit() { return hasEditRight() && editMode; }
function setEditMode(on) {
  editMode = !!on && hasEditRight();
  document.body.classList.toggle('editing', editMode);
  updateEditModeUI();
  applyEditability();
}
function updateEditModeUI() {
  const right = hasEditRight();
  document.querySelectorAll('.btn-editmode').forEach(b => {
    b.hidden = !right;                       // 비밀번호가 없으면 자물쇠부터 눌러야 한다
    b.textContent = editMode ? '✅ 완료' : '📝 편집';
    b.title = editMode ? '편집 끝내기 — 읽기 모드로' : '편집하기 — 눌러야 글을 고칠 수 있어요';
    b.setAttribute('aria-pressed', editMode ? 'true' : 'false');
    b.classList.toggle('on', editMode);
  });
}
// 실제로 고칠 수 있는 상태(비밀번호 O + 편집 모드 O)일 때만 편집기·편집 버튼을 켠다.
function applyEditability() {
  const on = canEdit();
  document.body.classList.toggle('readonly', !on);
  document.querySelectorAll('.edit').forEach(e => e.setAttribute('contenteditable', on ? 'true' : 'false'));
  // 삽화 캡션은 figure(contenteditable=false) 안에 있어 따로 꺼 줘야 한다
  document.querySelectorAll('.edit figcaption').forEach(c => c.setAttribute('contenteditable', on ? 'true' : 'false'));
  if (!on) { selFigure = curTable = curCell = null; renderNodeBar(); }
}
function updateLockUI() {
  const b = document.getElementById('btnLock'); if (!b) return;
  const has = hasEditRight();          // 자물쇠는 '권한' 을 나타낸다(편집 모드와 별개)
  b.textContent = has ? '🔓' : '🔒';
  b.title = has ? '편집 권한 있음 · 동기화 (탭하여 잠금)' : '읽기전용 — 탭하여 비밀번호 입력';
  updateEditModeUI();
  applyEditability();
}
function migrate(d) {
  const books = (d && Array.isArray(d.books) ? d.books : []).map(b => ({
    id: b.id || genId(),
    title: String(b.title || ''), author: String(b.author || ''),
    created_at: b.created_at || new Date().toISOString(),
    // 예전 데이터엔 updated_at 이 없다 — 만든 시각으로 채워야 합칠 때 기준이 생긴다
    updated_at: b.updated_at || b.created_at || new Date(0).toISOString(),
    deleted: !!b.deleted,                                              // 삭제 표시(목록에선 감춘다)
    toc: String(b.toc || ''), content: String(b.content || ''),
    original: String(b.original || ''),                                // 원본(텍스트 전용)
    memo: String(b.memo || ''),
    images: Array.isArray(b.images) ? b.images.filter(x => typeof x === 'string') : [],
  }));
  return { version: 1, rev: Number(d && d.rev) || 0, books };
}

// 로컬과 서버를 책 단위로 합친다. 같은 책은 updated_at 이 나중인 쪽을 택한다.
// 밀려난 로컬본 중 '아직 서버에 못 올린 수정' 이 있으면 losers 에 담아 따로 보관한다.
function mergeDocs(local, remote, losers) {
  const byId = new Map(local.books.map(b => [b.id, b]));
  for (const r of remote.books) {
    const l = byId.get(r.id);
    if (!l) { byId.set(r.id, r); continue; }
    if ((Date.parse(r.updated_at) || 0) > (Date.parse(l.updated_at) || 0)) {
      if (losers && _baseline[l.id] !== undefined && _baseline[l.id] !== bookSig(l)) losers.push(l);
      byId.set(r.id, r);
    }
  }
  // 새로 만든 책은 앞으로(홈에서 맨 앞에 보이게), 나머지는 서버 순서를 따른다
  const remoteIds = new Set(remote.books.map(b => b.id));
  const order = [...local.books.filter(b => !remoteIds.has(b.id)).map(b => b.id), ...remote.books.map(b => b.id)];
  const seen = new Set(), books = [];
  for (const id of order) { if (seen.has(id)) continue; seen.add(id); books.push(byId.get(id)); }
  return { version: 1, rev: remote.rev | 0, books };
}

// 밀려난 로컬본 보관 — 같은 책을 양쪽에서 고친 경우에만 생긴다.
// 반드시 cacheLocal() 뒤에 불러야 한다(용량이 차서 본 데이터 저장이 실패하면 안 되므로).
function stashLosers(losers) {
  if (!losers || !losers.length) return;
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: new Date().toISOString(), books: losers.slice(0, 2) }));
  } catch (e) { try { localStorage.removeItem(BACKUP_KEY); } catch (_) {} }
  const names = losers.map(b => b.title || '(제목 없음)').join(', ');
  alert(`다른 기기에서 더 나중에 고친 내용이 있어 그쪽을 반영했습니다: ${names}\n\n이 기기에 있던 내용은 따로 보관해 뒀습니다(복구 필요하면 알려주세요).`);
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

// 서버 문서를 로컬에 합쳐 넣고, 내용이 바뀐 책 id 들을 돌려준다.
function adoptMerge(remoteDoc) {
  const before = new Map(state.books.map(b => [b.id, bookSig(b)]));
  const losers = [];
  state = mergeDocs(state, migrate(remoteDoc), losers);
  cacheLocal(); resetBaseline(); stashLosers(losers);
  const changed = new Set();
  for (const b of state.books) if (before.get(b.id) !== bookSig(b)) changed.add(b.id);
  return changed;
}

// 보고 있던 책이 안 바뀌었으면 건드리지 않는다 — 괜히 다시 그리면 읽던 위치가 튄다.
// 바뀐 경우에도 openBook() 대신 내용만 갈아끼워 탭과 스크롤은 지킨다.
function rerenderAfterSync(changed) {
  if (!curId) { renderHome(); return; }
  if (!bookById(curId)) { backHome(); return; }          // 다른 기기에서 지운 책
  if (changed && !changed.has(curId)) { renderDetailHeader(); return; }
  const b = bookById(curId), y = window.scrollY || 0;
  renderDetailHeader();
  setEditorHTML('fToc', b.toc); setEditorHTML('fContent', b.content);
  setEditorHTML('fOriginal', b.original);
  setEditorHTML('fMemo', b.memo);
  renderImages(); applyEditability();
  requestAnimationFrame(() => window.scrollTo(0, y));
}

// 새로고침 버튼 — 자동 동기화를 못 믿을 때 손으로 당겨 받는다.
// 사용자가 일부러 누른 것이므로 편집 중이어도 받아온다(내 수정은 updated_at 이 최신이라 살아남는다).
async function manualRefresh() {
  const b = document.getElementById('btnRefresh');
  if (b) { b.disabled = true; b.classList.add('spin'); }
  setSyncStatus('saving');
  try { await pullAndMerge(true); }
  finally { if (b) { b.disabled = false; b.classList.remove('spin'); } }
}

// 서버에서 받아와 합치기. 편집 중일 때는 건드리지 않는다(입력하던 내용이 튄다).
async function pullAndMerge(force) {
  if (_pulling) return;
  if (!force) {
    const ed = document.activeElement;
    if (ed && ed.classList && ed.classList.contains('edit')) return;
  }
  _pulling = true;
  try {
    const remote = await fetchFromServer();
    if (!remote) { setSyncStatus('error'); return; }
    const changed = adoptMerge(remote);
    if (changed.size) rerenderAfterSync(changed);
    // 합친 결과가 서버와 다르면(이 기기에만 있던 수정) 올려 준다
    if (getEditToken() && JSON.stringify(state.books) !== JSON.stringify(migrate(remote).books)) pushToServer();
    else setSyncStatus(getEditToken() ? 'saved' : 'readonly');
  } finally { _pulling = false; }
}
function scheduleSync() {
  if (!getEditToken()) { setSyncStatus('readonly'); return; }
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => pushToServer(), SYNC_DEBOUNCE_MS);
}
// 내가 받아간 rev 를 같이 보낸다. 그 사이 다른 기기가 저장했으면 서버가 409 로
// 거절하고 최신본을 돌려준다 → 합쳐서 한 번만 다시 시도한다.
async function pushToServer(retry = true) {
  const token = getEditToken(); if (!token) return;
  if (_syncCtrl) _syncCtrl.abort();
  _syncCtrl = new AbortController();
  setSyncStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token, 'X-Base-Rev': String(state.rev | 0) },
      body: JSON.stringify(state), signal: _syncCtrl.signal,
    });
    if (res.ok) {
      const j = await res.json().catch(() => null);
      if (j && typeof j.rev === 'number') { state.rev = j.rev; cacheLocal(); }
      setSyncStatus('saved');
    }
    else if (res.status === 409) {
      const j = await res.json().catch(() => null);
      if (j && j.current) { const ch = adoptMerge(j.current); if (ch.size) rerenderAfterSync(ch); }
      if (retry) return pushToServer(false);
      setSyncStatus('error');
    }
    else if (res.status === 401) { try { localStorage.removeItem(TOKEN_KEY); } catch (e) {} updateLockUI(); setSyncStatus('error'); alert('편집 비밀번호가 잘못됐습니다 — 다시 입력하세요.'); }
    else if (res.status === 413) { setSyncStatus('error'); alert('데이터가 너무 커서 동기화할 수 없어요(그림 용량). 그림 수를 줄여 주세요.'); }
    else setSyncStatus('error');
  } catch (e) { if (e.name !== 'AbortError') setSyncStatus('error'); }
}
function promptEditToken() {
  const cur = getEditToken();
  const v = prompt(cur ? '편집 비밀번호 (지우고 확인 시 읽기전용)' : '편집 비밀번호를 입력하세요 (읽기전용 해제)', cur);
  if (v === null) return;
  try { if (v.trim()) localStorage.setItem(TOKEN_KEY, v.trim()); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  setEditMode(false);          // 비밀번호를 바꿔도 편집은 꺼진 채로 시작한다
  updateLockUI();
  if (!document.getElementById('homeView').classList.contains('hidden')) renderHome();   // 홈 힌트·＋타일 갱신
  if (getEditToken()) pushToServer(); else setSyncStatus('readonly');
}
// 시작 시 서버와 맞추기. 이때는 편집기에 포커스가 있어도(읽던 위치 복원 직후)
// 건너뛰면 안 되므로 force 로 부른다.
async function syncInitial() {
  setSyncStatus(getEditToken() ? 'saved' : 'readonly');
  await pullAndMerge(true);
}
function flashSaved() {
  const h = document.getElementById('saveHint');
  h.classList.add('show'); clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => h.classList.remove('show'), 900);
}
function genId() { return 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
// 지운 책은 목록에서 빼지 않고 표시만 남기므로(다른 기기에서 되살아나지 않게)
// 화면에 쓰는 곳에서는 항상 걸러 낸다.
function liveBooks() { return state.books.filter(b => !b.deleted); }
function bookById(id) { const b = state.books.find(x => x.id === id); return b && !b.deleted ? b : undefined; }

// ── 홈: 그리드 ───────────────────────────────
function renderHome() {
  const grid = document.getElementById('grid');
  const add = `<button class="tile add" id="tileAdd" aria-label="책 추가"><span class="plus">＋</span><span class="add-label">책 추가</span></button>`;
  const live = liveBooks();
  const cards = live.map(b => `
    <button class="tile book" data-id="${b.id}">
      <span class="cover">📖</span>
      <span class="b-title">${esc(b.title || '(제목 없음)')}</span>
      <span class="b-author">${esc(b.author || '')}</span>
    </button>`).join('');
  const emptyHint = (!live.length && !hasEditRight())
    ? `<div class="ro-hint">🔒 읽기전용입니다.<br>오른쪽 위 자물쇠를 눌러 비밀번호를 입력하면 편집할 수 있어요.</div>` : '';
  grid.innerHTML = add + cards + emptyHint;
  document.getElementById('bookCount').textContent = live.length ? `${live.length}권` : '';
  const ta = document.getElementById('tileAdd'); if (ta) ta.onclick = () => openDialog(null);
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
    const now = new Date().toISOString();
    state.books.unshift({ id: genId(), title, author, created_at: now, updated_at: now, deleted: false,
      toc: '', content: '', original: '', memo: '', images: [] });
  }
  save();
  document.getElementById('bookDialog').close();
  if (curId) { renderDetailHeader(); } else { renderHome(); }
}

// ── 상세: 4탭 ────────────────────────────────
function openBook(id) {
  curId = id;
  const b = bookById(id); if (!b) return;
  setEditMode(false);          // 책을 열면 항상 읽기부터 — 실수로 고치는 걸 막는다
  renderDetailHeader();
  setEditorHTML('fToc', b.toc);
  setEditorHTML('fContent', b.content);
  setEditorHTML('fOriginal', b.original);
  setEditorHTML('fMemo', b.memo);
  renderImages();
  setTab('toc');
  applyEditability();
  document.getElementById('homeView').classList.add('hidden');
  document.getElementById('bookView').classList.remove('hidden');
  window.scrollTo(0, 0);
  renderMarkFab();
  gotoMark(id);          // 책갈피가 있으면 그 자리로 (탭도 그때 맞춰진다)
}
function renderDetailHeader() {
  const b = bookById(curId); if (!b) return;
  document.getElementById('dTitle').textContent = b.title || '(제목 없음)';
  document.getElementById('dAuthor').textContent = b.author || '';
}
const TAB_PANEL = { toc: 'panelToc', content: 'panelContent', original: 'panelOriginal', memo: 'panelMemo' };
function setTab(tab) {
  // 없어진 탭이 들어오면(마지막 위치·책갈피에 남은 '내용요약') 모든 패널이 숨어
  // 화면이 비어 버린다. 그런 값은 목차로 되돌린다.
  if (!TAB_PANEL[tab]) tab = 'toc';
  curTab = tab;
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  Object.entries(TAB_PANEL).forEach(([k, id]) => document.getElementById(id).classList.toggle('hidden', k !== tab));
  // 원본은 텍스트 전용 — 그림·표 삽입 버튼을 감춘다
  document.querySelector('#fmtScope .ins-group').classList.toggle('hidden', tab === 'original');
  selFigure = curTable = curCell = null; lastRange = null; renderNodeBar();
  saveLast();
}
function backHome() {
  curId = null;
  setEditMode(false);
  selFigure = curTable = curCell = null; lastRange = savedRange = null; renderNodeBar();
  document.getElementById('bookView').classList.add('hidden');
  document.getElementById('homeView').classList.remove('hidden');
  renderMarkFab();
  renderHome();
  try { localStorage.removeItem(LAST_KEY); } catch (e) {}
}

// 첫 줄 들여쓰기 자동 — 각 블록/첫 줄에 적용, 공백으로 시작(이미 들여쓰기)한 줄은 skip.
function normalizeIndent(ed) {
  if (!ed) return;
  const lead = ed.firstChild;
  const leadText = lead && lead.nodeType === 3 ? lead.textContent : '';
  ed.style.textIndent = (lead && lead.nodeType === 3 && leadText && !/^[\s　]/.test(leadText)) ? '1em' : '';
  for (const ch of ed.children) {
    if (ch.tagName === 'DIV' || ch.tagName === 'P') {
      const t = ch.textContent || '';
      if (t && !/^[\s　]/.test(t) && ch.innerHTML !== '<br>') ch.classList.add('ind');
      else ch.classList.remove('ind');
    }
  }
}
// 저장된 값 → 편집기 HTML. 옛 평문(태그 없음)은 이스케이프+줄바꿈 변환.
function setEditorHTML(id, val) {
  const el = document.getElementById(id);
  val = val || '';
  if (/[<][a-zA-Z/]/.test(val)) el.innerHTML = val;               // 이미 서식(HTML)
  else el.innerHTML = esc(val).replace(/\n/g, '<br>');            // 평문 마이그레이션
  normalizeIndent(el);
}
// 편집 내용 자동 저장(디바운스) — contenteditable 은 innerHTML 저장
function onFieldInput(e) {
  const b = bookById(curId); if (!b) return;
  const el = e.currentTarget;
  normalizeIndent(el);
  b[el.dataset.field] = el.innerHTML;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { save(); flashSaved(); }, 400);
  saveLast();
}

// ── 원본 탭(텍스트 전용) ────────────────────
// 평문 → 줄 단위 <div>. 빈 줄도 한 줄로 살리고, 줄 앞 들여쓰기는 &nbsp; 로 지킨다.
function plainToHtml(t) {
  const keepLead = s => s.replace(/^[ \t]+/, m => '&nbsp;'.repeat(m.replace(/\t/g, '    ').length));
  return String(t).replace(/\r\n?/g, '\n').split('\n')
    .map(l => l ? `<div>${keepLead(esc(l))}</div>` : '<div><br></div>').join('');
}
// 커서 자리에 서식 없이 글자만 넣기(붙여넣기용)
function insertPlainText(ed, txt) {
  const t = String(txt).replace(/\r\n?/g, '\n');
  let ok = false;
  try { ok = document.execCommand('insertText', false, t); } catch (e) {}
  if (!ok) {
    const s = window.getSelection();
    const frag = document.createRange().createContextualFragment(plainToHtml(t));
    if (s.rangeCount && ed.contains(s.getRangeAt(0).commonAncestorContainer)) {
      const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(frag); r.collapse(false);
    } else ed.appendChild(frag);
  }
  normalizeIndent(ed);
  const b = bookById(curId); if (b) { b[ed.dataset.field] = ed.innerHTML; }
  if (!save()) alert('저장 공간이 부족해요. 원본 글을 나눠서 넣어 주세요.');
  flashSaved();
}
// 한글 txt 는 UTF-8 이 아닐 때가 많다 → 실패하면 EUC-KR(CP949)로 다시 읽는다.
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) {
    try { return new TextDecoder('euc-kr').decode(buf); }
    catch (e2) { return new TextDecoder('utf-8').decode(buf); }
  }
}
function importTxt(file) {
  const ed = document.getElementById('fOriginal');
  const fr = new FileReader();
  fr.onerror = () => alert('파일을 읽지 못했어요.');
  fr.onload = () => {
    const t = decodeText(fr.result).replace(/^\uFEFF/, '');
    if (!t.trim()) { alert('글자가 없는 파일이에요.'); return; }
    const had = !!ed.textContent.trim();
    if (had && !confirm('원본 탭에 이미 글이 있어요.\n확인을 누르면 뒤에 이어 붙입니다.')) return;
    ed.innerHTML = had ? ed.innerHTML + plainToHtml('\n' + t) : plainToHtml(t);
    normalizeIndent(ed);
    const b = bookById(curId); if (b) b.original = ed.innerHTML;
    if (!save()) { alert('저장 공간이 부족해요. 글을 나눠서 넣어 주세요.'); return; }
    flashSaved();
    ed.scrollIntoView({ block: 'start' });
  };
  fr.readAsArrayBuffer(file);
}

// ── 마지막 읽던 위치(책/탭/스크롤/커서) ──────
function caretOffset(ed) {
  const s = window.getSelection(); if (!s.rangeCount) return -1;
  const r = s.getRangeAt(0); if (!ed.contains(r.startContainer)) return -1;
  const pre = r.cloneRange(); pre.selectNodeContents(ed); pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}
function setCaretOffset(ed, off) {
  if (off < 0) return;
  let n = off; const walk = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walk.nextNode())) {
    if (n <= node.textContent.length) { const r = document.createRange(); r.setStart(node, n); r.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return; }
    n -= node.textContent.length;
  }
}
function saveLast() {
  if (!curId) return;
  clearTimeout(_lastTimer);
  _lastTimer = setTimeout(() => {
    const ed = activeEditor();
    const data = { bookId: curId, tab: curTab, scrollY: window.scrollY || 0, caret: ed ? { field: ed.dataset.field, off: caretOffset(ed) } : null };
    try { localStorage.setItem(LAST_KEY, JSON.stringify(data)); } catch (e) {}
  }, 250);
}
function restoreLast() {
  let last; try { last = JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch (e) { last = null; }
  if (!last || !last.bookId || !bookById(last.bookId)) return;
  openBook(last.bookId);
  // 책갈피가 꽂혀 있으면 그쪽이 우선이다 — openBook 이 이미 그 자리로 옮겨 놨다
  if (markOf(last.bookId)) return;
  if (last.tab) setTab(last.tab);
  requestAnimationFrame(() => {
    window.scrollTo(0, last.scrollY || 0);
    if (last.caret && last.caret.off >= 0) {
      const ed = activeEditor();
      if (ed && ed.dataset.field === last.caret.field) { ed.focus(); setCaretOffset(ed, last.caret.off); }
    }
  });
}

// ── 책갈피 ───────────────────────────────────────────────────
// 책마다 한 자리를 기억해 두고, 해제하기 전까지 그 책을 열 때마다 그리로 간다.
// 자리는 픽셀이 아니라 '몇 번째 문단' 으로 저장한다 — 폰과 맥북은 화면 폭이 달라
// 픽셀 위치를 그대로 쓰면 엉뚱한 데로 간다. (문단이 없는 글은 비율로 대신한다.)
function marks() {
  try { const o = JSON.parse(localStorage.getItem(MARK_KEY) || '{}'); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}
function markOf(id) { const m = marks()[id]; return m && typeof m.idx === 'number' ? m : null; }
function writeMark(id, m) {
  const all = marks();
  if (m) all[id] = m; else delete all[id];
  try { localStorage.setItem(MARK_KEY, JSON.stringify(all)); } catch (e) {}
}
// 고정된 헤더·탭에 가려지는 높이 — 이 아래가 실제로 읽히는 영역이다
function stickyTop() {
  const t = document.getElementById('tabs');
  const r = t ? t.getBoundingClientRect() : null;
  return r && r.bottom > 0 ? r.bottom : 0;
}
// 지금 화면 맨 위에 걸려 있는 문단 번호
function topBlockIdx(ed) {
  if (!ed) return -1;
  const top = stickyTop() + 4, kids = ed.children;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].getBoundingClientRect().bottom > top) return i;
  }
  return kids.length ? kids.length - 1 : -1;
}
function setMarkHere() {
  if (!curId) return;
  const ed = activeEditor();
  const doc = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  writeMark(curId, {
    tab: curTab, idx: topBlockIdx(ed),
    ratio: (window.scrollY || 0) / doc,     // 문단을 못 찾을 때 쓸 예비값
    at: Date.now(),
  });
  renderMarkFab(); flashMark('책갈피를 꽂았어요');
}
function clearMark() {
  if (!curId) return;
  writeMark(curId, null);
  renderMarkFab(); flashMark('책갈피를 뺐어요');
}
// 책갈피 자리로 이동. 옮겼으면 true.
function gotoMark(id) {
  const m = markOf(id);
  if (!m) return false;
  if (m.tab) setTab(m.tab);
  // 내용이 화면에 배치된 뒤라야 위치를 잴 수 있다
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ed = activeEditor();
    const el = ed && m.idx >= 0 ? ed.children[m.idx] : null;
    if (el) {
      const y = window.scrollY + el.getBoundingClientRect().top - stickyTop() - 8;
      window.scrollTo(0, Math.max(0, y));
    } else if (typeof m.ratio === 'number') {
      const doc = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      window.scrollTo(0, Math.max(0, Math.round(m.ratio * doc)));
    }
  }));
  return true;
}
function renderMarkFab() {
  const fab = document.getElementById('markFab');
  if (!fab) return;
  const on = !!(curId && markOf(curId));
  fab.hidden = !curId;
  fab.classList.toggle('on', on);
  const set = document.getElementById('btnMarkSet');
  const clr = document.getElementById('btnMarkClear');
  if (set) set.textContent = on ? '🔖 여기로 옮기기' : '🔖 책갈피';
  if (clr) clr.hidden = !on;
}
function flashMark(msg) {
  const t = document.getElementById('markToast');
  if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(flashMark._t);
  flashMark._t = setTimeout(() => t.classList.remove('show'), 1200);
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
  for (const id of ['panelToc', 'panelContent', 'panelOriginal', 'panelMemo']) {
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
// 글자 음영(형광펜) — 고른 글자의 배경색. c='none' 이면 음영 지우기.
function fmtHilite(c) {
  withScope(() => {
    const v = (c === 'none') ? 'transparent' : c;
    if (!document.execCommand('hiliteColor', false, v)) document.execCommand('backColor', false, v);
    tidyHilite(activeEditor());
  });
}
// 지우기로 남은 'transparent' 배경과 알맹이 없는 span 을 걷어낸다.
function tidyHilite(ed) {
  if (!ed) return;
  ed.querySelectorAll('[style*="background"]').forEach(el => {
    const bg = el.style.backgroundColor;
    if (bg === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(bg)) el.style.backgroundColor = '';
    if (!el.getAttribute('style')) el.removeAttribute('style');
    if (el.tagName === 'SPAN' && !el.attributes.length) {          // 서식이 하나도 안 남은 껍데기
      const p = el.parentNode;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
    }
  });
  ed.normalize();
}

// ── 본문 삽입: 그림·표 ───────────────────────
// 커서가 놓인 최상위 블록(문단/표/그림)을 찾는다 — 삽입 기준점.
function topBlockOf(ed, node) {
  let n = node;
  while (n && n.parentNode && n.parentNode !== ed) n = n.parentNode;
  return (n && n.parentNode === ed) ? n : null;
}
// 현재 문단 바로 뒤에 블록(그림/표)을 넣고, 이어서 쓸 빈 줄을 만든다.
function insertBlock(el) {
  const ed = activeEditor(); if (!ed) return false;
  const r = (lastRange && ed.contains(lastRange.commonAncestorContainer)) ? lastRange : null;
  const anchor = r ? topBlockOf(ed, r.startContainer) : null;
  const tail = document.createElement('div'); tail.innerHTML = '<br>';
  if (anchor) { anchor.after(el); el.after(tail); }
  else { ed.appendChild(el); ed.appendChild(tail); }
  const nr = document.createRange(); nr.setStart(tail, 0); nr.collapse(true);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(nr);
  lastRange = nr.cloneRange();
  normalizeIndent(ed); saveActiveField();
  el.scrollIntoView({ block: 'nearest' });
  return true;
}
function makeFigure(src, size) {
  const fig = document.createElement('figure');
  fig.className = 'fig w-' + (size || 'md');
  fig.setAttribute('contenteditable', 'false');
  const img = document.createElement('img'); img.src = src; img.alt = '';
  const cap = document.createElement('figcaption');
  cap.setAttribute('contenteditable', 'true'); cap.setAttribute('data-ph', '설명(선택)');
  fig.append(img, cap);
  return fig;
}
function makeTable(rows, cols, header) {
  const wrap = document.createElement('div'); wrap.className = 'tbl-wrap';
  const t = document.createElement('table'); t.className = 'tbl';
  const tb = document.createElement('tbody');
  for (let r = 0; r < rows; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < cols; c++) {
      const cell = document.createElement(header && r === 0 ? 'th' : 'td');
      cell.innerHTML = '<br>';
      tr.appendChild(cell);
    }
    tb.appendChild(tr);
  }
  t.appendChild(tb); wrap.appendChild(t);
  return wrap;
}
function insertTableFromDialog() {
  const rows = Math.min(30, Math.max(1, parseInt(document.getElementById('fRows').value, 10) || 3));
  const cols = Math.min(10, Math.max(1, parseInt(document.getElementById('fCols').value, 10) || 3));
  const header = document.getElementById('fHeader').checked;
  const wrap = makeTable(rows, cols, header);
  document.getElementById('tableDialog').close();
  if (!insertBlock(wrap)) return;
  const first = wrap.querySelector('th,td');
  if (first) { const r = document.createRange(); r.setStart(first, 0); r.collapse(true);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); lastRange = r.cloneRange(); }
  refreshCtx(); flashSaved();
}
// 그림 파일 → 본문 커서 위치에 차례로 삽입
function insertImageFiles(files, size) {
  const list = Array.from(files || []); if (!list.length) return;
  let done = 0, full = false;
  const next = () => {
    if (done >= list.length) {
      if (full) alert('일부 그림은 용량 때문에 넣지 못했어요.');
      if (!save()) alert('저장 공간이 부족해요. 그림 수를 줄여 주세요.');
      flashSaved(); return;
    }
    downscale(list[done], durl => {
      if (durl) insertBlock(makeFigure(durl, size)); else full = true;
      done++; next();
    });
  };
  next();
}

// ── 선택한 그림/표 도구 ──────────────────────
function markCtx() {
  const ed = activeEditor(); if (!ed) return;
  ed.querySelectorAll('figure.fig.sel').forEach(f => f.classList.remove('sel'));
  ed.querySelectorAll('.cell-on').forEach(c => c.classList.remove('cell-on'));
  if (selFigure) selFigure.classList.add('sel');
  if (curCell) curCell.classList.add('cell-on');
}
// 현재 커서/클릭 위치가 그림 안인지 표 안인지 판단해 도구 막대를 갱신
function refreshCtx(clickTarget) {
  const ed = activeEditor();
  if (!ed || !canEdit()) { selFigure = curTable = curCell = null; renderNodeBar(); return; }
  let fig = null, cell = null;
  if (clickTarget && clickTarget.closest) {
    fig = clickTarget.closest('figure.fig');
    cell = clickTarget.closest('td,th');
    if (fig && !ed.contains(fig)) fig = null;
    if (cell && !ed.contains(cell)) cell = null;
  }
  if (!fig && !cell) {
    const s = window.getSelection();
    const a = s && s.anchorNode ? (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement) : null;
    // 그림(contenteditable=false)을 고르면 커서가 편집기 자체에 걸리기도 한다 → 선택 유지
    if (!clickTarget && selFigure && (a === ed || !a)) return;
    if (a && ed.contains(a)) { fig = a.closest('figure.fig'); cell = a.closest('td,th'); }
    else if (!clickTarget) return;                 // 편집기 밖 선택은 무시(도구 유지)
  }
  if (cell) { curCell = cell; curTable = cell.closest('table.tbl'); selFigure = null; }
  else { selFigure = fig || null; curTable = curCell = null; }
  markCtx(); renderNodeBar();
}
function renderNodeBar() {
  const bar = document.getElementById('nodeBar'); if (!bar) return;
  const lab = document.getElementById('nodeLabel'), acts = document.getElementById('nodeActs');
  const btn = (act, txt, on, cls) => `<button data-act="${act}" class="${on ? 'on' : ''} ${cls || ''}">${txt}</button>`;
  if (selFigure) {
    const w = ['sm', 'md', 'lg', 'full'].find(s => selFigure.classList.contains('w-' + s)) || 'md';
    const al = selFigure.classList.contains('f-left') ? 'left' : selFigure.classList.contains('f-right') ? 'right' : 'center';
    lab.textContent = '🖼️ 그림';
    acts.innerHTML =
      btn('size:sm', '작게', w === 'sm') + btn('size:md', '중간', w === 'md') +
      btn('size:lg', '크게', w === 'lg') + btn('size:full', '꽉', w === 'full') +
      btn('al:left', '◧ 글 왼쪽', al === 'left') + btn('al:center', '가운데', al === 'center') +
      btn('al:right', '글 오른쪽 ◨', al === 'right') +
      btn('fig:del', '🗑 삭제', false, 'danger');
    bar.classList.remove('hidden');
  } else if (curTable) {
    const isTh = !!(curTable.rows[0] && curTable.rows[0].cells[0] && curTable.rows[0].cells[0].tagName === 'TH');
    lab.textContent = '▦ 표';
    acts.innerHTML =
      btn('row:add', '＋행') + btn('row:del', '－행') +
      btn('col:add', '＋열') + btn('col:del', '－열') +
      btn('tbl:header', '제목행', isTh) +
      btn('tbl:del', '🗑 표 삭제', false, 'danger');
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden'); acts.innerHTML = ''; lab.textContent = '';
  }
}
function nodeAct(act) {
  const ed = activeEditor(); if (!ed) return;
  const [kind, val] = act.split(':');
  if (kind === 'size' && selFigure) {
    selFigure.classList.remove('w-sm', 'w-md', 'w-lg', 'w-full');
    selFigure.classList.add('w-' + val);
    if (val === 'full') selFigure.classList.remove('f-left', 'f-right');
  } else if (kind === 'al' && selFigure) {
    selFigure.classList.remove('f-left', 'f-right');
    if (val === 'left') selFigure.classList.add('f-left');
    if (val === 'right') selFigure.classList.add('f-right');
    if (val !== 'center' && selFigure.classList.contains('w-full')) {
      selFigure.classList.remove('w-full'); selFigure.classList.add('w-md');
    }
  } else if (kind === 'fig' && selFigure) {
    if (!confirm('이 그림을 본문에서 지울까요?')) return;
    selFigure.remove(); selFigure = null;
  } else if (kind === 'row' && curTable) {
    const tr = curCell ? curCell.parentNode : curTable.rows[curTable.rows.length - 1];
    if (val === 'add') {
      const nr = curTable.insertRow(tr.rowIndex + 1);
      for (let i = 0; i < tr.cells.length; i++) nr.insertCell().innerHTML = '<br>';
    } else {
      if (curTable.rows.length <= 1) { alert('마지막 행은 지울 수 없어요. 표 삭제를 눌러 주세요.'); return; }
      tr.remove(); curCell = null;
    }
  } else if (kind === 'col' && curTable) {
    const idx = curCell ? curCell.cellIndex : (curTable.rows[0].cells.length - 1);
    if (val === 'add') {
      for (const r of curTable.rows) {
        const c = document.createElement(r.cells[idx] ? r.cells[idx].tagName : 'TD');
        c.innerHTML = '<br>';
        r.insertBefore(c, r.cells[idx + 1] || null);
      }
    } else {
      if (curTable.rows[0].cells.length <= 1) { alert('마지막 열은 지울 수 없어요. 표 삭제를 눌러 주세요.'); return; }
      for (const r of curTable.rows) if (r.cells[idx]) r.deleteCell(idx);
      curCell = null;
    }
  } else if (kind === 'tbl' && curTable) {
    if (val === 'header') {
      const r0 = curTable.rows[0]; if (!r0) return;
      const to = r0.cells[0].tagName === 'TH' ? 'td' : 'th';
      Array.from(r0.cells).forEach(c => {
        const n = document.createElement(to); n.innerHTML = c.innerHTML || '<br>';
        c.replaceWith(n);
      });
      curCell = null;
    } else {
      if (!confirm('이 표를 지울까요?')) return;
      (curTable.closest('.tbl-wrap') || curTable).remove();
      curTable = curCell = null;
    }
  }
  markCtx(); renderNodeBar(); saveActiveField();
}

// ── 내용 탭: 그림 보관함 ─────────────────────
function renderImages() {
  const b = bookById(curId); if (!b) return;
  const box = document.getElementById('imgGrid');
  const note = document.getElementById('imgNote');
  box.innerHTML = (b.images || []).map((src, i) => `
    <div class="img-item">
      <img src="${src}" data-i="${i}" alt="그림 ${i + 1}" />
      <button class="img-into" data-i="${i}">↥ 본문으로</button>
      <button class="img-del" data-i="${i}" aria-label="삭제">✕</button>
    </div>`).join('');
  if (note) note.classList.toggle('hidden', !(b.images || []).length);
  box.querySelectorAll('img').forEach(im => im.onclick = () => openLightbox(im.src));
  box.querySelectorAll('.img-del').forEach(btn => btn.onclick = () => {
    if (!confirm('이 그림을 삭제할까요?')) return;
    b.images.splice(+btn.dataset.i, 1); save(); renderImages(); flashSaved();
  });
  // 보관함 → 본문 커서 위치로 옮기기
  box.querySelectorAll('.img-into').forEach(btn => btn.onclick = () => {
    const i = +btn.dataset.i, src = b.images[i]; if (!src) return;
    if (!insertBlock(makeFigure(src, 'md'))) return;
    b.images.splice(i, 1); save(); renderImages(); flashSaved();
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

// ── 워드(.docx) 불러오기 ─────────────────────
// docx = ZIP. 브라우저 내장 DecompressionStream 으로 압축해제 → word/document.xml 파싱.
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(new Blob([bytes])).body.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
// ZIP 항목 목록 {name -> {method, size, offset}}
function readZipEntries(u8) {
  const dv = new DataView(u8.buffer);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip_eocd');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder('utf-8');
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const exLen = dv.getUint16(p + 30, true);
    const cmLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + fnLen));
    entries[name] = { method, compSize, localOff };
    p += 46 + fnLen + exLen + cmLen;
  }
  return { entries, dv, u8 };
}
async function zipRead(zip, name) {
  const e = zip.entries[name]; if (!e) return null;
  const { dv, u8 } = zip;
  const lfnLen = dv.getUint16(e.localOff + 26, true);
  const lexLen = dv.getUint16(e.localOff + 28, true);
  const start = e.localOff + 30 + lfnLen + lexLen;
  const comp = u8.subarray(start, start + e.compSize);
  return e.method === 0 ? comp : await inflateRaw(comp);
}
// 실행(run) 묶음 → HTML. 그림은 자리표시자(%%IMG:관계ID|크기%%)로 두고 나중에 채운다.
function docxRunsHtml(p, wantIds) {
  let inner = '';
  for (const r of p.getElementsByTagName('w:r')) {
    const rpr = r.getElementsByTagName('w:rPr')[0];
    const bold = rpr && rpr.getElementsByTagName('w:b').length;
    const ital = rpr && rpr.getElementsByTagName('w:i').length;
    const und = rpr && rpr.getElementsByTagName('w:u').length;
    let t = '';
    for (const c of r.childNodes) {
      const nm = c.nodeName;
      if (nm === 'w:t') t += c.textContent;
      else if (nm === 'w:tab') t += '    ';
      else if (nm === 'w:br' || nm === 'w:cr') t += '\n';
      else if (nm === 'w:drawing' || nm === 'w:pict' || nm === 'w:object') {
        const ref = docxImageRef(c);
        if (ref) { wantIds.add(ref.id); inner += `%%IMG:${ref.id}|${ref.size}%%`; }
      }
    }
    if (!t) continue;
    let h = esc(t).replace(/\n/g, '<br>');
    if (bold) h = `<b>${h}</b>`;
    if (ital) h = `<i>${h}</i>`;
    if (und) h = `<u>${h}</u>`;
    inner += h;
  }
  return inner;
}
// 그림 노드 → {id: 관계ID, size: 문서에 박힌 폭으로 고른 크기}
function docxImageRef(node) {
  const blip = node.getElementsByTagName('a:blip')[0];
  const vml = node.getElementsByTagName('v:imagedata')[0];
  const id = blip ? (blip.getAttribute('r:embed') || blip.getAttribute('r:link'))
    : vml ? vml.getAttribute('r:id') : null;
  if (!id) return null;
  const ext = node.getElementsByTagName('wp:extent')[0];
  const cx = ext ? parseInt(ext.getAttribute('cx') || '0', 10) : 0;   // EMU (914400 = 1인치)
  const inch = cx / 914400;
  const size = !inch ? 'md' : inch >= 5 ? 'full' : inch >= 3.4 ? 'lg' : inch >= 2 ? 'md' : 'sm';
  return { id, size };
}
// w:tbl → 표 HTML (가로 병합 지원, 세로 병합은 빈 칸으로)
function docxTblHtml(tbl, wantIds) {
  let h = '<div class="tbl-wrap"><table class="tbl"><tbody>';
  let first = true;
  for (const tr of tbl.children) {
    if (tr.nodeName !== 'w:tr') continue;
    const trPr = tr.getElementsByTagName('w:trPr')[0];
    const tag = (first && trPr && trPr.getElementsByTagName('w:tblHeader').length) ? 'th' : 'td';
    h += '<tr>';
    for (const tc of tr.children) {
      if (tc.nodeName !== 'w:tc') continue;
      const pr = tc.getElementsByTagName('w:tcPr')[0];
      const gs = pr && pr.getElementsByTagName('w:gridSpan')[0];
      const span = gs ? (parseInt(gs.getAttribute('w:val') || '1', 10) || 1) : 1;
      const paras = Array.from(tc.children).filter(n => n.nodeName === 'w:p');
      const body = paras.map(p => docxRunsHtml(p, wantIds)).filter(Boolean).join('<br>') || '<br>';
      h += `<${tag}${span > 1 ? ` colspan="${span}"` : ''}>${body}</${tag}>`;
    }
    h += '</tr>'; first = false;
  }
  return h + '</tbody></table></div>';
}
// document.xml → 본문 HTML(문단 서식 + 표 + 그림 자리표시자)
function docxXmlToHtml(xmlText, wantIds) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const body = doc.getElementsByTagName('w:body')[0];
  if (!body) return { html: '', paras: 0, tables: 0 };
  const jcMap = { center: 'center', right: 'right', both: 'justify', left: 'left', start: 'left', end: 'right' };
  let out = '', paras = 0, tables = 0;
  for (const node of body.children) {
    if (node.nodeName === 'w:p') {
      const jc = node.getElementsByTagName('w:jc')[0];
      const align = jc ? jcMap[jc.getAttribute('w:val')] : '';
      out += `<div${align ? ` style="text-align:${align}"` : ''}>${docxRunsHtml(node, wantIds) || '<br>'}</div>`;
      paras++;
    } else if (node.nodeName === 'w:tbl') {
      out += docxTblHtml(node, wantIds); tables++;
    }
  }
  return { html: out, paras, tables };
}
// 관계ID → word/media 파일 → 축소한 data URL
async function docxImageMap(zip, ids) {
  const map = {};
  if (!ids.size) return map;
  const relBytes = await zipRead(zip, 'word/_rels/document.xml.rels');
  if (!relBytes) return map;
  const rdoc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(relBytes), 'application/xml');
  const targets = {};
  for (const rel of rdoc.getElementsByTagName('Relationship')) targets[rel.getAttribute('Id')] = rel.getAttribute('Target') || '';
  for (const id of ids) {
    let t = targets[id]; if (!t) continue;
    t = t.replace(/^\/+/, '').replace(/^\.\.\//, '');
    const name = t.startsWith('word/') ? t : 'word/' + t;
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (!/^(png|jpe?g|gif|webp|bmp)$/.test(ext)) continue;   // 브라우저가 못 그리는 형식(emf/wmf)은 건너뜀
    const bytes = await zipRead(zip, name); if (!bytes) continue;
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const durl = await new Promise(res => downscale(new File([bytes], name, { type: mime }), res));
    if (durl) map[id] = durl;
  }
  return map;
}
async function importDocx(file) {
  if (typeof DecompressionStream === 'undefined') { alert('이 브라우저는 워드 불러오기를 지원하지 않아요(최신 크롬/사파리 필요).'); return; }
  const b = bookById(curId); if (!b) return;
  const btn = document.getElementById('btnImportDocx'); const old = btn.textContent;
  btn.textContent = '불러오는 중…'; btn.disabled = true;
  try {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const zip = readZipEntries(u8);
    const docBytes = await zipRead(zip, 'word/document.xml');
    if (!docBytes) throw new Error('no_document_xml');
    const wantIds = new Set();
    const { html, paras, tables } = docxXmlToHtml(new TextDecoder('utf-8').decode(docBytes), wantIds);
    // 그림을 원래 있던 자리에 그대로 끼워 넣는다
    const imgMap = await docxImageMap(zip, wantIds);
    let imgCount = 0;
    const filled = html.replace(/%%IMG:([^|%]+)\|([a-z]+)%%/g, (_, id, size) => {
      const src = imgMap[id]; if (!src) return '';
      imgCount++;
      return `<figure class="fig w-${size}" contenteditable="false"><img src="${src}" alt="">` +
             `<figcaption contenteditable="true" data-ph="설명(선택)"></figcaption></figure>`;
    });
    const ed = document.getElementById('fContent');
    ed.innerHTML = (ed.innerHTML && ed.innerHTML !== '<br>') ? ed.innerHTML + '<hr>' + filled : filled;
    normalizeIndent(ed); applyEditability();
    b.content = ed.innerHTML;
    if (!save()) alert('저장 공간이 부족해요. 그림이 많은 문서는 나눠서 불러와 주세요.');
    renderImages(); flashSaved();
    alert(`불러왔어요 📄  (문단 ${paras}개${tables ? `, 표 ${tables}개` : ''}${imgCount ? `, 그림 ${imgCount}장` : ''})`);
  } catch (e) {
    alert('워드 파일을 읽지 못했어요. .docx 형식인지 확인해 주세요.');
  } finally {
    btn.textContent = old; btn.disabled = false;
  }
}

// ── 초기화 ───────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  load();
  renderHome();
  updateLockUI();
  document.getElementById('btnLock').onclick = promptEditToken;
  document.getElementById('btnRefresh').onclick = manualRefresh;
  document.getElementById('btnMarkSet').onclick = setMarkHere;
  document.getElementById('btnMarkClear').onclick = clearMark;
  document.getElementById('appVer').textContent = APP_VER;
  document.querySelectorAll('.btn-editmode').forEach(b => b.onclick = () => setEditMode(!editMode));
  setEditMode(false);          // 시작은 언제나 읽기 모드
  syncInitial();   // 서버에서 최신 목록 받아오기(비동기)
  document.getElementById('btnBack').onclick = backHome;
  document.getElementById('btnDelete').onclick = () => {
    const b = bookById(curId); if (!b) return;
    if (!confirm(`'${b.title}'을(를) 삭제할까요? 되돌릴 수 없어요.`)) return;
    // 목록에서 빼는 대신 삭제 표시만 — 안 그러면 다른 기기와 합칠 때 되살아난다
    b.deleted = true; b.toc = b.content = b.original = b.memo = ''; b.images = [];
    save(); backHome();
  };
  document.getElementById('btnEditInfo').onclick = () => openDialog(curId);
  document.querySelectorAll('#tabs .tab').forEach(t => t.onclick = () => setTab(t.dataset.tab));
  document.querySelectorAll('.edit').forEach(t => t.addEventListener('input', onFieldInput));

  // ── 서식 툴바 배선 ──
  // 편집기 안의 '실제 선택(비어있지 않은)'만 기억 → 키보드 닫기/블러로 커서가 접혀도 유지
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection(); if (!s.rangeCount) return;
    const ed = activeEditor(); if (!ed) return;
    const r = s.getRangeAt(0);
    if (!ed.contains(r.commonAncestorContainer)) return;
    lastRange = r.cloneRange();                                   // 삽입 지점(접힌 커서 포함)
    if (!s.isCollapsed && ed.contains(s.focusNode)) savedRange = r.cloneRange();
    refreshCtx();                                                 // 그림/표 도구 갱신
  });
  // 모바일 키보드가 올라오면 툴바를 키보드 바로 위로 띄워 가려지지 않게
  const vv = window.visualViewport;
  if (vv) {
    const posBar = () => {
      const bar = document.getElementById('fmtBar');
      if (!bar || document.getElementById('bookView').classList.contains('hidden')) return;
      const kb = window.innerHeight - (vv.height + vv.offsetTop);
      if (kb > 80) { bar.style.position = 'fixed'; bar.style.left = '0'; bar.style.right = '0'; bar.style.bottom = kb + 'px'; bar.style.zIndex = '60'; }
      else { bar.style.position = ''; bar.style.left = ''; bar.style.right = ''; bar.style.bottom = ''; bar.style.zIndex = ''; }
    };
    vv.addEventListener('resize', posBar); vv.addEventListener('scroll', posBar);
  }
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
  bindFmt('#fmtHilites [data-hilite]', btn => fmtHilite(btn.dataset.hilite));
  const cp = document.getElementById('fmtColorPick');
  cp.addEventListener('input', () => fmtColor(cp.value));
  const hp = document.getElementById('fmtHilitePick');
  hp.addEventListener('input', () => fmtHilite(hp.value));
  document.getElementById('dialogSave').onclick = saveDialog;
  document.getElementById('dialogCancel').onclick = () => document.getElementById('bookDialog').close();
  document.getElementById('fBookTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveDialog(); } });
  document.getElementById('btnAddImg').onclick = () => { imgTarget = 'gallery'; document.getElementById('imgFile').click(); };
  document.getElementById('imgFile').onchange = e => {
    const el = e.target;
    if (imgTarget === 'inline') { const files = Array.from(el.files || []); el.value = ''; insertImageFiles(files, 'md'); }
    else addImageFiles(el);
  };
  document.getElementById('btnImportDocx').onclick = () => document.getElementById('docxFile').click();
  document.getElementById('docxFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importDocx(f); };
  document.getElementById('btnImportTxt').onclick = () => document.getElementById('txtFile').click();
  document.getElementById('txtFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importTxt(f); };
  document.getElementById('lightbox').onclick = () => document.getElementById('lightbox').classList.add('hidden');

  // ── 본문 삽입(그림/표) 배선 ──
  // 삽입 버튼도 pointerdown 으로 잡아 커서 위치를 잃지 않게 한다.
  document.getElementById('btnInsImg').addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!activeEditor()) return;
    imgTarget = 'inline'; document.getElementById('imgFile').click();
  });
  const tblDlg = document.getElementById('tableDialog');
  document.getElementById('btnInsTable').addEventListener('pointerdown', e => {
    e.preventDefault();
    if (!activeEditor()) return;
    tblDlg.showModal();
  });
  document.getElementById('tableInsert').onclick = insertTableFromDialog;
  document.getElementById('tableCancel').onclick = () => tblDlg.close();
  document.getElementById('nodeActs').addEventListener('pointerdown', e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    e.preventDefault(); nodeAct(btn.dataset.act);
  });
  // 본문 안 그림 탭 → 편집 중이면 선택(도구 표시), 읽기전용이면 확대
  document.querySelectorAll('.edit').forEach(ed => {
    ed.addEventListener('click', e => {
      const img = e.target.closest('img');
      if (img && !canEdit()) { openLightbox(img.src); return; }
      refreshCtx(e.target);
    });
    // 사진 붙여넣기 → 커서 자리에 바로 삽입 (원본 탭은 글자만)
    ed.addEventListener('paste', e => {
      if (!canEdit()) return;
      if (ed.classList.contains('plain')) {                            // 원본: 서식·그림 없이 글자만
        e.preventDefault();
        const txt = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        if (txt) insertPlainText(ed, txt);
        return;
      }
      const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
      const files = items.filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
      if (!files.length) return;
      e.preventDefault();
      const s = window.getSelection();
      if (s.rangeCount && ed.contains(s.getRangeAt(0).commonAncestorContainer)) lastRange = s.getRangeAt(0).cloneRange();
      insertImageFiles(files, 'md');
    });
    // 원본 탭은 끌어다 놓기도 글자만 받는다(그림·서식 차단)
    ed.addEventListener('drop', e => {
      if (!ed.classList.contains('plain') || !canEdit()) return;
      e.preventDefault();
      const txt = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || '';
      if (txt) insertPlainText(ed, txt);
    });
  });

  // 마지막 읽던 위치 복원 + 위치 저장(스크롤/이탈 시)
  restoreLast();
  window.addEventListener('scroll', saveLast, { passive: true });
  // 앱을 껐다 켜야만 반영되던 문제 — 화면으로 돌아올 때·온라인 복귀 때 서버와 다시 맞춘다.
  // (예전에는 DOMContentLoaded 때 딱 한 번만 받아와서, 백그라운드에 살아있던 앱은 계속 옛 내용이었다)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveLast();
    else pullAndMerge();
  });
  addEventListener('online', () => { pullAndMerge(); if (getEditToken()) scheduleSync(); });
  window.addEventListener('pagehide', saveLast);
});
