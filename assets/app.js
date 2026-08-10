// 도서모음 — 기기(localStorage) 저장 정적 앱. 책 그리드 + 4탭(목차/내용/내용요약/메모).
'use strict';
const STORE = 'doso-books-v1';
const IMG_MAX = 1200;   // 업로드 이미지 다운스케일 최대 변

let state = { books: [] };
let curId = null;        // 열려 있는 책 id
let editId = null;       // 다이얼로그 수정 대상(없으면 추가)
let saveTimer = null;

// ── 저장/로드 ────────────────────────────────
function load() {
  try { const raw = localStorage.getItem(STORE); if (raw) { const d = JSON.parse(raw); if (d && Array.isArray(d.books)) state = d; } } catch (e) {}
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); return true; }
  catch (e) { return false; }
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
  document.getElementById('fToc').value = b.toc || '';
  document.getElementById('fContent').value = b.content || '';
  document.getElementById('fSummary').value = b.summary || '';
  document.getElementById('fMemo').value = b.memo || '';
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

// 텍스트 필드 자동 저장(디바운스)
function onFieldInput(e) {
  const b = bookById(curId); if (!b) return;
  b[e.target.dataset.field] = e.target.value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { save(); flashSaved(); }, 400);
}

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
  document.getElementById('btnBack').onclick = backHome;
  document.getElementById('btnDelete').onclick = () => {
    const b = bookById(curId); if (!b) return;
    if (!confirm(`'${b.title}'을(를) 삭제할까요? 되돌릴 수 없어요.`)) return;
    state.books = state.books.filter(x => x.id !== curId); save(); backHome();
  };
  document.getElementById('btnEditInfo').onclick = () => openDialog(curId);
  document.querySelectorAll('#tabs .tab').forEach(t => t.onclick = () => setTab(t.dataset.tab));
  document.querySelectorAll('.edit').forEach(t => t.addEventListener('input', onFieldInput));
  document.getElementById('dialogSave').onclick = saveDialog;
  document.getElementById('dialogCancel').onclick = () => document.getElementById('bookDialog').close();
  document.getElementById('fBookTitle').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); saveDialog(); } });
  document.getElementById('btnAddImg').onclick = () => document.getElementById('imgFile').click();
  document.getElementById('imgFile').onchange = e => addImageFiles(e.target);
  document.getElementById('lightbox').onclick = () => document.getElementById('lightbox').classList.add('hidden');
});
