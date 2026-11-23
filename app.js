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
import { showError, configureErrors, installGlobalHandlers, MEMORY_HINT } from './lib/errors.js';
import { showTutorial } from './lib/tutorial.js';
import * as aiui from './lib/aiui.js';

/** App 版本（設定頁最下方會顯示，用來確認手機是不是跑新版） */
const APP_VERSION = '1.2.0';

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
/** 修圖工作尺寸上限（記憶體不足時會降到 1920，這次開啟期間都用小尺寸） */
let workMax = img.MAX_SIDE;

// 錯誤回報：技術資訊裡附上目前狀態
installGlobalHandlers();
configureErrors({
  appVersion: APP_VERSION,
  context: () => {
    const o = { 畫面: cur.screen, 儲存方式: db.storageMode, 工作尺寸上限: workMax };
    if (editor && editor.image) o.照片尺寸 = `${editor.image.width}×${editor.image.height}`;
    if (ed) o.修圖方式 = ed.engine === 'gemini' ? 'Gemini' : '本機';
    o.本機AI狀態 = eng.localModelStatus();
    const info = eng.localEngineInfoSync();
    if (info) o.本機AI = `${info.name || ''} / ${info.backend || ''}${info.ortVersion ? ' / ort ' + info.ortVersion : ''}`;
    return o;
  },
});

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
      if (ed && ed.photoId === s.photoId) { showScreen('editor'); editor.resize(); refreshModelUI(); }
      else if (!(await openEditor(s.listingId, s.photoId))) {
        return navigate(db.isValidId(s.listingId) ? { screen: 'listing', listingId: s.listingId } : { screen: 'home' }, { replace: true });
      }
      break;
    case 'settings':
      await openSettings();
      break;
    default:
      await openHome();
  }
  maybeReloadForUpdate();
}

/** 返回（畫面左上角的返回鍵） */
function goBack() {
  if (history.state && history.state.screen && history.state.screen !== 'home') history.back();
  else navigate({ screen: 'home' }, { replace: true });
}

window.addEventListener('popstate', async (e) => {
  const s = e.state || { screen: 'home' };
  // 全部一鍵清除進行中：不能離開
  if (batchRunning) {
    history.pushState(stateNow(), '');
    ui.toast('AI 處理中，請稍候');
    return;
  }
  // 修圖中離開的保護
  if (cur.screen === 'editor' && ed && s.screen !== 'editor' && s.screen !== 'settings') {
    if (ed.busy) {
      history.pushState(stateNow(), '');
      ui.toast('AI 處理中，請稍候');
      return;
    }
    if (isDirty() || hasPendingMask()) {
      history.pushState(stateNow(), '');
      if (!(await confirmLeave())) return;
      if (ed) { ed.savedIndex = ed.hIndex; editor.clearMask(); } // 標記為不需再問
      history.back();
      return;
    }
  }
  try { await applyState(s); }
  catch (err) { showError('畫面切換失敗', err); }
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
  cur.listingId = null;
  cur.listing = null;
  cur.photos = [];
  revokeBucket('listing');
  await renderHome();
}

async function renderHome() {
  const list = $('#listing-list');
  revokeBucket('home');
  let items = [];
  try { items = await db.listListings(); }
  catch (e) { showError('讀取案件失敗', e); }

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
    showError('建立失敗', e);
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
  } catch (e) { showError('重新命名失敗', e); }
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
  } catch (e) { showError('刪除失敗', e); }
}

// =========================================================
// 照片牆
// =========================================================
async function openListing(listingId) {
  if (!db.isValidId(listingId)) return false;
  let l = null;
  try { l = await db.getListing(listingId); } catch (e) { showError('讀取失敗', e); }
  if (!l) return false;
  cur.listingId = l.id;
  cur.listing = l;
  $('#listing-title').textContent = l.name;
  showScreen('listing');
  revokeBucket('home');
  await renderPhotos();
  // 一打開案件就先在背景準備 AI，進修圖畫面時就不用等
  preloadModel();
  return true;
}

async function renderPhotos() {
  const grid = $('#photo-grid');
  revokeBucket('listing');
  let photos = [];
  try { photos = await db.listPhotos(cur.listingId); }
  catch (e) { showError('讀取照片失敗', e); }
  cur.photos = photos;

  grid.replaceChildren(...photos.map((p, i) => photoTile(p, i)));
  $('#listing-empty').hidden = photos.length > 0;
  const edited = photos.filter((p) => p.edited).length;
  $('#listing-summary').textContent = photos.length
    ? `共 ${photos.length} 張，已整理 ${edited} 張。點照片開始修圖。`
    : '';
  $('#btn-export-all').disabled = photos.length === 0;
  $('#btn-batch-ai').disabled = photos.length === 0 || edited === photos.length;
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
    catch (e) { showError('恢復失敗', e); }
  }
  if (v === 'delete') {
    const ok = await ui.confirm('刪除這張照片？', '原圖和修好的照片都會從這支手機刪除，無法復原。', { okLabel: '刪除', danger: true });
    if (!ok) return;
    try { await db.deletePhoto(p.id); ui.toast('已刪除'); await renderPhotos(); }
    catch (e) { showError('刪除失敗', e); }
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let persistAsked = false;
async function importFiles(fileList) {
  const files = [...(fileList || [])].filter((f) => !f.type || f.type.startsWith('image/'));
  if (!files.length) return;
  // 一定要在某個案件裡才能加照片
  const listingId = cur.listingId;
  if (cur.screen !== 'listing' || !db.isValidId(listingId)) {
    ui.alert('請先開啟案件', '請回到首頁，點一個案件（或按「新增案件」），再加入照片。');
    return;
  }
  if (!persistAsked) { persistAsked = true; db.requestPersist(); }
  const busy = ui.busy('加入照片中…');
  let ok = 0;
  const failed = [];
  try {
    // 一張一張處理，處理完立刻釋放記憶體（iOS 一次處理多張容易記憶體不足）
    for (let i = 0; i < files.length; i++) {
      busy.update(files.length > 1 ? `加入照片中 ${i + 1} / ${files.length}` : '加入照片中…');
      try {
        const data = await img.importPhotoFile(files[i]);
        await db.addPhoto(listingId, data);
        ok++;
      } catch (e) {
        console.error(e);
        failed.push(e);
        // 空間不足、或案件不見了，就不要再試後面的
        if (e && (e.code === 'STORAGE_FULL' || e.code === 'NO_LISTING')) break;
      }
      await tick(30); // 讓瀏覽器有機會回收記憶體
    }
  } finally {
    busy.close();
  }
  if (cur.screen === 'listing' && cur.listingId === listingId) await renderPhotos();
  if (failed.length) {
    showError(ok ? `已加入 ${ok} 張，${failed.length} 張失敗` : '加入照片失敗', failed[0]);
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
      await tick(0);
    }
  } catch (e) {
    busy.close();
    showError('匯出失敗', e);
    return;
  }
  busy.close();
  try { await deliverFiles(files); }
  catch (e) { showError('匯出失敗', e); }
}

async function exportAll() {
  const photos = cur.photos || [];
  if (!photos.length) return;
  const edited = photos.filter((p) => p.edited).length;
  const v = await ui.dialog({
    title: '全部匯出',
    message: `共 ${photos.length} 張（已整理 ${edited} 張）。已整理的照片會匯出修好的版本${settings.watermark ? '，並加上浮水印（「照片經整理示意」或「AI 整理示意」）' : ''}。`,
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
// AI 模型預先準備（照片牆與修圖畫面共用的「AI 準備中 x%」細條）
// =========================================================
function makeStrip(el) {
  return { el, text: el.querySelector('.ai-text'), prog: el.querySelector('.progress'), fill: el.querySelector('.progress-bar') };
}
const strips = { listing: makeStrip($('#listing-ai')), editor: makeStrip($('#ed-banner')) };

/** 目前想用的是不是本機 AI */
function wantLocal() {
  return (ed ? ed.engine : (sessionEngine || settings.defaultEngine)) === 'local';
}

function setStrip(s, visible, text, ratio, isError) {
  s.el.hidden = !visible;
  if (!visible) return;
  s.el.classList.toggle('error', !!isError);
  s.text.textContent = text;
  s.prog.hidden = !!isError;
  s.prog.classList.toggle('indeterminate', ratio == null);
  s.fill.style.width = ratio == null ? '' : Math.round(ratio * 100) + '%';
}

let modelUIRaf = 0;
function refreshModelUI() {
  if (modelUIRaf) return;
  modelUIRaf = requestAnimationFrame(() => {
    modelUIRaf = 0;
    const st = eng.modelState();
    const show = wantLocal() && (st.status === 'loading' || st.status === 'error');
    let text = '';
    let ratio = null;
    const err = st.status === 'error';
    if (err) text = '⚠ AI 準備失敗，點這裡看原因／重試';
    else {
      ratio = st.ratio;
      const pct = ratio != null ? `　${Math.round(ratio * 100)}%` : '';
      text = (settings.modelLoadedOnce ? 'AI 準備中' : 'AI 準備中（第一次需下載約 30MB，只需一次）') + pct;
    }
    setStrip(strips.listing, show && cur.screen === 'listing', text, ratio, err);
    setStrip(strips.editor, show && cur.screen === 'editor', text, ratio, err);
  });
}
eng.onModelProgress(() => refreshModelUI());

/** 在背景開始準備本機 AI（已準備好或準備中就不重複） */
function preloadModel() {
  refreshModelUI();
  if (!wantLocal()) return;
  const status = eng.localModelStatus();
  if (status === 'ready' || status === 'loading') return;
  const firstTime = !settings.modelLoadedOnce;
  eng.ensureLocalModel().then(() => {
    settings.modelLoadedOnce = true;
    refreshModelUI();
    if (firstTime) ui.toast('AI 已準備好，之後不用再下載');
  }).catch((e) => {
    console.error('AI 預先準備失敗', e);
    refreshModelUI();
  });
}

async function modelErrorClicked() {
  const st = eng.modelState();
  if (st.status !== 'error') return;
  const v = await showError('AI 準備失敗', st.error, {
    hint: '請確認網路連線。' + (eng.isMemoryError(st.error) ? '\n' + MEMORY_HINT : ''),
    buttons: [
      { label: '重試', value: 'retry', primary: true },
      { label: '關閉', value: null },
    ],
  });
  if (v === 'retry') preloadModel();
}
for (const s of Object.values(strips)) s.el.addEventListener('click', modelErrorClicked);

// =========================================================
// 修圖畫面
// =========================================================
const editor = new Editor($('#ed-stage'), $('#ed-view'), $('#ed-overlay'));

/**
 * 目前的修圖狀態
 * @type {null | {
 *   listingId:string, photoId:string, photo:any,
 *   history:Blob[], hAI:boolean[], hIndex:number, savedIndex:number,
 *   engine:'local'|'gemini', busy:boolean,
 *   compareCanvas:HTMLCanvasElement|null, holding:boolean
 * }}
 */
let ed = null;
/** 這次開啟 App 期間最後選的修圖方式 */
let sessionEngine = null;

const edEls = {
  save: $('#ed-save'),
  undo: $('#ed-undo'),
  redo: $('#ed-redo'),
  compare: $('#ed-compare'),
  clear: $('#ed-clear'),
  oneclick: $('#ed-oneclick'),
  remove: $('#ed-remove'),
  brush: $('#ed-brush'),
  brushDot: $('#ed-brush-dot'),
  busy: $('#ed-busy'),
  busyText: $('#ed-busy-text'),
  busyBar: $('#ed-busy-bar'),
  hint: $('#ed-hint'),
  fit: $('#ed-fit'),
  compareTag: $('#ed-compare-tag'),
  prev: $('#ed-prev'),
  next: $('#ed-next'),
  counter: $('#ed-counter'),
  help: $('#ed-help'),
  seg: [...document.querySelectorAll('.seg [data-engine]')],
  tools: [...document.querySelectorAll('.mode-seg [data-tool]')],
};

function isDirty() {
  return !!ed && ed.hIndex !== ed.savedIndex;
}

/** 有塗抹但還沒按「移除」 */
function hasPendingMask() {
  return !!ed && editor.hasMask() && !editor.maskIsEmpty();
}

/** 要離開這張照片前的確認。可以離開就回傳 true */
async function confirmLeave() {
  if (!ed) return true;
  if (isDirty()) {
    const choice = await ui.dialog({
      title: '修改還沒儲存',
      message: '要先儲存這張照片的修改嗎？',
      buttons: [
        { label: '儲存', value: 'save', primary: true },
        { label: '不儲存', value: 'discard', dangerText: true },
        { label: '繼續修圖', value: null },
      ],
    });
    if (choice === 'save') return saveEdit();
    return choice === 'discard';
  }
  if (hasPendingMask()) {
    return ui.confirm('塗抹的地方還沒移除', '離開後，紅色塗抹會消失。確定要離開嗎？', { okLabel: '離開', cancelLabel: '繼續修圖' });
  }
  return true;
}

async function openEditor(listingId, photoId) {
  closeEditor();
  if (!db.isValidId(photoId)) return false;
  let photo;
  try { photo = await db.getPhoto(photoId); } catch (e) { showError('讀取失敗', e); return false; }
  if (!photo) { ui.toast('找不到這張照片'); return false; }
  if (!cur.listing || cur.listingId !== photo.listingId || !cur.photos.length) {
    try {
      cur.listing = await db.getListing(photo.listingId);
      cur.listingId = photo.listingId;
      cur.photos = await db.listPhotos(photo.listingId);
    } catch { /* 忽略：只影響上一張／下一張 */ }
  }

  showScreen('editor');
  const busy = ui.busy('開啟照片中…');
  let canvas = null;
  try {
    const original = await db.getOriginal(photoId);
    if (!original) throw new Error('找不到這張照片的原圖資料');
    const edited = photo.edited ? await db.getEdited(photoId) : null;
    // 撤銷紀錄（存成 Blob，不佔 canvas 記憶體）：第 0 格永遠是原圖，所以可以一路復原回原圖
    const history = edited ? [original, edited] : [original];
    // 每一格是否含 Gemini 產生的內容（決定匯出浮水印文字）
    const hAI = edited ? [false, !!photo.aiGenerated] : [false];
    const hIndex = history.length - 1;
    // 舊版存的照片可能是 4096，這裡縮到工作尺寸（2560）再修
    ({ canvas } = await img.decodeToCanvas(history[hIndex], workMax));
    editor.enabled = true;
    editor.setImage(canvas);
    ed = {
      listingId: photo.listingId, photoId, photo,
      history, hAI, hIndex, savedIndex: hIndex,
      engine: sessionEngine || settings.defaultEngine,
      busy: false,
      compareCanvas: null, holding: false,
    };
    canvas = null;
    edEls.hint.classList.remove('faded');
    setTool('paint');
    setEngine(ed.engine, { silent: true });
    updateNav();
    updateEditorUI();
    if (!settings.tutorialSeen) {
      settings.tutorialSeen = true;
      showTutorial();
    }
    return true;
  } catch (e) {
    if (canvas) img.releaseCanvas(canvas);
    const working = editor.image;
    editor.release();
    img.releaseCanvas(working);
    ed = null;
    showError('無法開啟照片', e);
    return false;
  } finally {
    busy.close();
  }
}

function closeEditor() {
  if (!ed) return;
  img.releaseCanvas(ed.compareCanvas);
  ed.compareCanvas = null;
  const working = editor.image;
  editor.release();
  img.releaseCanvas(working);
  ed = null;
  edEls.busy.hidden = true;
  edEls.compareTag.hidden = true;
  refreshModelUI();
}

/** 這張在案件中的位置 */
function photoIndex() {
  if (!ed) return -1;
  return (cur.photos || []).findIndex((p) => p.id === ed.photoId);
}

function updateNav() {
  const list = cur.photos || [];
  const i = photoIndex();
  const b = !ed || ed.busy;
  edEls.counter.textContent = i >= 0 ? `${i + 1} / ${list.length}` : '';
  edEls.prev.disabled = b || i <= 0;
  edEls.next.disabled = b || i < 0 || i >= list.length - 1;
}

function updateEditorUI() {
  if (!ed) return;
  const b = ed.busy;
  const painted = editor.hasMask();
  edEls.undo.disabled = b || (!editor.strokes.length && ed.hIndex <= 0);
  edEls.redo.disabled = b || painted || ed.hIndex >= ed.history.length - 1;
  edEls.compare.disabled = b;
  edEls.clear.disabled = b || !editor.strokes.length;
  edEls.oneclick.disabled = b;
  edEls.remove.disabled = b || !painted;
  edEls.remove.textContent = painted ? '✨ 移除' : '先塗抹要移除的東西';
  edEls.save.disabled = b;
  edEls.save.classList.toggle('dirty', isDirty());
  for (const s of edEls.seg) s.disabled = b;
  for (const t of edEls.tools) t.disabled = b;
  updateNav();
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

// ---------- 塗抹／橡皮擦 ----------
function setTool(t) {
  editor.setTool(t);
  for (const b of edEls.tools) b.setAttribute('aria-checked', String(b.dataset.tool === editor.tool));
}

// ---------- 修圖方式切換 ----------
function setEngine(engine, { silent = false } = {}) {
  if (!ed) return;
  ed.engine = engine;
  sessionEngine = engine;
  for (const s of edEls.seg) s.setAttribute('aria-checked', String(s.dataset.engine === engine));
  if (engine === 'local') preloadModel();
  else if (!settings.apiKey && !silent) askForKey();
  refreshModelUI();
}

async function askForKey() {
  const c = await ui.dialog({
    title: '強力模式需要金鑰',
    message: '需要先設定 Google Gemini 金鑰（約 3 分鐘，一步一步教你）。\n也可以先用「免費（手機運算）」。',
    buttons: [
      { label: '開始設定', value: 'wizard', primary: true },
      { label: '改用免費模式', value: 'local' },
    ],
  });
  if (c === 'wizard') {
    if (!(await aiui.keyWizard()) && !settings.apiKey) setEngine('local', { silent: true });
  } else if (c === 'local' || !settings.apiKey) setEngine('local', { silent: true });
}

// ---------- 塗抹（不會自動移除，要按「✨ 移除」） ----------
editor.onStrokeStart = () => { edEls.hint.classList.add('faded'); };
editor.onStrokeEnd = () => updateEditorUI();
editor.onMaskChange = () => updateEditorUI();
editor.onViewChange = (atFit) => { edEls.fit.hidden = atFit; };

/** 執行移除。成功回傳 true */
async function runRemoval() {
  if (!ed || ed.busy) return false;
  if (!editor.hasMask() || editor.maskIsEmpty()) {
    ui.toast('請先用手指把要移除的東西塗成紅色');
    return false;
  }
  if (ed.engine === 'gemini' && !settings.apiKey) { askForKey(); return false; }

  const session = ed;
  session.busy = true;
  editor.enabled = false;
  updateEditorUI();
  stageBusy(true, '準備中…');
  let failure = null;
  let ok = false;
  try {
    let result;
    if (session.engine === 'local') {
      if (eng.localModelStatus() !== 'ready') {
        // AI 還沒準備好：顯示進度，準備好後自動繼續
        const off = eng.onModelProgress(stageProgress('AI 準備中（準備好會自動開始）'));
        stageBusy(true, 'AI 準備中（準備好會自動開始）…');
        try { await eng.ensureLocalModel(); } finally { off(); }
        settings.modelLoadedOnce = true;
        refreshModelUI();
        if (ed !== session) return false;
      }
      const mod = await eng.getLocalEngine();
      stageBusy(true, 'AI 正在移除雜物…');
      result = await mod.inpaintLocal(editor.image, editor.getMask(), stageProgress('AI 正在移除雜物…'));
    } else {
      if (!(await aiui.capOk(1))) return false;
      if (ed !== session) return false;
      const g = await eng.getGeminiEngine();
      stageBusy(true, '傳送到 Gemini 處理中…');
      result =await g.inpaintGemini(editor.image, editor.getMask(), {
        apiKey: settings.apiKey,
        onProgress: stageProgress('Gemini 處理中…'),
      });
    }
    if (ed !== session) { if (result) img.releaseCanvas(result); return false; } // 處理期間已離開畫面
    if (session.engine === 'gemini') aiui.recordUsage(1);
    await commitResult(result);
    ok = true;
  } catch (e) {
    failure = e;
  } finally {
    session.busy = false;
    if (ed === session) {
      editor.enabled = true;
      stageBusy(false);
      updateEditorUI();
    }
  }
  if (failure && ed === session) await handleRemovalError(failure);
  return ok;
}

/** 移除失敗：顯示原因；記憶體不足時提供「用較小尺寸再試」 */
async function handleRemovalError(e) {
  console.error(e);
  if (!ed) return;
  if (ed.engine === 'gemini' && await aiui.keyIssueDialog(e)) return;
  const canShrink = ed.engine === 'local' && eng.isMemoryError(e) && editor.image
    && Math.max(editor.image.width, editor.image.height) > img.SMALL_SIDE;
  if (canShrink) {
    const v = await showError('移除失敗', e, {
      hint: MEMORY_HINT + '\n\n也可以改用較小的尺寸（1920）再試一次，上架畫質仍然足夠。',
      buttons: [
        { label: '用較小尺寸再試一次', value: 'small', primary: true },
        { label: '取消', value: null },
      ],
    });
    if (v !== 'small' || !ed) return;
    workMax = img.SMALL_SIDE;
    try { editor.downscaleTo(img.SMALL_SIDE); }
    catch (err) { showError('無法縮小照片', err); return; }
    // 原圖預覽也一起丟掉，之後用小尺寸重新產生
    img.releaseCanvas(ed.compareCanvas);
    ed.compareCanvas = null;
    runRemoval();
    return;
  }
  const v = await showError('移除失敗', e, {
    hint: (eng.isMemoryError(e) ? MEMORY_HINT + '\n\n' : '') + '紅色塗抹還保留著，可以直接再試一次。',
    buttons: [
      { label: '再試一次', value: 'retry', primary: true },
      { label: '關閉', value: null },
    ],
  });
  if (v === 'retry' && ed) runRemoval();
}

/** 把 AI 結果變成新的工作影像，並加入撤銷紀錄 */
async function commitResult(resultCanvas) {
  if (!resultCanvas || !resultCanvas.width) throw new Error('AI 沒有傳回結果，請再試一次');
  stageBusy(true, '套用結果…');
  const blob = await img.canvasToBlob(resultCanvas, 'image/jpeg', 0.92);
  pushHistory(blob, ed.engine === 'gemini');

  const old = editor.image;
  editor.setImage(resultCanvas, { keepView: true });
  if (old && old !== resultCanvas) img.releaseCanvas(old);
}

/** 加一格撤銷紀錄。ai：這次是不是 Gemini 產生的（一旦用過，這張就算 AI 整理） */
function pushHistory(blob, ai) {
  const prevAI = !!ed.hAI[ed.hIndex];
  // 有「重做」的紀錄就丟掉
  ed.history = ed.history.slice(0, ed.hIndex + 1);
  ed.hAI = ed.hAI.slice(0, ed.hIndex + 1);
  ed.history.push(blob);
  ed.hAI.push(prevAI || !!ai);
  // 上限：保留第 0 格原圖，丟掉最舊的修改
  while (ed.history.length > HISTORY_LIMIT) {
    ed.history.splice(1, 1);
    ed.hAI.splice(1, 1);
    if (ed.savedIndex === 1) ed.savedIndex = -1; // 已儲存的那格被丟掉 → 視為未儲存
    else if (ed.savedIndex > 1) ed.savedIndex--;
  }
  ed.hIndex = ed.history.length - 1;
}

/** 採用一個已經是 JPEG 的結果（一鍵清除）：解碼成工作影像並加入撤銷紀錄 */
async function commitBlob(blob, ai) {
  stageBusy(true, '套用結果…');
  const { canvas } = await img.decodeToCanvas(blob, workMax);
  pushHistory(blob, ai);
  const old = editor.image;
  editor.setImage(canvas, { keepView: true });
  if (old && old !== canvas) img.releaseCanvas(old);
}

// ---------- 復原 / 重做 ----------
async function undo() {
  if (!ed || ed.busy) return;
  // 先復原塗抹，沒有塗抹才復原 AI 結果
  if (editor.undoStroke()) return;
  await stepHistory(-1);
}

async function stepHistory(delta) {
  if (!ed || ed.busy) return;
  const ni = ed.hIndex + delta;
  if (ni < 0 || ni >= ed.history.length) return;
  const session = ed;
  session.busy = true;
  updateEditorUI();
  try {
    // 先放掉目前的工作影像，再解碼下一個（同時只留一張大圖在記憶體）
    const { canvas } = await img.decodeToCanvas(session.history[ni], workMax);
    if (ed !== session) { img.releaseCanvas(canvas); return; }
    const old = editor.image;
    editor.setImage(canvas, { keepView: true });
    if (old && old !== canvas) img.releaseCanvas(old);
    session.hIndex = ni;
    ui.toast(ni === 0 ? '已回到原圖' : (delta < 0 ? '已復原' : '已重做'), 1200);
  } catch (e) {
    showError('操作失敗', e);
  } finally {
    session.busy = false;
    updateEditorUI();
  }
}

// ---------- 按住看原圖 ----------
async function compareStart(e) {
  if (!ed || ed.busy) return;
  e.preventDefault();
  try { if (e.pointerId !== undefined) edEls.compare.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  ed.holding = true;
  edEls.compare.classList.add('pressed');
  const session = ed;
  if (!session.compareCanvas) {
    try {
      // 比較用的原圖只需要螢幕解析度，省記憶體
      const side = Math.min(2048, workMax);
      const { canvas } = await img.decodeToCanvas(session.history[0], side);
      if (ed !== session) { img.releaseCanvas(canvas); return; }
      session.compareCanvas = canvas;
    } catch (err) { console.error(err); ui.toast('無法顯示原圖（記憶體不足）'); return; }
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
let oneClickConfirmed = false;

/** 第一次（每次開啟 App）按一鍵清除時，說明費用與注意事項 */
async function confirmOneClick() {
  if (oneClickConfirmed) return true;
  const usd = await aiui.priceUSD();
  const v = await ui.dialog({
    title: '✨ 一鍵清除',
    message: `AI 會自動移除雜物（約 NT$${aiui.fmtTWD(usd * aiui.TWD_PER_USD)}／張，以實際帳單為準），需要 20–60 秒。\n\n${aiui.AI_DISCLAIMER}。`,
    buttons: [
      { label: '開始', value: true, primary: true },
      { label: '取消', value: false },
    ],
  });
  if (v === true) oneClickConfirmed = true;
  return v === true;
}

/**
 * 對目前的工作影像跑一次 Gemini 一鍵清除，結果轉成 JPEG Blob（立刻釋放 canvas，省記憶體）。
 * 使用者按「取消」回傳 null；其他錯誤丟出。
 */
async function declutterOnce() {
  const hb = aiui.cancelableBusy('傳送到 AI 處理中…\n約 20–60 秒，請保持螢幕開啟');
  try {
    const g = await eng.getGeminiEngine();
    const out = await g.declutterGemini(editor.image, {
      apiKey: settings.apiKey,
      signal: hb.signal,
      onProgress: (p) => {
        const d = eng.describeProgress(p, 'AI 處理中…');
        hb.update(d.text + (d.ratio != null ? `　${Math.round(d.ratio * 100)}%` : ''), d.ratio);
      },
    });
    const info = out && out.__geminiInfo ? out.__geminiInfo : null;
    try {
      if (!out || !out.width) throw new Error('AI 沒有傳回結果，請再試一次');
      hb.update('整理結果中…');
      const blob = await img.canvasToBlob(out, 'image/jpeg', 0.92);
      const thumb = await img.makeThumb(out, 320);
      aiui.recordUsage(1);
      return { blob, thumb, info };
    } finally {
      if (out) img.releaseCanvas(out);
    }
  } catch (e) {
    if (hb.cancelled) return null;
    throw e;
  } finally {
    hb.close();
  }
}

/** ✨ 一鍵清除（Gemini，不需塗抹）：處理 → 比較畫面 → 採用 */
async function oneClickFlow() {
  if (!ed || ed.busy) return;
  if (!settings.apiKey) {
    if (!(await aiui.keyWizard())) return;
    if (!ed || ed.busy) return;
  }
  if (!(await confirmOneClick()) || !ed) return;
  if (!(await aiui.capOk(1)) || !ed) return;
  editor.clearMask();
  const session = ed;
  session.busy = true;
  editor.enabled = false;
  updateEditorUI();
  let failure = null;
  try {
    const beforeBlob = session.history[session.hIndex];
    const first = await declutterOnce();
    if (!first || ed !== session) return;
    const picked = await aiui.showCompare({
      beforeBlob,
      first,
      rerun: async () => {
        if (!(await aiui.capOk(1))) return null;
        try { return await declutterOnce(); }
        catch (e) { await aiui.geminiFailure('再試一次失敗', e); return null; }
      },
    });
    if (!picked || ed !== session) return;
    await commitBlob(picked.blob, true);
    ui.toast('已採用。按右上角「儲存」才會存進案件；小地方可用塗抹再修', 4500);
  } catch (e) {
    failure = e;
  } finally {
    session.busy = false;
    if (ed === session) {
      editor.enabled = true;
      stageBusy(false);
      updateEditorUI();
    }
  }
  if (failure && ed === session) await aiui.geminiFailure('一鍵清除失敗', failure);
}

// ---------- 照片牆：全部一鍵清除 ----------
let batchRunning = false;

/** 依序處理（一次一張）。回傳 {done, failed:[{photo,index,error}], cancelled} */
async function runBatch(items) {
  const hb = aiui.cancelableBusy('準備中…', { cancelLabel: '停止' });
  batchRunning = true;
  let done = 0;
  const failed = [];
  try {
    const g = await eng.getGeminiEngine();
    const n = items.length;
    for (let k = 0; k < n; k++) {
      if (hb.cancelled) break;
      const { photo, index } = items[k];
      hb.update(`第 ${k + 1}／${n} 張`, k / n);
      let src = null;
      let out = null;
      try {
        const original = await db.getOriginal(photo.id);
        if (!original) throw new Error('找不到原圖資料');
        ({ canvas: src } = await img.decodeToCanvas(original, workMax));
        out = await g.declutterGemini(src, {
          apiKey: settings.apiKey,
          signal: hb.signal,
          onProgress: (p) => {
            const d = eng.describeProgress(p, 'AI 處理中…');
            hb.update(`第 ${k + 1}／${n} 張\n${d.text}`, (k + (d.ratio != null ? d.ratio : 0.1)) / n);
          },
        });
        img.releaseCanvas(src); src = null;
        const blob = await img.canvasToBlob(out, 'image/jpeg', 0.92);
        const thumb = await img.makeThumb(out);
        img.releaseCanvas(out); out = null;
        await db.saveEdited(photo.id, blob, thumb, { aiGenerated: true });
        aiui.recordUsage(1);
        done++;
      } catch (e) {
        if (hb.cancelled) break;
        console.error(e);
        failed.push({ photo, index, error: e });
        if (e && (e.code === 'BAD_KEY' || e.code === 'NO_BILLING' || e.code === 'QUOTA')) break; // 後面的也一定會失敗
      } finally {
        if (src) img.releaseCanvas(src);
        if (out) img.releaseCanvas(out);
      }
      await tick(30);
    }
  } finally {
    batchRunning = false;
    hb.close();
  }
  return { done, failed, cancelled: hb.cancelled };
}

async function batchDeclutter() {
  if (batchRunning || cur.screen !== 'listing') return;
  const todo = (cur.photos || []).map((p, i) => ({ photo: p, index: i + 1 })).filter((x) => !x.photo.edited);
  if (!todo.length) { ui.toast('這個案件的照片都整理過了'); return; }
  if (!settings.apiKey) {
    if (!(await aiui.keyWizard())) return;
  }
  const n = todo.length;
  const usd = await aiui.priceUSD();
  const each = usd * aiui.TWD_PER_USD;
  const v = await ui.dialog({
    title: '✨ 全部一鍵清除',
    message: `會一張一張處理還沒整理的 ${n} 張照片，每張約 20–60 秒。處理期間請保持螢幕開啟，不要切到別的 App。\n\n預估費用約 NT$${aiui.fmtTWD(n * each)}（${n} 張 × NT$${aiui.fmtTWD(each)}，以實際帳單為準）。\n原圖會保留，結果存成整理版。\n\n${aiui.AI_DISCLAIMER}。`,
    buttons: [
      { label: `開始（${n} 張）`, value: true, primary: true },
      { label: '取消', value: false },
    ],
  });
  if (v !== true) return;

  let items = todo;
  const listingId = cur.listingId;
  for (;;) {
    if (!(await aiui.capOk(items.length))) break;
    let r;
    try { r = await runBatch(items); }
    catch (e) { await aiui.geminiFailure('全部一鍵清除失敗', e); break; }
    if (cur.screen === 'listing' && cur.listingId === listingId) await renderPhotos();
    if (r.cancelled) { ui.toast(`已停止，完成 ${r.done} 張`, 3500); break; }
    if (!r.failed.length) {
      await ui.alert('全部完成 ✓', `已整理 ${r.done} 張。\n請點進照片檢查結果；有問題的可以按「復原」或在照片牆選「恢復原圖」。`);
      break;
    }
    const lines = r.failed.slice(0, 8).map((f) => `第 ${f.index} 張：${eng.errorMessage(f.error)}`);
    if (r.failed.length > 8) lines.push(`…還有 ${r.failed.length - 8} 張`);
    const keyIssue = r.failed.some((f) => f.error && (f.error.code === 'BAD_KEY' || f.error.code === 'NO_BILLING'));
    const c = await ui.dialog({
      title: `完成 ${r.done} 張，${r.failed.length} 張失敗`,
      message: lines.join('\n') + (keyIssue ? '\n\n請先到「設定」→「看設定教學」確認金鑰與帳單。' : ''),
      buttons: [
        { label: `重試失敗的 ${r.failed.length} 張`, value: 'retry', primary: true },
        { label: '關閉', value: null },
      ],
    });
    if (c !== 'retry') break;
    items = r.failed.map((f) => ({ photo: f.photo, index: f.index }));
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
      await db.saveEdited(ed.photoId, blob, thumb, { aiGenerated: !!ed.hAI[ed.hIndex] });
    }
    ed.savedIndex = ed.hIndex;
    const p = (cur.photos || []).find((x) => x.id === ed.photoId);
    if (p) { p.edited = ed.hIndex !== 0; p.aiGenerated = p.edited && !!ed.hAI[ed.hIndex]; }
    updateEditorUI();
    return true;
  } catch (e) {
    showError('儲存失敗', e);
    return false;
  } finally {
    busy.close();
    maybeReloadForUpdate();
  }
}

/** 按「儲存」：（有未移除的塗抹先問）→ 儲存 → 問要不要去下一張沒整理的 */
async function saveFlow() {
  if (!ed || ed.busy) return;
  if (hasPendingMask()) {
    const v = await ui.dialog({
      title: '塗抹的地方還沒移除',
      message: '紅色的地方還沒按「✨ 移除」。要先移除再儲存嗎？',
      buttons: [
        { label: '✨ 先移除再儲存', value: 'run', primary: true },
        { label: '不移除，直接儲存', value: 'skip' },
        { label: '取消', value: null },
      ],
    });
    if (!v || !ed) return;
    if (v === 'run') { if (!(await runRemoval())) return; }
    else editor.clearMask();
  }
  if (!ed) return;
  const wasDirty = isDirty();
  if (!(await saveEdit())) return;
  if (wasDirty) ui.toast('已儲存 ✓', 1500);
  await offerNext();
}

/** 儲存後：提供跳到下一張還沒整理的照片 */
async function offerNext() {
  if (!ed) return;
  const list = cur.photos || [];
  const i = photoIndex();
  let next = null;
  for (let k = 1; k <= list.length; k++) {
    const p = list[((i < 0 ? -1 : i) + k + list.length) % list.length];
    if (p && p.id !== ed.photoId && !p.edited) { next = p; break; }
  }
  if (!next) {
    if (!list.every((p) => p.edited)) return; // 只剩這張沒整理（例如沒有修改就按儲存）：留在這張
    await ui.alert('全部整理好了 ✓', `這個案件的 ${list.length || 1} 張照片都整理過了。\n回到照片牆後，可以按「全部匯出」。`);
    if (ed) goBack();
    return;
  }
  const n = list.indexOf(next) + 1;
  const v = await ui.dialog({
    title: '已儲存 ✓',
    message: `下一張還沒整理的是第 ${n} 張，要直接開啟嗎？`,
    buttons: [
      { label: `開啟第 ${n} 張`, value: 'next', primary: true },
      { label: '回到照片牆', value: 'back' },
      { label: '留在這張', value: null },
    ],
  });
  if (!ed) return;
  if (v === 'next') openPhotoInEditor(next.id);
  else if (v === 'back') goBack();
}

function openPhotoInEditor(photoId) {
  if (!ed) return;
  // 用 replace：按返回會回到照片牆，不會一張一張倒退
  navigate({ screen: 'editor', listingId: ed.listingId, photoId }, { replace: true });
}

/** 上一張／下一張 */
async function gotoPhoto(delta) {
  if (!ed || ed.busy) return;
  const list = cur.photos || [];
  const i = photoIndex();
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  if (!(await confirmLeave())) return;
  openPhotoInEditor(list[j].id);
}

// ---------- 綁定修圖畫面按鈕 ----------
function bindEditor() {
  edEls.seg.forEach((b) => b.addEventListener('click', () => {
    if (!ed || ed.busy || ed.engine === b.dataset.engine) return;
    setEngine(b.dataset.engine);
  }));
  edEls.tools.forEach((b) => b.addEventListener('click', () => {
    if (!ed || ed.busy) return;
    setTool(b.dataset.tool);
    if (b.dataset.tool === 'erase') ui.toast('橡皮擦：塗過的地方可以擦掉紅色', 1600);
  }));
  edEls.save.addEventListener('click', saveFlow);
  edEls.remove.addEventListener('click', () => runRemoval());
  edEls.undo.addEventListener('click', undo);
  edEls.redo.addEventListener('click', () => stepHistory(1));
  edEls.clear.addEventListener('click', () => {
    if (!ed || ed.busy) return;
    editor.clearMask();
    setTool('paint');
  });
  edEls.oneclick.addEventListener('click', oneClickFlow);
  edEls.fit.addEventListener('click', () => editor.fit());
  edEls.prev.addEventListener('click', () => gotoPhoto(-1));
  edEls.next.addEventListener('click', () => gotoPhoto(1));
  edEls.help.addEventListener('click', () => showTutorial());

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
  $('#app-version').textContent = `版本 ${APP_VERSION}`;
  $('#set-cap').value = settings.monthlyCap ? String(settings.monthlyCap) : '';
  renderUsage();
  renderAbout();
}

async function renderUsage() {
  try { $('#set-usage').textContent = await aiui.usageText(); }
  catch { $('#set-usage').textContent = `本月已用 ${settings.usageThisMonth} 張`; }
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
  if (workMax < img.MAX_SIDE) parts.push(`目前使用省記憶體模式（${workMax}px）。`);
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
      const m = r && r.message && /[一-鿿]/.test(r.message) ? r.message : (ok ? '金鑰可以使用' : '金鑰無法使用');
      result.textContent = (ok ? '✓ ' : '✗ ') + m;
      result.className = 'key-result ' + (ok ? 'ok' : 'fail');
    } catch (err) {
      result.textContent = '✗ ' + eng.errorMessage(err);
      result.className = 'key-result fail';
    } finally {
      btn.disabled = false;
    }
  });
  $('#set-wizard').addEventListener('click', async () => {
    await aiui.keyWizard();
    key.value = settings.apiKey;
    result.textContent = '';
    result.className = 'key-result';
  });
  $('#set-usage-reset').addEventListener('click', async () => {
    if (!(await ui.confirm('用量歸零？', '只會把這支手機上的本月計數歸零，不影響 Google 帳單。', { okLabel: '歸零' }))) return;
    settings.resetUsage();
    renderUsage();
  });
  $('#set-cap').addEventListener('change', (e) => {
    settings.monthlyCap = e.currentTarget.value;
    e.currentTarget.value = settings.monthlyCap ? String(settings.monthlyCap) : '';
    ui.toast(settings.monthlyCap ? `每月上限 ${settings.monthlyCap} 張` : '不限制每月張數');
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
  $('#app-version').textContent = `版本 ${APP_VERSION}`;
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
      { label: '✨ 全部一鍵清除', value: 'batch' },
      { label: '重新命名', value: 'rename' },
      { label: '全部匯出', value: 'export' },
      { label: '刪除案件', value: 'delete', danger: true },
    ]);
    if (v === 'batch') batchDeclutter();
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
      const files = [...(input.files || [])];
      input.value = ''; // 讓同一張可以再選一次
      try { await importFiles(files); }
      catch (e) { showError('加入照片失敗', e); }
    });
  }
  $('#btn-export-all').addEventListener('click', exportAll);
  $('#btn-batch-ai').addEventListener('click', batchDeclutter);
}

// =========================================================
// Service Worker 與自動更新
// =========================================================
let swReg = null;
let updatePending = false;
let reloading = false;

/** 有新版時：沒有未儲存的修改才重新載入（只重新載入一次） */
function maybeReloadForUpdate() {
  if (!updatePending || reloading) return;
  if (ed && (isDirty() || ed.busy || hasPendingMask())) return;
  reloading = true;
  location.reload();
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    // 先確認 sw.js 存在，避免 404 時在主控台噴錯
    const r = await fetch('./sw.js', { method: 'HEAD', cache: 'no-store' });
    if (!r.ok) return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // 第一次安裝（原本沒有 controller）不需要重新載入
      if (!hadController || reloading || updatePending) return;
      updatePending = true;
      if (ed && (isDirty() || ed.busy || hasPendingMask())) {
        ui.toast('有新版本，儲存後會自動更新', 4000);
      } else {
        maybeReloadForUpdate();
      }
    });
    swReg = await navigator.serviceWorker.register('./sw.js');
    try { await swReg.update(); } catch { /* 離線時忽略 */ }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && swReg) swReg.update().catch(() => {});
    });
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
  showError('啟動失敗', e, { hint: '請把修圖器完全關掉再重新開啟。' });
});
