// app.js — 房屋修圖器 主程式（畫面切換、案件、照片牆、修圖流程、設定）
//
// 畫面：home（案件列表）→ listing（照片牆）→ editor（修圖）；settings（設定）
// 用 history.pushState 記錄畫面，讓手機的「返回」手勢也能正常運作。

import * as db from './lib/db.js';
import * as img from './lib/image.js';
import * as ui from './lib/ui.js';
import * as eng from './lib/engines.js';
import { settings } from './lib/settings.js';
import { Editor } from './lib/editor.js';
import { buildExportFile, deliverFiles } from './lib/export.js';

const $ = (sel, root = document) => root.querySelector(sel);

const screens = {
  home: $('#screen-home'),
  listing: $('#screen-listing'),
  editor: $('#screen-editor'),
  settings: $('#screen-settings'),
};

/** 目前畫面狀態 */
const cur = { screen: 'home', listingId: null, listing: null, photos: [] };

/** 撤銷步驟上限（含原圖那一格） */
const HISTORY_LIMIT = 10;
/** 放開手指後多久自動開始移除 */
const AUTO_RUN_DELAY = 400;

const COMPLIANCE_HTML = `
  <div class="compliance-body">
    <p><span class="yes">可以移除：</span>可移動的雜物，例如衣物、垃圾、紙箱、雜亂的桌面物品、電線、個人物品。</p>
    <p><span class="no">不可以移除：</span></p>
    <ul>
      <li>壁癌、漏水、水漬、裂縫等房屋瑕疵</li>
      <li>窗外的嫌惡設施（如電塔、墓地、高架道路、焚化爐）</li>
      <li>任何會影響買方判斷屋況的東西</li>
    </ul>
    <p class="law">依《不動產經紀業管理條例》第 21 條及《公平交易法》第 21 條，廣告內容必須與事實相符，不得虛偽不實或引人錯誤。修過的照片建議保留「照片經整理示意」浮水印。</p>
  </div>`;

function complianceNode() {
  const d = document.createElement('div');
  d.innerHTML = COMPLIANCE_HTML; // 固定內容，非使用者輸入
  return d;
}

// =========================================================
// 物件網址（縮圖）管理：換畫面時統一釋放
// =========================================================
const urlBuckets = { home: [], listing: [] };
function blobUrl(bucket, blob) {
  const u = URL.createObjectURL(blob);
  urlBuckets[bucket].push(u);
  return u;
}
function revokeBucket(bucket) {
  for (const u of urlBuckets[bucket]) URL.revokeObjectURL(u);
  urlBuckets[bucket] = [];
}

function formatDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function svgIcon(id) {
  return `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
}

// =========================================================
// 畫面切換（路由）
// =========================================================
function showScreen(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  cur.screen = name;
}

function stateNow() {
  if (cur.screen === 'editor' && ed) return { screen: 'editor', listingId: ed.listingId, photoId: ed.photoId };
  if (cur.screen === 'listing') return { screen: 'listing', listingId: cur.listingId };
  return { screen: cur.screen };
}

async function navigate(state, { replace = false } = {}) {
  if (replace) history.replaceState(state, '');
  else history.pushState(state, '');
  await applyState(state);
}

async function applyState(s) {
  const target = s && s.screen ? s.screen : 'home';
  // 離開修圖畫面（不是去設定）→ 釋放記憶體
  if (cur.screen === 'editor' && target !== 'editor' && target !== 'settings') closeEditor();

  switch (target) {
    case 'listing':
      if (!(await openListing(s.listingId))) return navigate({ screen: 'home' }, { replace: true });
      break;
    case 'editor':
      if (ed && ed.photoId === s.photoId) { showScreen('editor'); editor.resize(); }
      else if (!(await openEditor(s.listingId, s.photoId))) return navigate({ screen: 'home' }, { replace: true });
      break;
    case 'settings':
      await openSettings();
      break;
    default:
      await openHome();
  }
}

/** 返回（畫面左上角的返回鍵） */
function goBack() {
  if (history.state && history.state.screen && history.state.screen !== 'home') history.back();
  else navigate({ screen: 'home' }, { replace: true });
}

window.addEventListener('popstate', async (e) => {
  const s = e.state || { screen: 'home' };
  // 修圖中離開的保護
  if (cur.screen === 'editor' && ed && s.screen !== 'editor' && s.screen !== 'settings') {
    if (ed.busy) {
      history.pushState(stateNow(), '');
      ui.toast('AI 處理中，請稍候');
      return;
    }
    if (isDirty()) {
      history.pushState(stateNow(), '');
      const choice = await ui.dialog({
        title: '修改還沒儲存',
        message: '要先儲存這張照片的修改嗎？',
        buttons: [
          { label: '儲存後離開', value: 'save', primary: true },
          { label: '不儲存，直接離開', value: 'discard', dangerText: true },
          { label: '繼續修圖', value: null },
        ],
      });
      if (choice === 'save') { if (!(await saveEdit())) return; }
      else if (choice !== 'discard') return;
      if (ed) ed.savedIndex = ed.hIndex; // 標記為不需再問
      history.back();
      return;
    }
  }
  await applyState(s);
});

window.addEventListener('beforeunload', (e) => {
  if (ed && isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action="back"]');
  if (b) goBack();
});

// =========================================================
// 首頁：案件列表
// =========================================================
async function openHome() {
  showScreen('home');
  revokeBucket('listing');
  await renderHome();
}

async function renderHome() {
  const list = $('#listing-list');
  revokeBucket('home');
  let items = [];
  try { items = await db.listListings(); }
  catch (e) { ui.alert('讀取案件失敗', eng.errorMessage(e)); }

  list.replaceChildren(...items.map(listingCard));
  $('#home-empty').hidden = items.length > 0;
}

function listingCard(l) {
  const card = document.createElement('div');
  card.className = 'listing-card';
  card.setAttribute('role', 'button');
  card.tabIndex = 0;

  const thumb = document.createElement('div');
  thumb.className = 'listing-thumb';
  if (l.coverThumb) {
    const im = document.createElement('img');
    im.alt = '';
    im.src = blobUrl('home', l.coverThumb);
    thumb.append(im);
  } else {
    thumb.innerHTML = svgIcon('i-photo');
  }

  const meta = document.createElement('div');
  meta.className = 'listing-meta';
  const name = document.createElement('div');
  name.className = 'listing-name';
  name.textContent = l.name;
  const sub = document.createElement('div');
  sub.className = 'listing-sub';
  sub.textContent = `${formatDate(l.createdAt)} · ${l.count} 張照片`;
  if (l.editedCount) {
    const done = document.createElement('span');
    done.className = 'done';
    done.textContent = ` · 已整理 ${l.editedCount}`;
    sub.append(done);
  }
  meta.append(name, sub);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn';
  more.setAttribute('aria-label', `「${l.name}」選項`);
  more.innerHTML = svgIcon('i-more');
  more.addEventListener('click', (e) => { e.stopPropagation(); listingMenu(l); });

  card.append(thumb, meta, more);
  const open = () => navigate({ screen: 'listing', listingId: l.id });
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return card;
}

async function listingMenu(l) {
  const v = await ui.actionSheet(l.name, [
    { label: '重新命名', value: 'rename' },
    { label: '刪除案件', value: 'delete', danger: true },
  ]);
  if (v === 'rename') await renameListingFlow(l);
  if (v === 'delete') await deleteListingFlow(l);
}

async function newListingFlow() {
  const d = new Date();
  const name = await ui.prompt('新增案件', {
    message: '輸入物件名稱，例如「信義區三房」或社區名稱。',
    value: '',
    placeholder: `新案件 ${d.getMonth() + 1}/${d.getDate()}`,
    okLabel: '建立',
  });
  if (name === null) return;
  try {
    const l = await db.createListing(name || `新案件 ${d.getMonth() + 1}/${d.getDate()}`);
    await navigate({ screen: 'listing', listingId: l.id });
  } catch (e) {
    ui.alert('建立失敗', eng.errorMessage(e));
  }
}

async function renameListingFlow(l) {
  const name = await ui.prompt('重新命名', { value: l.name, okLabel: '儲存' });
  if (!name) return;
  try {
    const updated = await db.renameListing(l.id, name);
    if (cur.listingId === l.id) { cur.listing = updated; $('#listing-title').textContent = updated.name; }
    if (cur.screen === 'home') await renderHome();
    ui.toast('已重新命名');
  } catch (e) { ui.alert('重新命名失敗', eng.errorMessage(e)); }
}

async function deleteListingFlow(l) {
  let count = l.count;
  if (count == null) { try { count = (await db.listPhotos(l.id)).length; } catch { count = 0; } }
  const ok = await ui.confirm(`刪除「${l.name}」？`,
    `這個案件的 ${count} 張照片（包含原圖和修好的照片）都會從這支手機刪除，無法復原。\n\n已經存到相簿或傳出去的照片不受影響。`,
    { okLabel: '刪除', danger: true });
  if (!ok) return;
  try {
    await db.deleteListing(l.id);
    ui.toast('已刪除案件');
    if (cur.screen === 'listing') await navigate({ screen: 'home' }, { replace: true });
    else await renderHome();
  } catch (e) { ui.alert('刪除失敗', eng.errorMessage(e)); }
}

// =========================================================
// 照片牆
// =========================================================
async function openListing(listingId) {
  let l = null;
  try { l = await db.getListing(listingId); } catch (e) { ui.alert('讀取失敗', eng.errorMessage(e)); }
  if (!l) return false;
  cur.listingId = l.id;
  cur.listing = l;
  $('#listing-title').textContent = l.name;
  showScreen('listing');
  revokeBucket('home');
  await renderPhotos();
  return true;
}

async function renderPhotos() {
  const grid = $('#photo-grid');
  revokeBucket('listing');
  let photos = [];
  try { photos = await db.listPhotos(cur.listingId); }
  catch (e) { ui.alert('讀取照片失敗', eng.errorMessage(e)); }
  cur.photos = photos;

  grid.replaceChildren(...photos.map((p, i) => photoTile(p, i)));
  $('#listing-empty').hidden = photos.length > 0;
  const edited = photos.filter((p) => p.edited).length;
  $('#listing-summary').textContent = photos.length
    ? `共 ${photos.length} 張，已整理 ${edited} 張。點照片開始修圖。`
    : '';
  $('#btn-export-all').disabled = photos.length === 0;
}

function photoTile(p, i) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.setAttribute('role', 'button');
  tile.tabIndex = 0;
  tile.setAttribute('aria-label', `第 ${i + 1} 張${p.edited ? '（已整理）' : ''}，點一下修圖`);

  const t = db.thumbOf(p);
  if (t) {
    const im = document.createElement('img');
    im.alt = '';
    im.loading = 'lazy';
    im.src = blobUrl('listing', t);
    tile.append(im);
  }
  if (p.edited) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = '✓ 已整理';
    tile.append(b);
  }
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(i + 1);
  tile.append(num);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'tile-more';
  more.setAttribute('aria-label', `第 ${i + 1} 張選項`);
  more.innerHTML = `<span>${svgIcon('i-more')}</span>`;
  more.addEventListener('click', (e) => { e.stopPropagation(); photoMenu(p, i); });
  tile.append(more);

  const open = () => navigate({ screen: 'editor', listingId: cur.listingId, photoId: p.id });
  tile.addEventListener('click', open);
  tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return tile;
}

async function photoMenu(p, i) {
  const actions = [
    { label: '修圖', value: 'edit' },
    { label: '匯出這張（存到相簿／LINE）', value: 'export' },
  ];
  if (p.edited) actions.push({ label: '恢復原圖（移除修圖結果）', value: 'restore' });
  actions.push({ label: '刪除這張照片', value: 'delete', danger: true });
  const v = await ui.actionSheet(`第 ${i + 1} 張`, actions);
  if (v === 'edit') navigate({ screen: 'editor', listingId: cur.listingId, photoId: p.id });
  if (v === 'export') exportPhotos([{ photo: p, index: i + 1 }]);
  if (v === 'restore') {
    const ok = await ui.confirm('恢復原圖？', '這張照片的修圖結果會被移除，回到拍攝時的樣子。原圖一直都有保留。', { okLabel: '恢復原圖', danger: true });
    if (!ok) return;
    try { await db.saveEdited(p.id, null, null); ui.toast('已恢復原圖'); await renderPhotos(); }
    catch (e) { ui.alert('恢復失敗', eng.errorMessage(e)); }
  }
  if (v === 'delete') {
    const ok = await ui.confirm('刪除這張照片？', '原圖和修好的照片都會從這支手機刪除，無法復原。', { okLabel: '刪除', danger: true });
    if (!ok) return;
    try { await db.deletePhoto(p.id); ui.toast('已刪除'); await renderPhotos(); }
    catch (e) { ui.alert('刪除失敗', eng.errorMessage(e)); }
  }
}

let persistAsked = false;
async function importFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => !f.type || f.type.startsWith('image/'));
  if (!files.length) return;
  if (!persistAsked) { persistAsked = true; db.requestPersist(); }
  const busy = ui.busy('加入照片中…');
  let ok = 0;
  const failed = [];
  try {
    for (let i = 0; i < files.length; i++) {
      busy.update(`加入照片中 ${i + 1} / ${files.length}`);
      try {
        const data = await img.importPhotoFile(files[i]);
        await db.addPhoto(cur.listingId, data);
        ok++;
      } catch (e) {
        console.error(e);
        failed.push(eng.errorMessage(e));
        // 空間不足就不要再試後面的
        if (/空間不足/.test(failed[failed.length - 1])) break;
      }
    }
  } finally {
    busy.close();
  }
  await renderPhotos();
  if (failed.length) {
    ui.alert(ok ? `已加入 ${ok} 張，${failed.length} 張失敗` : '加入照片失敗', failed[0]);
  } else {
    ui.toast(`已加入 ${ok} 張照片`);
  }
}

// =========================================================
// 匯出
// =========================================================
/** @param {{photo:any,index:number}[]} items */
async function exportPhotos(items) {
  if (!items.length) return;
  const busy = ui.busy('準備照片中…');
  const files = [];
  try {
    for (let k = 0; k < items.length; k++) {
      busy.update(items.length > 1 ? `準備照片中 ${k + 1} / ${items.length}` : '準備照片中…');
      files.push(await buildExportFile(items[k].photo, {
        listingName: cur.listing ? cur.listing.name : '照片',
        index: items[k].index,
        watermark: settings.watermark,
      }));
    }
  } catch (e) {
    busy.close();
    ui.alert('匯出失敗', eng.errorMessage(e));
    return;
  }
  busy.close();
  await deliverFiles(files);
}

async function exportAll() {
  const photos = cur.photos || [];
  if (!photos.length) return;
  const edited = photos.filter((p) => p.edited).length;
  const v = await ui.dialog({
    title: '全部匯出',
    message: `共 ${photos.length} 張（已整理 ${edited} 張）。已整理的照片會匯出修好的版本${settings.watermark ? '，並加上「照片經整理示意」浮水印' : ''}。`,
    buttons: [
      { label: `匯出全部 ${photos.length} 張`, value: 'all', primary: true },
      ...(edited && edited < photos.length ? [{ label: `只匯出已整理的 ${edited} 張`, value: 'edited' }] : []),
      { label: '取消', value: null },
    ],
  });
  if (!v) return;
  const items = photos.map((p, i) => ({ photo: p, index: i + 1 }))
    .filter((it) => v === 'all' || it.photo.edited);
  await exportPhotos(items);
}

// =========================================================
// 修圖畫面
// =========================================================
const editor = new Editor($('#ed-stage'), $('#ed-view'), $('#ed-overlay'));

/**
 * 目前的修圖狀態
 * @type {null | {
 *   listingId:string, photoId:string, photo:any,
 *   history:Blob[], hIndex:number, savedIndex:number,
 *   engine:'local'|'gemini', busy:boolean, timer:any,
 *   compareCanvas:HTMLCanvasElement|null, holding:boolean
 * }}
 */
let ed = null;
/** 這次開啟 App 期間最後選的修圖方式 */
let sessionEngine = null;
let unsubModel = null;

const edEls = {
  save: $('#ed-save'),
  undo: $('#ed-undo'),
  redo: $('#ed-redo'),
  compare: $('#ed-compare'),
  declutter: $('#ed-declutter'),
  brush: $('#ed-brush'),
  brushDot: $('#ed-brush-dot'),
  busy: $('#ed-busy'),
  busyText: $('#ed-busy-text'),
  busyBar: $('#ed-busy-bar'),
  banner: $('#ed-banner'),
  hint: $('#ed-hint'),
  fit: $('#ed-fit'),
  compareTag: $('#ed-compare-tag'),
  seg: [...document.querySelectorAll('.seg [data-engine]')],
};

function isDirty() {
  return !!ed && ed.hIndex !== ed.savedIndex;
}

async function openEditor(listingId, photoId) {
  closeEditor();
  let photo;
  try { photo = await db.getPhoto(photoId); } catch (e) { ui.alert('讀取失敗', eng.errorMessage(e)); return false; }
  if (!photo) return false;
  if (!cur.listing || cur.listingId !== photo.listingId) {
    try { cur.listing = await db.getListing(photo.listingId); cur.listingId = photo.listingId; } catch { /* 忽略 */ }
  }

  showScreen('editor');
  const busy = ui.busy('開啟照片中…');
  try {
    const original = await db.getOriginal(photoId);
    if (!original) throw new Error('找不到這張照片的原圖資料');
    const edited = photo.edited ? await db.getEdited(photoId) : null;
    // 撤銷紀錄：第 0 格永遠是原圖，所以可以一路復原回原圖
    const history = edited ? [original, edited] : [original];
    const hIndex = history.length - 1;
    // 原圖已在匯入時限制 4096；保險起見再限制一次
    const { canvas } = await img.decodeToCanvas(history[hIndex], img.MAX_SIDE);
    ed = {
      listingId, photoId, photo,
      history, hIndex, savedIndex: hIndex,
      engine: sessionEngine || settings.defaultEngine,
      busy: false, timer: null,
      compareCanvas: null, holding: false,
    };
    editor.enabled = true;
    editor.setImage(canvas);
    edEls.hint.classList.remove('faded');
    setEngine(ed.engine, { silent: true });
    updateEditorUI();
    return true;
  } catch (e) {
    ui.alert('無法開啟照片', eng.errorMessage(e));
    ed = null;
    return false;
  } finally {
    busy.close();
  }
}

function closeEditor() {
  if (!ed) return;
  clearTimeout(ed.timer);
  if (unsubModel) { unsubModel(); unsubModel = null; }
  img.releaseCanvas(ed.compareCanvas);
  const working = editor.image;
  editor.release();
  img.releaseCanvas(working);
  ed = null;
  edEls.banner.hidden = true;
  edEls.busy.hidden = true;
}

function updateEditorUI() {
  if (!ed) return;
  const b = ed.busy;
  edEls.undo.disabled = b || ed.hIndex <= 0;
  edEls.redo.disabled = b || ed.hIndex >= ed.history.length - 1;
  edEls.compare.disabled = b;
  edEls.declutter.disabled = b;
  edEls.save.disabled = b;
  edEls.save.classList.toggle('dirty', isDirty());
  for (const s of edEls.seg) s.disabled = b;
}

/** 處理中遮罩（畫面上） */
function stageBusy(on, text, ratio = null) {
  edEls.busy.hidden = !on;
  if (!on) return;
  if (text) edEls.busyText.textContent = text;
  const bar = edEls.busyBar.parentElement;
  bar.classList.toggle('indeterminate', ratio == null);
  edEls.busyBar.style.width = ratio == null ? '' : Math.round(ratio * 100) + '%';
}

function stageProgress(fallback) {
  return (p) => {
    const d = eng.describeProgress(p, fallback);
    const pct = d.ratio != null ? `　${Math.round(d.ratio * 100)}%` : '';
    stageBusy(true, d.text + pct, d.ratio);
  };
}

// ---------- 修圖方式切換 ----------
function setEngine(engine, { silent = false } = {}) {
  if (!ed) return;
  ed.engine = engine;
  sessionEngine = engine;
  for (const s of edEls.seg) s.setAttribute('aria-checked', String(s.dataset.engine === engine));
  edEls.declutter.hidden = engine !== 'gemini';
  if (engine === 'local') {
    startModelPreload();
  } else {
    edEls.banner.hidden = true;
    if (!settings.apiKey && !silent) askForKey();
  }
  // 切換後，若還有塗抹沒處理，就用新的方式處理
  if (!silent && editor.hasMask()) scheduleRun();
}

async function askForKey() {
  const c = await ui.dialog({
    title: '強力模式需要金鑰',
    message: '請先到「設定」貼上 Google Gemini API 金鑰（免費申請）。\n也可以先用「免費（手機運算）」。',
    buttons: [
      { label: '前往設定', value: 'settings', primary: true },
      { label: '改用免費模式', value: 'local' },
    ],
  });
  if (c === 'settings') navigate({ screen: 'settings' });
  else if (c === 'local' || !settings.apiKey) setEngine('local', { silent: true });
}

// ---------- 本機模型預先下載 ----------
function startModelPreload() {
  if (!ed || ed.engine !== 'local') return;
  const status = eng.localModelStatus();
  if (status === 'ready') { edEls.banner.hidden = true; return; }
  const firstTime = !settings.modelLoadedOnce;
  const textEl = edEls.banner.querySelector('.ed-banner-text');
  const bar = edEls.banner.querySelector('.progress');
  const barFill = edEls.banner.querySelector('.progress-bar');
  const title = firstTime ? '首次使用需下載 AI 模型，約 30MB（只需一次）' : '正在準備 AI 模型…';

  edEls.banner.classList.remove('error');
  edEls.banner.onclick = null;
  textEl.textContent = title;
  bar.hidden = false;
  bar.classList.add('indeterminate');
  edEls.banner.hidden = false;

  if (unsubModel) unsubModel();
  unsubModel = eng.onModelProgress((p) => {
    if (!ed || ed.engine !== 'local') return;
    const d = eng.describeProgress(p, '準備中');
    if (d.ratio != null) {
      bar.classList.remove('indeterminate');
      barFill.style.width = Math.round(d.ratio * 100) + '%';
      textEl.textContent = `${title}　${Math.round(d.ratio * 100)}%`;
    }
  });

  eng.ensureLocalModel().then(() => {
    settings.modelLoadedOnce = true;
    if (unsubModel) { unsubModel(); unsubModel = null; }
    edEls.banner.hidden = true;
    if (firstTime && ed) ui.toast('AI 模型已就緒，之後不用再下載');
  }).catch((e) => {
    if (unsubModel) { unsubModel(); unsubModel = null; }
    if (!ed || ed.engine !== 'local') return;
    edEls.banner.classList.add('error');
    textEl.textContent = `AI 模型載入失敗：${eng.errorMessage(e)}（點這裡重試）`;
    bar.hidden = true;
    edEls.banner.hidden = false;
    edEls.banner.onclick = () => startModelPreload();
  });
}

// ---------- 塗抹後自動移除 ----------
editor.onStrokeStart = () => {
  if (ed) clearTimeout(ed.timer);
  edEls.hint.classList.add('faded');
};
editor.onStrokeEnd = () => scheduleRun();
editor.onViewChange = (atFit) => { edEls.fit.hidden = atFit; };

function scheduleRun() {
  if (!ed) return;
  clearTimeout(ed.timer);
  ed.timer = setTimeout(runRemoval, AUTO_RUN_DELAY);
}

async function runRemoval() {
  if (!ed || ed.busy || !editor.hasMask()) return;
  // 還有手指在畫面上（正在畫下一筆）就晚點再跑
  if (editor.pointers.size > 0) { scheduleRun(); return; }

  if (ed.engine === 'gemini' && !settings.apiKey) { askForKey(); return; }

  const session = ed;
  session.busy = true;
  editor.enabled = false;
  updateEditorUI();
  stageBusy(true, '準備中…');
  try {
    let result;
    const source = editor.image;
    const mask = editor.getMask();
    if (session.engine === 'local') {
      if (eng.localModelStatus() !== 'ready') {
        const off = eng.onModelProgress(stageProgress('下載 AI 模型中（第一次約 30MB）'));
        stageBusy(true, '準備 AI 模型中…');
        try { await eng.ensureLocalModel(); } finally { off(); }
        settings.modelLoadedOnce = true;
        edEls.banner.hidden = true;
      }
      const mod = await eng.getLocalEngine();
      stageBusy(true, 'AI 正在移除雜物…');
      result = await mod.inpaintLocal(source, mask, stageProgress('AI 正在移除雜物…'));
    } else {
      const g = await eng.getGeminiEngine();
      stageBusy(true, '傳送到 Gemini 處理中…');
      result = await g.inpaintGemini(source, mask, {
        apiKey: settings.apiKey,
        onProgress: stageProgress('Gemini 處理中…'),
      });
    }
    if (ed !== session) return; // 處理期間已離開畫面
    await commitResult(result);
  } catch (e) {
    console.error(e);
    if (ed === session) {
      editor.clearMask();
      ui.alert('移除失敗', eng.errorMessage(e) + '\n\n塗抹已清除，可以重新塗一次再試。');
    }
  } finally {
    session.busy = false;
    if (ed === session) {
      editor.enabled = true;
      stageBusy(false);
      updateEditorUI();
    }
  }
}

/** 把 AI 結果變成新的工作影像，並加入撤銷紀錄 */
async function commitResult(resultCanvas) {
  if (!resultCanvas || !resultCanvas.width) throw new Error('AI 沒有傳回結果，請再試一次');
  stageBusy(true, '套用結果…');
  const blob = await img.canvasToBlob(resultCanvas, 'image/jpeg', 0.92);
  // 有「重做」的紀錄就丟掉
  ed.history = ed.history.slice(0, ed.hIndex + 1);
  ed.history.push(blob);
  // 上限：保留第 0 格原圖，丟掉最舊的修改
  while (ed.history.length > HISTORY_LIMIT) {
    ed.history.splice(1, 1);
    if (ed.savedIndex === 1) ed.savedIndex = -1; // 已儲存的那格被丟掉 → 視為未儲存
    else if (ed.savedIndex > 1) ed.savedIndex--;
  }
  ed.hIndex = ed.history.length - 1;

  const old = editor.image;
  editor.setImage(resultCanvas, { keepView: true });
  if (old && old !== resultCanvas) img.releaseCanvas(old);
}

// ---------- 復原 / 重做 ----------
async function stepHistory(delta) {
  if (!ed || ed.busy) return;
  const ni = ed.hIndex + delta;
  if (ni < 0 || ni >= ed.history.length) return;
  clearTimeout(ed.timer);
  const session = ed;
  session.busy = true;
  updateEditorUI();
  try {
    const { canvas } = await img.decodeToCanvas(session.history[ni], img.MAX_SIDE);
    if (ed !== session) { img.releaseCanvas(canvas); return; }
    const old = editor.image;
    editor.setImage(canvas, { keepView: true });
    img.releaseCanvas(old);
    session.hIndex = ni;
    ui.toast(ni === 0 ? '已回到原圖' : (delta < 0 ? '已復原' : '已重做'), 1200);
  } catch (e) {
    ui.alert('操作失敗', eng.errorMessage(e));
  } finally {
    session.busy = false;
    updateEditorUI();
  }
}

// ---------- 按住看原圖 ----------
async function compareStart(e) {
  if (!ed || ed.busy) return;
  e.preventDefault();
  try { edEls.compare.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  ed.holding = true;
  edEls.compare.classList.add('pressed');
  const session = ed;
  if (!session.compareCanvas) {
    try {
      // 比較用的原圖只需要螢幕解析度，省記憶體
      const { canvas } = await img.decodeToCanvas(session.history[0], 2048);
      if (ed !== session) { img.releaseCanvas(canvas); return; }
      session.compareCanvas = canvas;
    } catch (err) { console.error(err); return; }
  }
  if (ed === session && session.holding) {
    editor.setCompare(session.compareCanvas);
    edEls.compareTag.hidden = false;
  }
}
function compareEnd() {
  if (!ed) return;
  ed.holding = false;
  edEls.compare.classList.remove('pressed');
  editor.setCompare(null);
  edEls.compareTag.hidden = true;
}

// ---------- 一鍵整理（Gemini，不需塗抹） ----------
async function declutterFlow() {
  if (!ed || ed.busy) return;
  if (!settings.apiKey) { askForKey(); return; }
  const ok = await ui.dialog({
    title: '一鍵整理',
    message: '會由 Gemini 重新產生整張照片，自動收掉雜物。細節可能會有變化，完成後請仔細檢查。\n\n提醒：壁癌、漏水、裂縫、窗外設施等不可以被修掉，如果被改到請按「復原」。',
    buttons: [
      { label: '開始整理', value: true, primary: true },
      { label: '取消', value: false },
    ],
  });
  if (ok !== true || !ed) return;
  clearTimeout(ed.timer);
  editor.clearMask();
  const session = ed;
  session.busy = true;
  editor.enabled = false;
  updateEditorUI();
  stageBusy(true, '傳送到 Gemini 處理中…');
  try {
    const g = await eng.getGeminiEngine();
    const result = await g.declutterGemini(editor.image, {
      apiKey: settings.apiKey,
      onProgress: stageProgress('Gemini 整理中…（約 10–30 秒）'),
    });
    if (ed !== session) return;
    await commitResult(result);
    ui.toast('整理完成，請檢查結果；不滿意可按「復原」', 3500);
  } catch (e) {
    console.error(e);
    if (ed === session) ui.alert('一鍵整理失敗', eng.errorMessage(e));
  } finally {
    session.busy = false;
    if (ed === session) {
      editor.enabled = true;
      stageBusy(false);
      updateEditorUI();
    }
  }
}

// ---------- 儲存 ----------
/** 儲存目前結果到案件（原圖不動）。成功回傳 true */
async function saveEdit() {
  if (!ed) return false;
  if (ed.busy) { ui.toast('AI 處理中，請稍候'); return false; }
  if (!isDirty()) return true;
  const busy = ui.busy('儲存中…');
  try {
    if (ed.hIndex === 0) {
      // 復原到原圖 → 移除修圖結果
      await db.saveEdited(ed.photoId, null, null);
    } else {
      const blob = ed.history[ed.hIndex]; // 已是 JPEG 0.92
      const thumb = await img.makeThumb(editor.image);
      await db.saveEdited(ed.photoId, blob, thumb);
    }
    ed.savedIndex = ed.hIndex;
    updateEditorUI();
    return true;
  } catch (e) {
    ui.alert('儲存失敗', eng.errorMessage(e));
    return false;
  } finally {
    busy.close();
  }
}

async function saveAndLeave() {
  if (!ed) return;
  if (editor.hasMask() && !ed.busy) {
    // 還有塗了但沒處理的區域 → 先處理
    clearTimeout(ed.timer);
    await runRemoval();
    if (!ed) return;
  }
  const wasDirty = isDirty();
  if (!(await saveEdit())) return;
  if (wasDirty) ui.toast('已儲存 ✓');
  goBack();
}

// ---------- 綁定修圖畫面按鈕 ----------
function bindEditor() {
  edEls.seg.forEach((b) => b.addEventListener('click', () => {
    if (!ed || ed.busy || ed.engine === b.dataset.engine) return;
    setEngine(b.dataset.engine);
  }));
  edEls.save.addEventListener('click', saveAndLeave);
  edEls.undo.addEventListener('click', () => stepHistory(-1));
  edEls.redo.addEventListener('click', () => stepHistory(1));
  edEls.declutter.addEventListener('click', declutterFlow);
  edEls.fit.addEventListener('click', () => editor.fit());

  const cmp = edEls.compare;
  cmp.addEventListener('pointerdown', compareStart);
  cmp.addEventListener('pointerup', compareEnd);
  cmp.addEventListener('pointercancel', compareEnd);
  cmp.addEventListener('lostpointercapture', compareEnd);
  cmp.addEventListener('contextmenu', (e) => e.preventDefault());
  // 鍵盤：按住空白鍵
  cmp.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); compareStart(e); } });
  cmp.addEventListener('keyup', (e) => { if (e.key === ' ') compareEnd(); });

  // 筆刷大小
  const applyBrush = () => {
    const v = Number(edEls.brush.value);
    editor.setBrush(v);
    const dot = Math.max(8, Math.min(40, v * 0.4 + 4));
    edEls.brushDot.style.width = edEls.brushDot.style.height = dot + 'px';
  };
  edEls.brush.value = String(settings.brushSize);
  applyBrush();
  edEls.brush.addEventListener('input', () => { applyBrush(); editor.setBrushPreview(true); });
  const endPreview = () => { editor.setBrushPreview(false); settings.brushSize = Number(edEls.brush.value); };
  edEls.brush.addEventListener('change', endPreview);
  edEls.brush.addEventListener('pointerup', endPreview);
  edEls.brush.addEventListener('blur', endPreview);
}

// =========================================================
// 設定
// =========================================================
async function openSettings() {
  showScreen('settings');
  $('#set-apikey').value = settings.apiKey;
  $('#set-apikey').type = 'password';
  $('#set-apikey-show').textContent = '顯示';
  $('#set-apikey-result').textContent = '';
  $('#set-apikey-result').className = 'key-result';
  $('#set-watermark').checked = settings.watermark;
  for (const r of document.querySelectorAll('input[name="default-engine"]')) r.checked = r.value === settings.defaultEngine;
  renderAbout();
}

async function renderAbout() {
  const parts = [];
  parts.push(db.storageMode === 'idb' ? '照片儲存在這支手機的瀏覽器裡。' : '⚠ 目前無法使用手機儲存空間，關閉 App 後照片會消失。');
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const mb = (n) => (n / 1048576).toFixed(0);
      parts.push(`已使用約 ${mb(usage)} MB${quota ? `（可用上限約 ${(quota / 1073741824).toFixed(1)} GB）` : ''}。`);
    }
  } catch { /* 忽略 */ }
  if (eng.localModelStatus() === 'ready') {
    const info = await eng.localEngineInfo();
    if (info) parts.push(`本機 AI：${info.name || '已載入'}（${info.backend === 'webgpu' ? 'WebGPU 加速' : 'WASM'}）。`);
  }
  $('#about-info').textContent = parts.join(' ');
}

function bindSettings() {
  const key = $('#set-apikey');
  const result = $('#set-apikey-result');
  key.addEventListener('input', () => { settings.apiKey = key.value; result.textContent = ''; result.className = 'key-result'; });
  $('#set-apikey-show').addEventListener('click', (e) => {
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? '隱藏' : '顯示';
  });
  $('#set-apikey-clear').addEventListener('click', async () => {
    if (!key.value) return;
    if (!(await ui.confirm('清除金鑰？', '清除後強力模式就不能用了，需要再貼一次。', { okLabel: '清除', danger: true }))) return;
    key.value = '';
    settings.apiKey = '';
    result.textContent = '已清除';
    result.className = 'key-result';
  });
  $('#set-apikey-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const k = key.value.trim();
    if (!k) { result.textContent = '請先貼上金鑰'; result.className = 'key-result fail'; return; }
    settings.apiKey = k;
    btn.disabled = true;
    result.textContent = '測試中…';
    result.className = 'key-result';
    try {
      const g = await eng.getGeminiEngine();
      const r = await g.testGeminiKey(k);
      const ok = !!(r && r.ok);
      result.textContent = (ok ? '✓ ' : '✗ ') + ((r && r.message) || (ok ? '金鑰可以使用' : '金鑰無法使用'));
      result.className = 'key-result ' + (ok ? 'ok' : 'fail');
    } catch (err) {
      result.textContent = '✗ ' + eng.errorMessage(err);
      result.className = 'key-result fail';
    } finally {
      btn.disabled = false;
    }
  });
  $('#set-watermark').addEventListener('change', (e) => {
    settings.watermark = e.currentTarget.checked;
    ui.toast(settings.watermark ? '匯出時會加上浮水印' : '匯出時不加浮水印');
  });
  for (const r of document.querySelectorAll('input[name="default-engine"]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      settings.defaultEngine = r.value;
      sessionEngine = r.value;
      if (r.value === 'gemini' && !settings.apiKey) ui.toast('記得在下方貼上 Gemini 金鑰');
    });
  }
  $('#compliance-text').replaceChildren(complianceNode());
}

// =========================================================
// 首頁與照片牆按鈕
// =========================================================
function bindMain() {
  $('#btn-settings').addEventListener('click', () => navigate({ screen: 'settings' }));
  $('#btn-new-listing').addEventListener('click', newListingFlow);
  $('#listing-title').addEventListener('click', () => cur.listing && renameListingFlow(cur.listing));
  $('#btn-listing-more').addEventListener('click', async () => {
    if (!cur.listing) return;
    const v = await ui.actionSheet(cur.listing.name, [
      { label: '重新命名', value: 'rename' },
      { label: '全部匯出', value: 'export' },
      { label: '刪除案件', value: 'delete', danger: true },
    ]);
    if (v === 'rename') renameListingFlow(cur.listing);
    if (v === 'export') exportAll();
    if (v === 'delete') deleteListingFlow({ ...cur.listing, count: cur.photos.length });
  });
  const inPhotos = $('#input-photos');
  const inCamera = $('#input-camera');
  $('#btn-add-photos').addEventListener('click', () => inPhotos.click());
  $('#btn-take-photo').addEventListener('click', () => inCamera.click());
  for (const input of [inPhotos, inCamera]) {
    input.addEventListener('change', async () => {
      const files = input.files;
      await importFiles(files);
      input.value = ''; // 讓同一張可以再選一次
    });
  }
  $('#btn-export-all').addEventListener('click', exportAll);
}

// =========================================================
// 啟動
// =========================================================
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // 先確認 sw.js 存在，避免 404 時在主控台噴錯
    const r = await fetch('./sw.js', { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return;
    await navigator.serviceWorker.register('./sw.js');
  } catch (e) {
    console.info('Service worker 未註冊：', e && e.message);
  }
}

async function showFirstLaunchNotice() {
  if (settings.noticeSeen) return;
  await ui.dialog({
    title: '使用前請注意',
    content: complianceNode(),
    dismissible: false,
    buttons: [{ label: '我知道了', value: true, primary: true }],
  });
  settings.noticeSeen = true;
}

async function init() {
  bindMain();
  bindEditor();
  bindSettings();

  const { mode } = await db.initDB();
  if (mode === 'memory') {
    const w = $('#storage-warning');
    w.textContent = '⚠ 無法使用手機儲存空間（可能是無痕模式或空間已滿）。照片仍可修圖、匯出，但關閉 App 後會消失，請記得先匯出。';
    w.hidden = false;
  }

  history.replaceState({ screen: 'home' }, '');
  await openHome();
  registerSW();
  showFirstLaunchNotice();
}

init().catch((e) => {
  console.error(e);
  ui.alert('啟動失敗', eng.errorMessage(e));
});
