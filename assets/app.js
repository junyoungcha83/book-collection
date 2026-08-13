// 도서모음 — 기기(localStorage) 저장 정적 앱. 책 그리드 + 4탭(목차/내용/내용요약/메모).
'use strict';
const STORE = 'doso-books-v1';
const LAST_KEY = 'doso-last';   // 마지막 읽던 위치(책/탭/스크롤/커서)
const TOKEN_KEY = 'doso-edit-token';
const API_BASE = 'https://book-collection-api.junyoung-cha83.workers.dev';
const SYNC_DEBOUNCE_MS = 800;
const IMG_MAX = 1200;   // 업로드 이미지 다운스케일 최대 변

let state = { books: [] };
let curId = null;        // 열려 있는 책 id
let curTab = 'toc';      // 현재 탭
let editId = null;       // 다이얼로그 수정 대상(없으면 추가)
let saveTimer = null;    // 텍스트 입력 → localStorage 디바운스
let _syncTimer = null, _syncCtrl = null;
let _lastTimer = null;

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
function canEdit() { return !!getEditToken(); }
// 편집 가능 여부에 따라 편집기·편집 버튼을 켜고 끈다(평소 읽기전용, 비번 입력 시 편집).
function applyEditability() {
  const on = canEdit();
  document.body.classList.toggle('readonly', !on);
  document.querySelectorAll('.edit').forEach(e => e.setAttribute('contenteditable', on ? 'true' : 'false'));
}
function updateLockUI() {
  const b = document.getElementById('btnLock'); if (!b) return;
  const has = canEdit();
  b.textContent = has ? '🔓' : '🔒';
  b.title = has ? '편집 켜짐 · 동기화 (탭하여 잠금)' : '읽기전용 — 탭하여 비밀번호 입력 후 편집';
  applyEditability();
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
  const v = prompt(cur ? '편집 비밀번호 (지우고 확인 시 읽기전용)' : '편집 비밀번호를 입력하세요 (읽기전용 해제)', cur);
  if (v === null) return;
  try { if (v.trim()) localStorage.setItem(TOKEN_KEY, v.trim()); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  updateLockUI();
  if (!document.getElementById('homeView').classList.contains('hidden')) renderHome();   // 홈 힌트·＋타일 갱신
  if (getEditToken()) pushToServer(); else setSyncStatus('readonly');
}
// 시작 시 서버에서 불러오기(있으면 채택, 서버가 비었고 로컬이 있으면 업로드)
async function syncInitial() {
  setSyncStatus(getEditToken() ? 'saved' : 'readonly');
  const remote = await fetchFromServer();
  if (remote && remote.books.length > 0) {
    state = migrate(remote); cacheLocal();
    if (curId && !bookById(curId)) backHome();
    else if (curId) restoreLast();
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
  const emptyHint = (!state.books.length && !canEdit())
    ? `<div class="ro-hint">🔒 읽기전용입니다.<br>오른쪽 위 자물쇠를 눌러 비밀번호를 입력하면 편집할 수 있어요.</div>` : '';
  grid.innerHTML = add + cards + emptyHint;
  document.getElementById('bookCount').textContent = state.books.length ? `${state.books.length}권` : '';
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
  applyEditability();
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
  curTab = tab;
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const map = { toc: 'panelToc', content: 'panelContent', summary: 'panelSummary', memo: 'panelMemo' };
  Object.entries(map).forEach(([k, id]) => document.getElementById(id).classList.toggle('hidden', k !== tab));
  saveLast();
}
function backHome() {
  curId = null;
  document.getElementById('bookView').classList.add('hidden');
  document.getElementById('homeView').classList.remove('hidden');
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
  if (last.tab) setTab(last.tab);
  requestAnimationFrame(() => {
    window.scrollTo(0, last.scrollY || 0);
    if (last.caret && last.caret.off >= 0) {
      const ed = activeEditor();
      if (ed && ed.dataset.field === last.caret.field) { ed.focus(); setCaretOffset(ed, last.caret.off); }
    }
  });
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
// document.xml → 서식 HTML(문단 정렬 + 굵게/기울임/밑줄)
function docxXmlToHtml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const paras = doc.getElementsByTagName('w:p');
  const jcMap = { center: 'center', right: 'right', both: 'justify', left: 'left', start: 'left', end: 'right' };
  let out = '';
  for (const p of paras) {
    const jc = p.getElementsByTagName('w:jc')[0];
    const align = jc ? jcMap[jc.getAttribute('w:val')] : '';
    let inner = '';
    for (const r of p.getElementsByTagName('w:r')) {
      const rpr = r.getElementsByTagName('w:rPr')[0];
      const b = rpr && rpr.getElementsByTagName('w:b').length;
      const i = rpr && rpr.getElementsByTagName('w:i').length;
      const u = rpr && rpr.getElementsByTagName('w:u').length;
      let t = '';
      for (const c of r.childNodes) {
        const nm = c.nodeName;
        if (nm === 'w:t') t += c.textContent;
        else if (nm === 'w:tab') t += '    ';
        else if (nm === 'w:br' || nm === 'w:cr') t += '\n';
      }
      if (!t) continue;
      let h = esc(t).replace(/\n/g, '<br>');
      if (b) h = `<b>${h}</b>`;
      if (i) h = `<i>${h}</i>`;
      if (u) h = `<u>${h}</u>`;
      inner += h;
    }
    out += `<div${align ? ` style="text-align:${align}"` : ''}>${inner || '<br>'}</div>`;
  }
  return out;
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
    const html = docxXmlToHtml(new TextDecoder('utf-8').decode(docBytes));
    // 편집기에 추가(기존 내용 뒤에)
    const ed = document.getElementById('fContent');
    ed.innerHTML = (ed.innerHTML && ed.innerHTML !== '<br>') ? ed.innerHTML + '<hr>' + html : html;
    b.content = ed.innerHTML;
    // 문서 내 이미지 → 그림 목록에 추가(다운스케일)
    b.images = b.images || [];
    const media = Object.keys(zip.entries).filter(n => /^word\/media\/.*\.(png|jpe?g|gif|webp|bmp)$/i.test(n));
    let imgCount = 0;
    for (const name of media) {
      const bytes = await zipRead(zip, name); if (!bytes) continue;
      const ext = name.split('.').pop().toLowerCase();
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      const durl = await new Promise(res => downscale(new File([bytes], name, { type: mime }), res));
      if (durl) { b.images.push(durl); imgCount++; }
    }
    save(); renderImages(); flashSaved();
    alert(`불러왔어요 📄  (문단 ${zip ? html.split('<div').length - 1 : 0}개${imgCount ? `, 그림 ${imgCount}장` : ''})`);
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
  // 편집기 안의 '실제 선택(비어있지 않은)'만 기억 → 키보드 닫기/블러로 커서가 접혀도 유지
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection(); if (!s.rangeCount || s.isCollapsed) return;
    const ed = activeEditor();
    if (ed && ed.contains(s.anchorNode) && ed.contains(s.focusNode)) savedRange = s.getRangeAt(0).cloneRange();
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
  const cp = document.getElementById('fmtColorPick');
  cp.addEventListener('input', () => fmtColor(cp.value));
  document.getElementById('dialogSave').onclick = saveDialog;
  document.getElementById('dialogCancel').onclick = () => document.getElementById('bookDialog').close();
  document.getElementById('fBookTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveDialog(); } });
  document.getElementById('btnAddImg').onclick = () => document.getElementById('imgFile').click();
  document.getElementById('imgFile').onchange = e => addImageFiles(e.target);
  document.getElementById('btnImportDocx').onclick = () => document.getElementById('docxFile').click();
  document.getElementById('docxFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) importDocx(f); };
  document.getElementById('lightbox').onclick = () => document.getElementById('lightbox').classList.add('hidden');

  // 마지막 읽던 위치 복원 + 위치 저장(스크롤/이탈 시)
  restoreLast();
  window.addEventListener('scroll', saveLast, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveLast(); });
  window.addEventListener('pagehide', saveLast);
});
