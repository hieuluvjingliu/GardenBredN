const $ = (s, el=document)=>el.querySelector(s);
const $$ = (s, el=document)=>Array.from(el.querySelectorAll(s));
let state = null;
let currentFloorIdx = 0;
let floorActionSel = {}; // { [floorId]: {slot, potId, seedId} }


// === Caches để không reset số lượng khi refresh ===
const seedQtyCache = {}; // { [class]: "value-as-string" }
const potQtyCache = {}; // { [type]: "value-as-string" }
function getCachedQty(cache, key, fallback=1){
const v = parseInt(cache[key], 10);
return Number.isFinite(v) && v > 0 ? v : fallback;
}


// ---- MUTATION META (client-side only) ----
const MUT_INFO = {
green: { name:'green', mult:1.2, color:'#35e08a' },
blue: { name:'blue', mult:1.5, color:'#3b82f6' },
yellow: { name:'yellow', mult:2.0, color:'#facc15' },
pink: { name:'pink', mult:3.0, color:'#ec4899' },
red: { name:'red', mult:4.0, color:'#ef4444' },
gold: { name:'gold', mult:6.0, color:'#f59e0b' },
rainbow: { name:'rainbow', mult:11.0, color:'#a78bfa' }
};
const MUT_KEYS = Object.keys(MUT_INFO); // ['green','blue','yellow','pink','red','gold','rainbow']

// Map bộ lọc màu (áp lên riêng ảnh plant)
const MUT_FILTERS = {
  green:   'hue-rotate(95deg) saturate(1.25) brightness(1.02)',
  blue:    'hue-rotate(200deg) saturate(1.30) brightness(1.03)',
  yellow:  'hue-rotate(35deg) saturate(1.35) brightness(1.05)',
  pink:    'hue-rotate(320deg) saturate(1.35) brightness(1.02)',
  red:     'hue-rotate(0deg) saturate(1.45) brightness(1.02)',
  gold:    'hue-rotate(28deg) saturate(1.55) brightness(1.08)',
  rainbow: '' // riêng "rainbow" sẽ animate ở CSS
};
function applyMutationFilterToPlant(imgEl, mutKey){
  if (!imgEl) return;
  if (mutKey === 'rainbow') {
    imgEl.classList.add('mut-rainbow-plant');
    return;
  }
  const f = MUT_FILTERS[mutKey];
  if (f) imgEl.style.filter = f;
}
function getMutationMeta(obj){
  const key = obj?.mutation || obj?.mutation_name;
  if (!key) return null;
  const meta = MUT_INFO[key] || null;
  if (!meta) return null;
  return {
    key,
    name: obj?.mutation_name || meta.name,
    mult: Number.isFinite(obj?.mutation_mult) ? obj.mutation_mult : meta.mult,
    color: obj?.mutation_color || obj?.mutation_hex || meta.color
  };
}

// --- Helper badge mutation cho khu Breed result ---
function renderMutationBadge(mut){
  const key = mut || 'normal';
  const cls = {
    green:'mut-green', blue:'mut-blue', yellow:'mut-yellow', pink:'mut-pink',
    red:'mut-red', gold:'mut-gold', rainbow:'mut-rainbow', normal:'mut-normal'
  }[key] || 'mut-normal';
  return `<span class="badge ${cls}">${key}</span>`;
}

/* ========================= FIX RACE AUTO PLANT ========================= */
// Chặn double-submit cùng seedId & đánh dấu seed vừa trồng
const AUTO_INFLIGHT = new Set();        // seedId đang gọi API /plot/plant
const AUTO_RECENT_PLANTED = new Set();  // seedId vừa trồng xong (đợi state đồng bộ)
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
/* ====================================================================== */

/* ===================== Breed Result Card (NEW) ===================== */
function getBreedFeedEl(){
  return document.getElementById('breedFeed') || document.getElementById('breedOut');
}
function renderBreedCard(out){
  // out: { mutation, seedName, resultClass }
  const feed = getBreedFeedEl();
  if (!feed) return;

  const mutKey = (out.mutation || '').toLowerCase();
  const meta = MUT_INFO[mutKey] || null;
  const badgeBg = meta?.color || '#444';
  const badgeText = meta ? `${meta.name} ×${meta.mult}` : 'normal';

  const seedName = out.seedName || out.resultClass || 'Unknown';
  const cls = (out.resultClass || seedName || '').toLowerCase();

  // ảnh Planted: theo naming bạn đang dùng ở shop
  const imgSrc = `/assets/Seed_Planted/seed_planted_${cls}.png`;

  const card = document.createElement('div');
  card.className = 'breed-card';
  card.innerHTML = `
    <div class="mut-badge" style="background:${badgeBg}">${badgeText}</div>
    <div class="seed-wrap">
      <img class="seed-img plant" alt="${seedName}">
    </div>
    <div class="seed-name">seed : <b>${seedName}</b></div>
  `;
  const img = card.querySelector('.seed-img');
  img.src = imgSrc;
  img.loading = 'lazy';
  img.onerror = ()=>{ img.style.display='none'; };
  if (meta?.key) applyMutationFilterToPlant(img, meta.key);

if (feed) {
  feed.innerHTML = ''; // luôn clear trước
  feed.appendChild(card);
}

}
/* =================================================================== */

/* ========================= NOTIFIER (Toast dùng chung) ========================= */
class Notifier {
  constructor(opts={}){
    this.wrap = null;
    this.max = opts.max ?? 6;
    this.ttl = opts.ttl ?? 3000;
    this.coalesceMs = opts.coalesceMs ?? 350; // gộp sự kiện trùng trong ~350ms
    this._lastByKey = new Map();
  }
  ensureWrap(){
    if (!this.wrap){
      this.wrap = document.getElementById('toastContainer');
      if (!this.wrap){
        this.wrap = document.createElement('div');
        this.wrap.id = 'toastContainer';
        this.wrap.className = 'notify-wrap';
        document.body.appendChild(this.wrap);
      } else {
        this.wrap.classList.add('notify-wrap');
      }
    }
    return this.wrap;
  }
  show(cfg){
    const wrap = this.ensureWrap();
    const type = cfg.type || 'info';
    const ttl = cfg.ttl ?? this.ttl;

    // Coalesce theo key
    if (cfg.key){
      const last = this._lastByKey.get(cfg.key);
      const now = Date.now();
      if (last && (now - last.ts) < this.coalesceMs){
        last.count++;
        const descEl = last.el.querySelector('.desc');
        if (descEl && !descEl.textContent.includes('×')) {
          descEl.insertAdjacentText('beforeend', ` ×${last.count}`);
        } else if (descEl) {
          descEl.textContent = descEl.textContent.replace(/×\d+$/, `×${last.count}`);
        }
        last.ts = now;
        return last.el;
      }
    }

    const el = document.createElement('div');
    el.className = `notify ${type}`;
    const thumbHtml = cfg.thumb ? `<img src="${cfg.thumb}" alt="">` : (cfg.icon || `<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M12 3a9 9 0 1 1 0 18a9 9 0 0 1 0-18zm1 5h-2v6h2V8zm0 8h-2v2h2v-2z"/></svg>`);
    el.innerHTML = `
      <div class="thumb">${thumbHtml}</div>
      <div class="texts">
        <div class="title">${cfg.title || 'Notification'}</div>
        ${cfg.desc ? `<div class="desc">${cfg.desc}</div>` : ''}
        ${cfg.meta ? `<div class="meta">${cfg.meta}</div>` : ''}
      </div>
      <div class="actions"></div>
    `;

    // actions
    const actBox = el.querySelector('.actions');
    (cfg.actions||[]).forEach(a=>{
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = a.label;
      b.onclick = (ev)=>{
        ev.stopPropagation();
        try{ a.onClick?.(); }catch{}
        closeNow();
      };
      actBox.appendChild(b);
    });

    // Append mới dưới cùng
    wrap.appendChild(el);
    while(wrap.children.length > this.max){
      wrap.firstElementChild?.remove();
    }

    const timer = setTimeout(()=> closeNow(), ttl);
    function closeNow(){
      clearTimeout(timer);
      el.classList.add('exit');
      setTimeout(()=> el.remove(), 220);
    }
    el.addEventListener('click', closeNow);

    if (cfg.key){
      this._lastByKey.set(cfg.key, {ts: Date.now(), count: 1, el});
      setTimeout(()=> this._lastByKey.delete(cfg.key), this.coalesceMs + 50);
    }
   

    return el;
  }
}
window.notifyBus = new Notifier({ max:6, ttl:3000, coalesceMs:350 });

/* ========= Helpers hiển thị mutation gọn ========= */
function formatMutationShort(arg){
  // arg có thể là chuỗi (key) hoặc object seed/plot
  if (!arg) return '';
  if (typeof arg === 'string') {
    const m = MUT_INFO[arg];
    return m ? `${m.name} ×${m.mult}` : '';
  }
  const meta = getMutationMeta(arg);
  return meta ? `${meta.name} ×${meta.mult}` : '';
}

// Convenience helpers
function notifPlant({cls, floorName, potId, seedName, mutation, seed, img}){
  // Ưu tiên lấy text mutation từ seed (có thể có mutation_mult), fallback key
  const mutTxt = formatMutationShort(seed || mutation);
  const desc = seedName ? `${seedName} (class ${cls})${mutTxt ? ' · Mut: '+mutTxt : ''}` : `Class ${cls}${mutTxt ? ' · Mut: '+mutTxt : ''}`;
  const meta = `Floor: ${floorName ?? '?'} · Pot: ${potId ?? '-'}`;
  return notifyBus.show({ type:'success', title:'Đã trồng', desc, meta, thumb: img, key:`plant:${floorName}:${cls}:${mutTxt}` });
}
function notifBuy({what, qty, price, where}){
  return notifyBus.show({ type:'info', title:'Đã mua', desc:`${qty||1} ${what}`, meta: [price!=null?`Giá: ${price}`:null, where||null].filter(Boolean).join(' · '), key:`buy:${what}` });
}
function notifSell({what, qty, price}){
  return notifyBus.show({ type:'warn', title:'Đã bán', desc:`${qty||1} ${what}`, meta: (price!=null?`Thu: ${price}`:''), key:`sell:${what}` });
}
function notifBreed({resultCls, parents, mutation, base}){
  const mutTxt = formatMutationShort(mutation);
  return notifyBus.show({ type:'success', title:'Lai thành công', desc:`→ ${resultCls}${base!=null? ` (base ${base})`:''}`, meta: [parents?`Từ: ${parents.join(' + ')}`:'', mutTxt?`Mut: ${mutTxt}`:''].filter(Boolean).join(' · '), key:`breed:${resultCls}:${mutTxt||''}` });
}
function notifTrap({name, floorName, result}){
  return notifyBus.show({ type:'gold', title:'Trap', desc:name, meta:`Floor: ${floorName}${result? ` · ${result}`:''}`, key:`trap:${name}:${floorName}` });
}
function notifInfo(title, desc, meta){
  return notifyBus.show({ type:'info', title, desc, meta });
}
function notifError(title, desc){
  return notifyBus.show({ type:'error', title, desc });
}

/* ---------------- API ---------------- */
async function api(path, body){
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { error: raw || res.statusText }; }
  if (!res.ok) {
    const err = {
      status: res.status,
      statusText: res.statusText,
      error: data?.error || 'Unknown error',
      details: data,
      _raw: raw
    };
    throw err;
  }
  return data;
}
function showError(e, context=''){
  const title = context ? `[${context}] ` : '';
  const msg = `${title}${e?.error || e?.message || 'error'} ${e?.status ? `(HTTP ${e.status})` : ''}`.trim();
  alert(msg);
  notifyBus.show({ type:'error', title:'Lỗi', desc: msg });
  console.error('API error:', { context, status: e?.status, statusText: e?.statusText, error: e?.error, details: e?.details, raw: e?._raw });
}
async function get(path){
  const res = await fetch(path);
  if(!res.ok) throw await res.json();
  return res.json();
}

/* ======= BUY COOLDOWN (1s) ======= */
const COOLDOWN_MS = 1000;
function withCooldown(btn, fn, ms=COOLDOWN_MS){
  return async (...args)=>{
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try { await fn(...args); }
    finally { setTimeout(()=>{ btn.disabled = false; }, ms); }
  };
}

function setActive(tab){
  $$('.tabs button').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  $$('.tab').forEach(sec=>sec.classList.toggle('hidden', sec.id!==tab));
}
function showApp(){
  $('#auth').classList.add('hidden');
  $('#hud').classList.remove('hidden');
  $('#tabs').classList.remove('hidden');
  setActive('shop');
  notifInfo('Xin chào!', 'Đăng nhập thành công');
}

/* ---------- HELPERS ---------- */
function preserveSelectValue(sel, fillFn){
  if(!sel) return;
  const old = sel.value;
  fillFn();
  if (old && Array.from(sel.options).some(o=>o.value===old)) sel.value = old;
}
function snapshotFloorActionSelections(){
  floorActionSel = {};
  $$('#floors .floor').forEach(f=>{
    const floorId = +f.dataset.floorId;
    const act = f.querySelector('.floor-actions');
    if (!act) return;
    const slot = act.querySelector('.sel-slot')?.value;
    const potId = act.querySelector('.sel-pot')?.value;
    const seedId = act.querySelector('.sel-seed')?.value;
    floorActionSel[floorId] = { slot, potId, seedId };
  });
}
function restoreFloorActionSelections(){
  Object.entries(floorActionSel).forEach(([fid, sel])=>{
    const f = $(`#floors .floor[data-floor-id="${fid}"]`);
    if (!f) return;
    const act = f.querySelector('.floor-actions');
    if (!act) return;
    const slotSel = act.querySelector('.sel-slot');
    const potSel  = act.querySelector('.sel-pot');
    const seedSel = act.querySelector('.sel-seed');
    if (slotSel && sel.slot && Array.from(slotSel.options).some(o=>o.value===sel.slot)) slotSel.value = sel.slot;
    if (potSel  && sel.potId && Array.from(potSel.options).some(o=>o.value===sel.potId)) potSel.value  = sel.potId;
    if (seedSel && sel.seedId&& Array.from(seedSel.options).some(o=>o.value===sel.seedId)) seedSel.value = sel.seedId;
  });
}

/* ---------- SHOP (ảnh) ---------- */
function buildQtyControl({cache, key, onChange}){
  const wrap = document.createElement('div');
  wrap.className = 'qty';
  const minus = document.createElement('button'); minus.type='button'; minus.textContent='–';
  const input = document.createElement('input'); input.type='number'; input.min='1'; input.inputMode='numeric';
  input.value = getCachedQty(cache, key, 1);
  const plus  = document.createElement('button'); plus.type='button'; plus.textContent='+';

  const syncCache = ()=>{
    const v = parseInt(input.value,10);
    cache[key] = (Number.isFinite(v) && v>0) ? String(v) : '1';
    if (typeof onChange === 'function') onChange(cache[key]);
  };
  input.addEventListener('input', syncCache);
  input.addEventListener('focus', ()=>{ wrap.dataset.focused='1'; });
  input.addEventListener('blur',  ()=>{ delete wrap.dataset.focused; });
  minus.addEventListener('click', ()=>{
    const v = Math.max(1, (parseInt(input.value,10)||1)-1);
    input.value = v; syncCache();
  });
  plus.addEventListener('click', ()=>{
    const v = Math.max(1, (parseInt(input.value,10)||1)+1);
    input.value = v; syncCache();
  });

  wrap.append(minus, input, plus);
  return { wrap, input };
}
function renderShop(){
  const seedGrid = $('#seedShopGrid');
  if (!seedGrid) return;
  seedGrid.innerHTML='';
  ['fire','water','wind','earth'].forEach(cls=>{
    const el = document.createElement('div'); el.className='item';
    const img = document.createElement('img');
    img.src = `/assets/Seed_Planted/seed_planted_${cls}.png`;
    img.loading = 'lazy';
    img.onerror = ()=>{
      img.replaceWith(Object.assign(document.createElement('div'),{
        textContent:cls.toUpperCase(),
        style:'height:72px;display:flex;align-items:center;justify-content:center'
      }));
    };
    const lbl = document.createElement('span'); lbl.className = 'label'; lbl.textContent = cls;
    const { wrap: qtyWrap, input: qtyInput } = buildQtyControl({ cache: seedQtyCache, key: cls });
    const btn = document.createElement('button');
    btn.textContent = `Buy ${cls} (100)`;
    btn.addEventListener('click', withCooldown(btn, async ()=>{
      const qty = Math.max(1, parseInt(qtyInput.value,10) || 1);
      seedQtyCache[cls] = String(qty);
      try{
        await api('/shop/buy',{ itemType:'seed', classOrType: cls, qty });
        notifBuy({ what:`seed ${cls}`, qty, price: 100*qty, where: 'Shop' });
        await refresh();
      }catch(e){ showError(e,'buy-seed'); }
    }));
    el.append(img, lbl, qtyWrap, btn);
    seedGrid.appendChild(el);
  });

  const potGrid = $('#potShopGrid');
  if (!potGrid) return;
  potGrid.innerHTML='';
  const potDefs = [
    {type:'basic',    img:'pot1.png', label:'Basic (100)',           price:100},
    {type:'gold',     img:'pot2.png', label:'Gold +50% (300)',       price:300},
    {type:'timeskip', img:'pot3.png', label:'Time Skip +50% (300)',  price:300}
  ];
  potDefs.forEach(p=>{
    const el=document.createElement('div'); el.className='item';
    const img = document.createElement('img');
    img.src = `/assets/Pots_Image/${p.img}`;
    img.loading = 'lazy';
    img.onerror = ()=>{
      img.replaceWith(Object.assign(document.createElement('div'),{
        textContent:p.type,
        style:'height:72px;display:flex;align-items:center;justify-content:center'
      }));
    };
    const lbl = document.createElement('span'); lbl.className = 'label'; lbl.textContent = p.type;
    const { wrap: qtyWrap, input: qtyInput } = buildQtyControl({ cache: potQtyCache, key: p.type });
    const btn = document.createElement('button'); btn.textContent = p.label;
    btn.addEventListener('click', withCooldown(btn, async ()=>{
      const qty = Math.max(1, parseInt(qtyInput.value,10) || 1);
      potQtyCache[p.type] = String(qty);
      try{
        await api('/shop/buy',{ itemType:'pot', classOrType:p.type, qty });
        notifBuy({ what:`pot ${p.type}`, qty, price: p.price*qty, where:'Shop' });
        await refresh();
      }catch(e){ showError(e,'buy-pot'); }
    }));
    el.append(img,lbl,qtyWrap,btn);
    potGrid.appendChild(el);
  });
}

/* ---------- MARKET ---------- */
function renderMarketListings(){
  const ul = document.getElementById('marketList');
  if (!ul) return;
  const listings = state?.market || [];
  ul.innerHTML = '';
  if (!listings.length){
    ul.innerHTML = '<li><small>Chưa có món nào được rao.</small></li>';
    return;
  }
  listings.forEach(L=>{
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="listing-row">
        <div class="l-col"><span class="muted">#${L.id}</span> <b>${L.class}</b></div>
        <div class="l-col price"><span class="coin-ico"></span> <b>${L.ask_price}</b></div>
        <div class="l-col muted">base ${L.base_price}</div>
        <button class="buy buy-listing" data-id="${L.id}">Buy</button>
      </div>`;
    ul.appendChild(li);
  });
}

/* ---------- DATA HELPERS ---------- */
function groupMatureByClass(){
  const by = {};
  (state?.seedInv||[]).filter(s=>s.is_mature===1).forEach(s=>{
    by[s.class] = (by[s.class]||0)+1;
  });
  return by;
}
function decorateSeedText(seed) {
  const m = getMutationMeta(seed);
  if (m) return `#${seed.id} ${seed.class} [${m.name} ×${m.mult}]`;
  return `#${seed.id} ${seed.class}`;
}

/* ===== INVENTORY: filters + render + Plant All ===== */
function getInventoryFilters(){
  const st = ($('#fltInvState')?.value || 'all');
  const cls = ($('#fltInvClass')?.value || 'all');
  const mut = ($('#fltInvMut')?.value || 'all');
  return { st, cls, mut };
}
function seedMatchFilter(s, {st, cls, mut}){
  if (st === 'not' && s.is_mature !== 0) return false;
  if (st === 'mat' && s.is_mature !== 1) return false;
  if (cls !== 'all' && s.class !== cls) return false;
  const mKey = s.mutation || s.mutation_name || null;
  if (mut === 'none' && mKey) return false;
  if (mut !== 'all' && mut !== 'none' && mKey !== mut) return false;
  return true;
}
function getFilteredSeedsForInventory(){
  const list = Array.isArray(state?.seedInv) ? state.seedInv.slice() : [];
  const f = getInventoryFilters();
  return list.filter(s => seedMatchFilter(s, f));
}
function ensureInventoryClassOptions(){
  const sel = $('#fltInvClass');
  if (!sel) return;
  const classes = Array.from(new Set((state?.seedInv||[]).map(s=>s.class))).sort();
  preserveSelectValue(sel, ()=>{
    const cur = sel.value;
    sel.innerHTML = '<option value="all">All classes</option>' + classes.map(c=>`<option value="${c}">${c}</option>`).join('');
    if (Array.from(sel.options).some(o=>o.value===cur)) sel.value = cur;
  });
}
function renderInventorySeeds(){
  const ul = $('#seedInv');
  if (!ul) return;
  const rows = getFilteredSeedsForInventory().filter(s=>s.is_mature===0 || $('#fltInvState')?.value!=='not');
  ul.innerHTML = '';
  if (!rows.length){
    ul.innerHTML = '<li><small>Không có seed phù hợp filter.</small></li>';
    return;
  }
  for (const s of rows){
    const li = document.createElement('li'); li.className = 'inv-item';
    const m = getMutationMeta(s);
    li.innerHTML = `
      <div class="title">${decorateSeedText(s)}</div>
      <div class="small">base ${s.base_price ?? '-'} • id ${s.id}</div>`;
    if (m){
      const tag = document.createElement('div');
      tag.className = 'mut-tag';
      tag.textContent = `${m.name} ×${m.mult}`;
      if (m.color){
        tag.style.background = m.color;
        tag.style.color = pickTextColorForBg(m.color);
        tag.style.borderColor = m.color;
        tag.style.boxShadow = `0 0 12px ${m.color}66`;
      }
      li.appendChild(tag);
    }
    ul.appendChild(li);
  }
}
async function plantAllFiltered(){
  const seeds = getFilteredSeedsForInventory().filter(s=>s.is_mature===0);
  if (!seeds.length) return alert('Không có seed phù hợp để trồng.');

  const targets = [];
  for (const fp of (state?.plots||[])){
    for (const p of fp.plots){
      if (p.pot_id && p.stage === 'empty'){
        targets.push({ floorId: fp.floor.id, slot: p.slot, floorIdx: fp.floor.idx });
      }
    }
  }
  if (!targets.length) return alert('Không còn slot trống có pot để trồng.');

  let planted = 0;
  while (targets.length && seeds.length){
    const t = targets.shift();
    const s = seeds.shift();
    try {
      await api('/plot/plant', { floorId: t.floorId, slot: t.slot, seedId: s.id });
      planted++;
      notifPlant({ cls:s.class, seedName:s.class, floorName:`Floor ${t.floorIdx}`, potId:t.slot, mutation:s.mutation, seed:s });
    } catch (e) {
      showError(e, 'plant-all');
    }
  }
  alert(`Đã trồng ${planted} seed.`);
  await refresh();
}

/* ===== INVENTORY: Master–Detail (new) ===== */
// Lấy seeds đang hiển thị theo filter hiện có
function getFilteredSeedsForMasterDetail(){
  const list = Array.isArray(state?.seedInv) ? state.seedInv.slice() : [];
  const f = getInventoryFilters();
  return list.filter(s => seedMatchFilter(s, f));
}

// Gom nhóm cho cột trái (mặc định theo class; có thể đổi sang s.name nếu có)
function groupForMaster(list){
  const by = new Map(); // key -> { key, count }
  for (const s of list){
    const key = s.class; // đổi thành s.name nếu có field tên riêng
    const o = by.get(key) || { key, count:0 };
    o.count++; by.set(key, o);
  }
  return Array.from(by.values()).sort((a,b)=> a.key.localeCompare(b.key));
}

let _invSelectedKey = null;
function renderInvMasterDetail(){
  const left = document.getElementById('invMaster');
  const right = document.getElementById('invDetail');
  if (!left || !right) return;

  const filtered = getFilteredSeedsForMasterDetail();
  const groups = groupForMaster(filtered);

  // chọn mặc định / hoặc reset nếu key hiện tại không còn nữa
  if (!_invSelectedKey && groups[0]) _invSelectedKey = groups[0].key;
  if (_invSelectedKey && !groups.find(g => g.key === _invSelectedKey)) {
    _invSelectedKey = groups[0]?.key || null;
  }

  // render cột trái
  left.innerHTML = '';
  if (groups.length === 0){
    left.innerHTML = '<li><small>Không có seed phù hợp filter.</small></li>';
  } else {
    for (const g of groups){
      const li = document.createElement('li');
      li.className = g.key === _invSelectedKey ? 'active' : '';
      li.innerHTML = `<b>${g.key}</b> <span class="count">${g.count}</span>`;
      li.addEventListener('click', ()=>{
        _invSelectedKey = g.key;
        renderInvMasterDetail(); // re-render cả 2 cột
      });
      left.appendChild(li);
    }
  }

  // render cột phải: các seed thuộc nhóm đang chọn
  right.innerHTML = '';
  const rows = filtered.filter(s => (s.class === _invSelectedKey));
  if (rows.length === 0){
    right.innerHTML = '<li><small>Chưa có item trong nhóm này.</small></li>';
  } else {
    for (const s of rows){
      const li = document.createElement('li');
      const mut = getMutationMeta(s);
      li.innerHTML = `
        <div><b>#${s.id} ${s.class}</b></div>
        ${mut ? `<div class="mut" style="background:${mut.color};color:${pickTextColorForBg(mut.color)};border-color:${mut.color}">${mut.name} ×${mut.mult}</div>` : ''}
        <div class="meta">base: ${s.base_price ?? '-'}</div>
      `;
      right.appendChild(li);
    }
  }
}

/* ---------- SELECTS & POPULATE ---------- */
function populateSelects(){
  if (!state) return;

  const sellSel = $('#sellSeedSelect');
  if (sellSel){
    preserveSelectValue(sellSel, ()=>{
      sellSel.innerHTML = '';
      state.seedInv.filter(s=>s.is_mature===1).forEach(s=>{
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = decorateSeedText(s);
        sellSel.appendChild(o);
      });
    });
  }

  const listSel = $('#listSeedSelect');
  if (listSel){
    preserveSelectValue(listSel, ()=>{
      listSel.innerHTML = '';
      state.seedInv.filter(s=>s.is_mature===1).forEach(s=>{
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = decorateSeedText(s);
        listSel.appendChild(o);
      });
    });
    const priceInput = $('#listPrice');
    const syncHint = ()=>{
      const sid = parseInt(listSel.value,10);
      const seed = (state?.seedInv||[]).find(x=>x.id===sid);
      if (!seed || !priceInput) return;
      const base = seed.base_price || 0;
      const min = Math.floor(base * 0.9);
      const max = Math.floor(base * 1.5);
      priceInput.placeholder = `${min} - ${max}`;
    };
    listSel.addEventListener('change', syncHint);
    setTimeout(syncHint, 0);
  }

  const matUl = $('#matureByClass');
  if (matUl){
    matUl.innerHTML='';
    const by = groupMatureByClass();
    Object.keys(by).sort().forEach(cls=>{
      const li = document.createElement('li');
      li.dataset.mature = "1";
      li.textContent = `${cls}: ${by[cls]}`;
      matUl.appendChild(li);
    });
  }

  const selA = $('#breedSelectA'), selB = $('#breedSelectB');
  if (selA && selB){
    const oldA = selA.value, oldB = selB.value;
    selA.innerHTML=''; selB.innerHTML='';
    state.seedInv.filter(s=>s.is_mature===1).forEach(s=>{
      const oa=document.createElement('option'); oa.value=s.id; oa.textContent=decorateSeedText(s); selA.appendChild(oa);
      const ob=document.createElement('option'); ob.value=s.id; ob.textContent=decorateSeedText(s); selB.appendChild(ob);
    });
    if (Array.from(selA.options).some(o=>o.value===oldA)) selA.value = oldA;
    if (Array.from(selB.options).some(o=>o.value===oldB)) selB.value = oldB;
  }

  const floorSel = $('#plantFloor');
  if (floorSel){
    preserveSelectValue(floorSel, ()=>{
      floorSel.innerHTML='';
      state.floors.forEach(f=>{
        const o=document.createElement('option');
        o.value=f.id; o.textContent=`Floor ${f.idx}`;
        floorSel.appendChild(o);
      });
    });
  }
  const slotSel = $('#plantSlot');
  if (slotSel){
    preserveSelectValue(slotSel, ()=>{
      slotSel.innerHTML='';
      for(let i=1;i<=10;i++){
        const o=document.createElement('option');
        o.value=i; o.textContent=`Slot ${i}`;
        slotSel.appendChild(o);
      }
    });
  }
  const potSel = $('#plantPot');
  if (potSel){
    preserveSelectValue(potSel, ()=>{
      potSel.innerHTML='';
      state.potInv.forEach(p=>{
        const o=document.createElement('option');
        o.value=p.id; o.textContent=`#${p.id} ${p.type}`;
        potSel.appendChild(o);
      });
    });
  }
  const seedSel = $('#plantSeed');
  if (seedSel){
    preserveSelectValue(seedSel, ()=>{
      seedSel.innerHTML='';
      state.seedInv.filter(s=>s.is_mature===0).forEach(s=>{
        const o=document.createElement('option');
        o.value=s.id; o.textContent=decorateSeedText(s);
        seedSel.appendChild(o);
      });
    });
  }

  ensureInventoryClassOptions();
  // THAY renderInventorySeeds() bằng master–detail renderer
  renderInvMasterDetail();
}

function nextFloorPrice(){
  const floors = state?.floors || [];
  const maxIdx = floors.reduce((m,f)=>Math.max(m, f.idx), 0);
  const nextIdx = maxIdx + 1;
  return (nextIdx === 1) ? 0 : nextIdx * 1000;
}
function renderBuyFloorPrice(){
  const el = $('#buyFloorPrice');
  if (!el || !state) return;
  const floors = state.floors||[];
  const maxIdx = floors.reduce((m,f)=>Math.max(m,f.idx),0);
  const nextIdx = maxIdx + 1;
  el.textContent = `Giá mở tầng ${nextIdx}: ${nextFloorPrice()} coins`;
}

// --- helpers để tô màu badge theo mutation ---
function hexToRgb(hex){
  const m = String(hex || '').replace('#','').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if(!m) return {r:0,g:0,b:0};
  let h = m[1];
  if(h.length===3) h = h.split('').map(c=>c+c).join('');
  const n = parseInt(h,16);
  return { r:(n>>16)&255, g:(n>>8)&255, b:n&255 };
}
function pickTextColorForBg(hex){
  const {r,g,b} = hexToRgb(hex);
  const lum = (0.2126*(r/255) + 0.7152*(g/255) + 0.0722*(b/255));
  return lum > 0.6 ? '#041326' : '#ffffff';
}
function addMutationBadge(container, obj) {
  const m = getMutationMeta(obj);
  if (!m) return;
  const badge = document.createElement('div');
  badge.className = 'mut-tag';
  badge.textContent = m.name;
  badge.title = `${m.name} ×${m.mult}`;
  if (m.color){
    badge.style.background = m.color;
    badge.style.color = pickTextColorForBg(m.color);
    badge.style.borderColor = m.color;
    badge.style.boxShadow = `0 0 12px ${m.color}66`;
  }
  container.appendChild(badge);
}

/* ====== HIỂN THỊ 2 TẦNG / TRANG + LƯU localStorage ====== */
const LS_FLOOR_PAGE_KEY = 'floor_page';
let floorPage = 0;
function loadFloorPageFromStorage(){
  try{ const v = parseInt(localStorage.getItem(LS_FLOOR_PAGE_KEY),10);
    if (Number.isFinite(v) && v>=0) floorPage = v; }catch{}
}
function saveFloorPageToStorage(){
  try{ localStorage.setItem(LS_FLOOR_PAGE_KEY, String(floorPage)); }catch{}
}
loadFloorPageFromStorage();
function getTotalFloorPagesFromState(s){
  const totalFloors = (s?.plots || []).length;
  return Math.max(1, Math.ceil(totalFloors / 2));
}
function clampFloorPageForState(s){
  const total = getTotalFloorPagesFromState(s);
  if (floorPage >= total) floorPage = total - 1;
  if (floorPage < 0) floorPage = 0;
}
function getVisibleFloorPairs(s){
  const list = s?.plots || [];
  const start = floorPage * 2;
  return list.slice(start, start + 2);
}

/* ====== VIRTUALIZE PLOTS ====== */
const visibleTimerPlots = new Set();
let plotRenderObserver = null;
let timerVisObserver = null;
function ensureObservers(){
  if (!plotRenderObserver){
    plotRenderObserver = new IntersectionObserver(entries=>{
      for (const ent of entries){
        const placeholder = ent.target;
        if (!ent.isIntersecting) continue;
        const p = placeholder.__plotData;
        if (!p) { plotRenderObserver.unobserve(placeholder); continue; }
        const real = buildPlotElement(p);
        placeholder.replaceWith(real);
        plotRenderObserver.unobserve(placeholder);
        timerVisObserver?.observe(real);
      }
    }, { root:null, rootMargin:'400px 0px', threshold:0.01 });
  }
  if (!timerVisObserver){
    timerVisObserver = new IntersectionObserver(entries=>{
      for (const ent of entries){
        const el = ent.target;
        if (ent.isIntersecting) {
          visibleTimerPlots.add(el);
          updatePlotTimer(el);
        } else {
          visibleTimerPlots.delete(el);
        }
      }
    }, { root:null, rootMargin:'100px 0px', threshold:0.01 });
  }
}
function buildPlotPlaceholder(p){
  const ph = document.createElement('div');
  ph.className = 'plot';
  ph.style.minHeight = '260px';
  ph.innerHTML = `<div class="skeleton" style="height:100%;"></div>`;
  ph.dataset.plotId = p.id;     // ← thêm
  ph.dataset.slot = p.slot;
  ph.__plotData = p;
  return ph;
}

/* ====== FIX: mỗi plot chỉ giữ 1 ảnh pot + 1 ảnh plant mới nhất ====== */
function setSingleImages(visual){
  if (!visual) return;
  // Xóa toàn bộ ảnh cũ nếu có (bất kỳ render trước đó)
  visual.querySelectorAll('img.plant, img.pot').forEach(n => n.remove());
}

function buildPlotElement(p){
  const el=document.createElement('div');
  el.className='plot';
  el.dataset.plotId=p.id;
  el.dataset.stage=p.stage||'empty';
  el.dataset.class=p.class||'';
  el.dataset.slot=p.slot;
  if(p.mature_at) el.dataset.matureAt=p.mature_at;
  if (p.mutation_name || p.mutation) el.dataset.mutation = p.mutation_name || p.mutation;
  // NEW: lock state
  el.dataset.locked = (p.locked ? '1' : '0');
  const meta = getMutationMeta(p);
  el.title = meta ? `${p.class} [${meta.name} ×${meta.mult}]` : (p.class || 'empty');

  const stats=document.createElement('div'); stats.className='stats';
  const lines = [];
  lines.push(`<div class="stat cls"><div class="label">Class</div><div class="value">${p.class||'empty'}</div></div>`);
  lines.push(`<div class="stat time"><div class="label">Time left</div><div class="value"></div></div>`);
  if (p.mutation_name || Number.isFinite(p?.mutation_mult)) {
    const mutText = `${p.mutation_name || 'mutation'}${Number.isFinite(p?.mutation_mult) ? ` ×${p?.mutation_mult}` : ''}`;
    lines.push(`<div class="stat mut"><div class="label">Mut</div><div class="value">${mutText}</div></div>`);
  }
  // NEW: lock indicator
  lines.push(`<div class="stat lock"><div class="label">Lock</div><div class="value">${p.locked ? 'ON' : 'OFF'}</div></div>`);
  stats.innerHTML = lines.join('');

  const visual=document.createElement('div'); visual.className='visual';
  // ĐẢM BẢO CHỈ 1 ẢNH MỚI NHẤT
  setSingleImages(visual);

  if(p.pot_type){
    const pot=document.createElement('img'); pot.className='pot';
    pot.src=`/assets/Pots_Image/${p.pot_type==='gold'?'pot2.png':(p.pot_type==='timeskip'?'pot3.png':'pot1.png')}`;
    pot.loading = 'lazy';
    // Đảm bảo fit card (thêm guard JS, ngoài CSS)
    pot.style.objectFit = 'contain';
    visual.appendChild(pot);
  }
  if(p.class&&p.stage){
    const folder = p.stage==='planted' ? 'Seed_Planted' : (p.stage==='growing' ? 'Seed_Growing' : 'Seed_Mature');
    const plant = document.createElement('img'); plant.className = 'plant';
    plant.src = `/assets/${folder}/seed_${p.stage}_${p.class}.png`;
    plant.loading = 'lazy';
    // Fit với card
    plant.style.objectFit = 'contain';
    visual.appendChild(plant);
    const mmeta = getMutationMeta(p);
    if (mmeta?.key) applyMutationFilterToPlant(plant, mmeta.key);
    addMutationBadge(visual, p);
  }

  // NEW: lock toggle button
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'btn-lock';
  const locked = !!p.locked;
  lockBtn.textContent = locked ? '🔒' : '🔓';
  lockBtn.title = locked ? 'Unlock plot' : 'Lock plot';
  stats.appendChild(lockBtn);

  if(p.stage==='mature') el.classList.add('mature');
  el.classList.toggle('is-locked', !!p.locked);
  el.append(stats, visual);

  return el;
}
function virtualizePlotsInto(container, plots){
  ensureObservers();
  container.innerHTML = '';
  for (const p of plots){
    const ph = buildPlotPlaceholder(p);
    container.appendChild(ph);
    plotRenderObserver.observe(ph);
  }
}

/* ========== SMOOTH RENDER CONTROL (anti-blink) ========== */
let _lastFloorsSig = '';
function computeFloorsSig(s){
  try{
    const parts = (s?.plots||[]).map(fp=>[
      fp.floor?.id, fp.floor?.idx,
      ...(fp.plots||[]).map(p=>[p.id,p.stage,p.class,p.mature_at,p.pot_type,p.mutation_name,p.mutation_mult,p.locked?1:0])
    ]);
    return JSON.stringify(parts);
  }catch{ return ''; }
}

/* ---------- RENDER STATE (soft/atomic) ---------- */
function renderState(s, opts = {}){
  state=s;
  ensureFarmAutoControls();
  $('#hudUser').textContent = s.me.username;

  const coinsEl = $('#hudCoins');
  if (coinsEl.textContent !== String(s.me.coins)) {
    coinsEl.textContent = s.me.coins;
    coinsEl.classList.add('updated');
    setTimeout(()=>coinsEl.classList.remove('updated'), 600);
  }

  const priceEl = $('#trapPrice'); if (priceEl) priceEl.textContent = (s.trapPrice ?? '-');
  const maxEl   = $('#trapMax');  if (maxEl)   maxEl.textContent   = (s.trapMax ?? '-');

  const floorsDiv=$('#floors');
  if(floorsDiv){
    const newSig = computeFloorsSig(s);
    const shouldRebuildFloors = opts.forceFloors === true || !opts.soft || newSig !== _lastFloorsSig;
    if (shouldRebuildFloors){
      snapshotFloorActionSelections();

      const frag = document.createDocumentFragment();
      clampFloorPageForState(s);
      saveFloorPageToStorage();
      const visibleFloorPairs = getVisibleFloorPairs(s);

      visibleFloorPairs.forEach(fp=>{
        const f=document.createElement('div'); f.className='floor'; f.dataset.floorId=fp.floor.id;
        f.innerHTML=`<h3>Floor ${fp.floor.idx}</h3>`;

        const wrap=document.createElement('div'); wrap.className='plots';
        virtualizePlotsInto(wrap, fp.plots);
        f.appendChild(wrap);
        frag.appendChild(f);
});

      const maxIdx = (s.floors||[]).reduce((m,f)=>Math.max(m,f.idx),0);
      const price = nextFloorPrice();
      const card=document.createElement('div'); card.className='buy-floor-card';
      card.innerHTML=`<div class="price">Mở tầng ${maxIdx+1}: <b>${price}</b> coins</div><button class="do-buy-floor">Buy Floor</button>`;
      const bfBtn = card.querySelector('.do-buy-floor');
      bfBtn.addEventListener('click', withCooldown(bfBtn, async()=>{
        if(!confirm(`Mở tầng ${maxIdx+1} với giá ${price} coins?`))return;
        try{
          await api('/floors/buy',{});
          notifInfo('Đã mở tầng', `Floor ${maxIdx+1}`, `Giá ${price} coins`);
          await refresh();
        }catch(err){showError(err,'buy-floor');}
      }));
      frag.appendChild(card);

      const totalPages = getTotalFloorPagesFromState(s);
      const nav = document.createElement('div');
      nav.className = 'floor-nav';
      nav.innerHTML = `
        <button class="btn prev" ${floorPage===0?'disabled':''}>Previous floor</button>
        <div class="page-indicator">Page ${floorPage+1}/${totalPages}</div>
        <button class="btn next" ${floorPage>=totalPages-1?'disabled':''}>Next floor</button>`;
      nav.querySelector('.prev')?.addEventListener('click', ()=>{
        if (floorPage>0){ floorPage--; saveFloorPageToStorage(); renderState(state, {forceFloors:true}); }
      });
      nav.querySelector('.next')?.addEventListener('click', ()=>{
        if (floorPage<totalPages-1){ floorPage++; saveFloorPageToStorage(); renderState(state, {forceFloors:true}); }
      });
      frag.appendChild(nav);

      // --- Anti-blink: atomic replace trong rAF ---
      requestAnimationFrame(()=> {
        $('#floors').replaceChildren(frag);
        restoreFloorActionSelections();
        _lastFloorsSig = newSig;
      });
    }
  }

  populateSelects();
  renderShop();
  renderBuyFloorPrice();
  renderMarketListings();

  // Ẩn (gỡ) nút Floor lên/xuống cũ trước Harvest All nếu còn tồn tại
  removeLegacyFloorButtons();

  // Soft hook: nếu tab Gacha đang mở, đồng bộ lại gacha header nhanh
  if (document.querySelector('.tabs button.active')?.dataset.tab === 'gacha') {
    gachaSoftRefresh();
  }
}
async function refresh(opts = {}){
  const data = await get('/me/state');
  renderState(data, opts);
}

/* ---------- AUTH ---------- */
$('#btnLogin').addEventListener('click', async ()=>{
  const username=$('#username').value.trim();
  if(!username) return alert('Enter username');
  await api('/auth/login',{username});
  showApp();
  await refresh();
  connectWS();
});

/* ---------- TABS ---------- */
$$('.tabs button').forEach(b=>b.addEventListener('click', ()=> {
  setActive(b.dataset.tab);
  if (b.dataset.tab==='online') maybeLoadOnline();
  if (b.dataset.tab==='gacha') gachaMaybeLoad();
}));
let _lastOnlineLoad = 0;
function maybeLoadOnline(){
  const now = Date.now();
  if (now - _lastOnlineLoad < 1500) return;
  _lastOnlineLoad = now;
  loadOnline();
}

/* ---------- SHOP SUBTABS ---------- */
$('#shop')?.addEventListener('click', (e)=>{
  const b = e.target.closest('#shopTabs button');
  if (!b) return;
  $('#shopTabs').querySelectorAll('button').forEach(x=>x.classList.toggle('active', x===b));
  ['shopSeeds','shopPots','shopTrap'].forEach(id=>{
    $('#'+id).classList.toggle('hidden', b.dataset.sub !== id);
  });
});

/* ---------- SUBTABS INVENTORY ---------- */
$$('.subtabs button').forEach(b=>b.addEventListener('click', ()=>{
  $$('.subtabs button').forEach(x=>x.classList.toggle('active', x===b));
  $$('.subtab').forEach(sec=>sec.classList.add('hidden'));
  $('#'+b.dataset.sub).classList.remove('hidden');
}));

/* ---------- INVENTORY FILTER EVENTS + PLANT ALL ---------- */
$('#fltInvState')?.addEventListener('change', renderInvMasterDetail);
$('#fltInvClass')?.addEventListener('change', renderInvMasterDetail);
$('#fltInvMut')?.addEventListener('change', renderInvMasterDetail);
$('#btnPlantAll')?.addEventListener('click', plantAllFiltered);

/* ---------- SHOP / TRAP ---------- */
$('#buyTrap')?.addEventListener('click', (ev)=>{
  const btn = ev.currentTarget;
  withCooldown(btn, async ()=>{
    try{
      await api('/shop/buy-trap',{});
      notifBuy({ what:'trap', qty:1, price: state?.trapPrice, where:'Shop' });
      await refresh();
    }catch(e){ showError(e,'buy-trap'); }
  })();
});

/* ---------- SELL ---------- */
$('#btnSellShop')?.addEventListener('click', async ()=>{
  const id = parseInt($('#sellSeedSelect').value,10);
  if(!id) return;
  try{
    const r = await api('/sell/shop',{ seedId:id });
    notifSell({ what:`seed #${id}`, qty:1, price:r.paid });
    alert('Paid '+r.paid);
    await refresh();
  }catch(e){ showError(e, 'sell'); }
});

/* ---------- BREED ---------- */
$('#btnBreed')?.addEventListener('click', async ()=>{
  const a=parseInt($('#breedSelectA').value,10), b=parseInt($('#breedSelectB').value,10);
  if(!a||!b) return;
  if (a===b) return alert('Chọn 2 cây khác nhau');
  try{
    const r = await api('/breed',{ seedAId:a, seedBId:b });
    $('#breedOut').innerHTML = `${renderMutationBadge(r.mutation)} Out: <b>${r.outClass}</b> (base ${r.base})`;
    renderBreedCard({ mutation: r.mutation, seedName: r.outClass, resultClass: r.outClass });
    notifBreed({ resultCls:r.outClass, parents:[`#${a}`, `#${b}`], mutation:r.mutation, base:r.base });
    await refresh();
  }catch(e){ showError(e, 'breed'); }
});
// Random Breed (cooldown 1s + render card)
(function bindRandomBreed(){
  const btnRB = document.getElementById('btnRandomBreed');
  if (!btnRB) return;
  btnRB.addEventListener('click', withCooldown(btnRB, async ()=>{
    const inv = (window.state?.seedInv || state?.seedInv || []).filter(s => s.is_mature === 1);
    const breedOut = document.getElementById('breedOut');
    const byClass = {};
    for (const s of inv) (byClass[s.class] ||= []).push(s);
    const classes = Object.keys(byClass);
    if (classes.length < 2) {
      if (breedOut) breedOut.textContent = 'Cần ít nhất 2 hạt mature thuộc 2 class khác nhau!';
      return;
    }
    const i = Math.floor(Math.random()*classes.length);
    let j = Math.floor(Math.random()*(classes.length-1));
    if (j >= i) j++;
    const c1 = classes[i], c2 = classes[j];
    const seed1 = byClass[c1][Math.floor(Math.random()*byClass[c1].length)];
    const seed2 = byClass[c2][Math.floor(Math.random()*byClass[c2].length)];
    const selA = document.getElementById('breedSelectA');
    const selB = document.getElementById('breedSelectB');
    if (selA && selB) {
      selA.value = String(seed1.id);
      selB.value = String(seed2.id);
      document.getElementById('btnBreed')?.click();
    }
  }));
})();

/* ---------- MARKET ---------- */
$('#btnList')?.addEventListener('click', async ()=>{
  const id=parseInt($('#listSeedSelect').value,10);
  const price=parseInt($('#listPrice').value,10);
  if(!id||!price) return;
  try{
    await api('/market/list',{ seedId:id, askPrice:price });
    notifyBus.show({ type:'info', title:'Đã niêm yết', desc:`#${id}`, meta:`Giá ${price}` });
    await refresh();
  }catch(e){ showError(e, 'market-list'); }
});
$('#marketList')?.addEventListener('click', async (e)=>{
  const b=e.target.closest('.buy-listing');
  if(!b) return;
  if (b.disabled) return;
  b.disabled = true;
  try{
    const id=parseInt(b.dataset.id,10);
    await api('/market/buy',{ listingId:id });
    notifBuy({ what:`listing #${id}`, qty:1, where:'Market' });
    await refresh();
  }catch(e){ showError(e, 'market-buy'); }
  finally {
    setTimeout(()=>{ b.disabled = false; }, COOLDOWN_MS);
  }
});

/* ---------- FORM cũ ---------- */
$('#btnPlacePot')?.addEventListener('click', async ()=>{
  const floorId=parseInt($('#plantFloor').value,10);
  const slot=parseInt($('#plantSlot').value,10);
  const potId=parseInt($('#plantPot').value,10);
  if(!floorId||!slot||!potId) return;
  try{
    await api('/plot/place-pot',{ floorId, slot, potId });
    notifInfo('Đã đặt pot', `#${potId}`, `FloorId ${floorId} · Slot ${slot}`);
    await refresh();
  }catch(e){ showError(e, 'place-pot'); }
});
$('#btnPlant')?.addEventListener('click', async ()=>{
  const floorId = parseInt($('#plantFloor').value,10);
  const slot = parseInt($('#plantSlot').value,10);
  const seedId = parseInt($('#plantSeed').value,10);
  const mutation= $('#plantMutation')?.value || null;
  if(!floorId||!slot||!seedId) return;
  try{
    await api('/plot/plant',{ floorId, slot, seedId, mutation });
    const sseed = (state?.seedInv||[]).find(x=>x.id===seedId);
    notifPlant({ cls:sseed?.class, seedName:sseed?.class, floorName:`FloorId ${floorId}`, potId:slot, mutation: mutation || sseed?.mutation, seed:sseed });
    await refresh();
  }catch(e){ showError(e, 'plant'); }
});

/* ---------- ONLINE (Visit & Steal) ---------- */
async function loadOnline(){
  try{
    const r = await get('/online');
    const ul=$('#onlineList');
    if (!ul) return;
    ul.innerHTML='';
    r.users.forEach(async (u)=>{
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="row"><b>${u.username}</b> (#${u.id})
          <select class="visit-floor" data-uid="${u.id}"></select>
          <button class="visit" data-uid="${u.id}">Visit</button>
        </div>
        <div class="visit-view" id="visit-${u.id}"></div>`;
      ul.appendChild(li);
      try{
        const f = await get('/visit/floors?userId='+u.id);
        const sel = li.querySelector('.visit-floor');
        preserveSelectValue(sel, ()=>{
          sel.innerHTML='';
          f.floors.forEach(fl=>{
            const o=document.createElement('option');
            o.value=fl.id; o.textContent=`Floor ${fl.idx} (traps ${fl.trap_count})`;
            sel.appendChild(o);
          });
        });
        sel.addEventListener('change', ()=>{
          const view = li.querySelector('#visit-'+u.id);
          if (view) view.innerHTML='';
        });
      }catch(e){}
    });
  }catch(e){ console.log(e); }
}
function clearAllVisitViews(){ $$('.visit-view').forEach(v=>v.innerHTML=''); }
async function renderVisitedFloor(uid, floorId){
  const container = document.querySelector('#visit-'+uid);
  if (!container) return;
  container.innerHTML = '<div class="skeleton"></div>';
  try {
    const data = await get('/visit/floor?floorId='+floorId);
    container.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'plots';
    data.plots.forEach(p=>{
      const el = buildPlotElement(p);
if (p.stage === 'mature') {
const steal = document.createElement('button');
steal.className = 'btn-steal';
steal.textContent = 'Steal';
steal.title = 'Ăn trộm hạt mature từ plot này';
const statsBox = el.querySelector('.stats');
(statsBox || el).appendChild(steal);
steal.addEventListener('click', async ()=>{
try{
const r = await api('/visit/steal-plot', { targetUserId: uid, floorId: floorId, plotId: p.id });
// ...
}catch(e){ showError(e,'steal'); }
});
}
      ensureObservers();
      timerVisObserver?.observe(el);
      wrap.appendChild(el);
    });
    container.appendChild(wrap);
  } catch(e) { console.log(e); }
}
$('#onlineList')?.addEventListener('click', async (e)=>{
  const btn = e.target.closest('.visit');
  if (!btn) return;
  const uid = parseInt(btn.dataset.uid, 10);
  const li = btn.closest('li');
  const sel = li.querySelector('.visit-floor');
  const floorId = parseInt(sel?.value, 10);
  if (!floorId) return;
  clearAllVisitViews();
  await renderVisitedFloor(uid, floorId);
});

/* ---------- FLOOR NAV (legacy buttons removed automatically) ---------- */
function removeLegacyFloorButtons(){
  // Loại bỏ 2 nút ↑ Floor / ↓ Floor nếu vẫn còn trong DOM trước nút Harvest All
  $('#btnPrevFloor')?.remove();
  $('#btnNextFloor')?.remove();
}
function ensureFloorVisible(){
  const floors = $$('#floors .floor');
  if (floors.length===0) return;
  currentFloorIdx = Math.max(0, Math.min(currentFloorIdx, floors.length-1));
  floors[currentFloorIdx].scrollIntoView({behavior:'smooth', block:'center'});
}
$('#btnPrevFloor')?.addEventListener('click', ()=>{
  currentFloorIdx = Math.max(0, currentFloorIdx-1);
  ensureFloorVisible();
});
$('#btnNextFloor')?.addEventListener('click', ()=>{
  const n = $$('#floors .floor').length;
  currentFloorIdx = Math.min(n-1, currentFloorIdx+1);
  ensureFloorVisible();
});

/* ---------- HARVEST ALL ---------- */
async function harvestAllMature() {
  const btn = document.getElementById('btnHarvestAll');
  if (btn) btn.disabled = true;
  try {
    const r = await api('/plot/harvest-all', {});
    alert(`Đã thu hoạch ${r.harvested} plot mature`);
    notifyBus.show({ type:'success', title:'Harvest', desc:`${r.harvested} plots (bỏ qua ô lock)` });
    await refresh();
  } catch (e) {
    showError(e, 'harvest-all');
  } finally {
    if (btn) btn.disabled = false;
  }
}
document.getElementById('btnHarvestAll')?.addEventListener('click', harvestAllMature);

/* ---------- WS & timers ---------- */
let ws;
let _wsPendingPayload = null;
let _wsTimer = null;
function connectWS(){
  ws = new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host);
  ws.onmessage = (ev)=>{
    try{
      const msg=JSON.parse(ev.data);
      if(msg.type==='state:update'){
        _wsPendingPayload = msg.payload;
        if (_wsTimer) return;
        _wsTimer = setTimeout(()=>{
          const payload = _wsPendingPayload;
          _wsPendingPayload = null;
          _wsTimer = null;
          // Anti-blink: chỉ soft refresh, không force rebuild floors
          renderState(payload, { soft:true });
        }, 120);
      }
    }catch(e){}
  };
}
function fmtMs(ms){
  if (ms<=0) return 'Mature';
  const s=Math.ceil(ms/1000);
  const m=Math.floor(s/60);
  const r=s%60;
  return `${m}:${String(r).padStart(2,'0')}`;
}
function updatePlotTimer(el){
  const tVal = el.querySelector('.stat.time .value');
  if (!tVal) return;
  const st = el.dataset.stage;
  if (st === 'mature'){
    tVal.textContent = 'Mature';
    return;
  }
  const mAt = +el.dataset.matureAt || 0;
  const now = Date.now();
  tVal.textContent = mAt ? fmtMs(mAt - now) : '';
}
function tickTimers(){
  if (visibleTimerPlots.size === 0) return;
  for (const el of visibleTimerPlots){
    updatePlotTimer(el);
  }
}
setInterval(tickTimers, 1000);

/* ===== Auto Pot / Auto Plant ===== */
const Auto = {
  pot: false,
  plant: false,
  _busy: false,
  _timerId: null,
  filters: {
    useAllClasses: true,
    classes: {},
    pots: { timeskip:true, gold:true, basic:true },
    useAllMuts: true,
    muts: {}
  },
  // UI collapse state cho từng nhóm filter
  ui: { clsOpen:false, potOpen:false, mutOpen:false }
};
function autoSave(){
  try {
    localStorage.setItem('auto_settings', JSON.stringify({
      pot: Auto.pot, plant: Auto.plant, filters: Auto.filters, ui: Auto.ui
    }));
  } catch {}
}
function autoLoad(){
  try{
    const raw = localStorage.getItem('auto_settings');
    if(!raw) return;
    const obj = JSON.parse(raw);
    if (typeof obj.pot === 'boolean') Auto.pot = obj.pot;
    if (typeof obj.plant === 'boolean') Auto.plant = obj.plant;
    if (obj.filters){
      Auto.filters.useAllClasses = (obj.filters.useAllClasses !== undefined) ? !!obj.filters.useAllClasses : true;
      if (obj.filters.classes && typeof obj.filters.classes === 'object') {
        Auto.filters.classes = { ...obj.filters.classes };
      }
      if (obj.filters.pots && typeof obj.filters.pots === 'object') {
        Auto.filters.pots = { timeskip:true, gold:true, basic:true, ...obj.filters.pots };
      }
      if (obj.filters.useAllMuts !== undefined) Auto.filters.useAllMuts = !!obj.filters.useAllMuts;
      if (obj.filters.muts && typeof obj.filters.muts === 'object') {
        Auto.filters.muts = { ...obj.filters.muts };
      }
    }
    if (obj.ui && typeof obj.ui === 'object') {
      Auto.ui = { clsOpen:false, potOpen:false, mutOpen:false, ...obj.ui };
    }
  }catch{}
}
autoLoad();

function getAvailableClassesFromState(){
  const set = new Set();
  (state?.seedInv||[]).forEach(s=>{ if (s && s.class) set.add(s.class); });
  return Array.from(set).sort();
}

// Tạo 1 nhóm filter thu gọn: chỉ hiện "All" + nút "›" để bung + thêm nút Clear
function buildCollapsedFilterGroup({ titleText, allChecked, onToggleAll, isOpen, onToggleOpen, chips, onClearAll }){
  const group = document.createElement('div'); group.className = 'filter-group';
  const label = document.createElement('span'); label.className = 'label'; label.textContent = titleText;
  group.appendChild(label);

  // All chip
  const allWrap = document.createElement('label'); allWrap.className = 'chip';
  allWrap.title = `Allow all ${titleText.toLowerCase()}`;
  allWrap.innerHTML = `<input type="checkbox" ${allChecked ? 'checked':''}> <span>All</span>`;
  allWrap.querySelector('input').addEventListener('change', (e)=>{
    onToggleAll(!!e.target.checked);
    autoSave();
    // Khi tắt All, tự động bung để người dùng chọn chi tiết
    if (!e.target.checked && !isOpen()) {
      onToggleOpen(true);
      autoSave();
      ensureFarmAutoControls();
    } else {
      // Khi bật All, re-render để vô hiệu hoá các chip con
      ensureFarmAutoControls();
    }
  });
  group.appendChild(allWrap);

  // Nút Clear All (Remove all tick)
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost';
  clearBtn.textContent = 'Clear';
  clearBtn.title = `Bỏ chọn tất cả ${titleText.toLowerCase()}`;
  clearBtn.style.padding = '6px 10px';
  clearBtn.addEventListener('click', ()=>{
    onClearAll?.();
    autoSave();
    ensureFarmAutoControls();
  });
  group.appendChild(clearBtn);

  // Nút "›" bung/thu
  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'btn btn-ghost';
  toggleBtn.textContent = isOpen() ? '‹' : '›';
  toggleBtn.style.padding = '6px 10px';
  toggleBtn.title = isOpen() ? 'Thu gọn' : 'Mở toàn bộ';
  toggleBtn.addEventListener('click', ()=>{
    onToggleOpen(!isOpen());
    autoSave();
    ensureFarmAutoControls();
  });
  group.appendChild(toggleBtn);

  // Nếu đang mở: hiện toàn bộ chip con
  if (isOpen()){
    chips.forEach(c=>{
      const wrap = document.createElement('label'); wrap.className = 'chip'; wrap.title = c.label;
      wrap.innerHTML = `<input type="checkbox" ${c.checked ? 'checked':''} ${c.disabled ? 'disabled':''}> <span>${c.label}</span>`;
      wrap.querySelector('input').addEventListener('change', (e)=>{
        c.onChange?.(!!e.target.checked);
        autoSave();
      });
      group.appendChild(wrap);
    });
  }
  return group;
}

// Sync text/trạng thái 2 nút Auto khi thay đổi từ nơi khác
function syncAutoButtons(){
  const btnPot = document.querySelector('#farmControls .btnAutoPot');
  if (btnPot){
    btnPot.classList.toggle('active', Auto.pot);
    btnPot.textContent = 'Auto Pot: ' + (Auto.pot ? 'ON' : 'OFF');
  }
  const btnPlant = document.querySelector('#farmControls .btnAutoPlant');
  if (btnPlant){
    btnPlant.classList.toggle('active', Auto.plant);
    btnPlant.textContent = 'Auto Plant: ' + (Auto.plant ? 'ON' : 'OFF');
  }
}

function ensureFarmAutoControls(){
  const bar = document.getElementById('farmControls');
  if (!bar) return;

  // --- Auto Pot button ---
  let btnPot = bar.querySelector('.btnAutoPot');
  if (!btnPot) {
    btnPot = document.createElement('button');
    btnPot.className = 'btnAutoPot';
    const syncBtnPot = ()=> {
      btnPot.classList.toggle('active', Auto.pot);
      btnPot.textContent = 'Auto Pot: ' + (Auto.pot ? 'ON' : 'OFF');
    };
    btnPot.addEventListener('click', ()=>{
      Auto.pot = !Auto.pot; syncBtnPot(); autoSave();
      notifyBus.show({ type: Auto.pot?'success':'warn', title:'Auto Pot', desc: Auto.pot?'ON':'OFF' });
    });
    syncBtnPot();
    bar.appendChild(btnPot);
  } else {
    btnPot.classList.toggle('active', Auto.pot);
    btnPot.textContent = 'Auto Pot: ' + (Auto.pot ? 'ON' : 'OFF');
  }

  // --- Auto Plant button ---
  let btnPlant = bar.querySelector('.btnAutoPlant');
  if (!btnPlant) {
    btnPlant = document.createElement('button');
    btnPlant.className = 'btnAutoPlant';
    const syncBtnPlant = ()=> {
      btnPlant.classList.toggle('active', Auto.plant);
      btnPlant.textContent = 'Auto Plant: ' + (Auto.plant ? 'ON' : 'OFF');
    };
    btnPlant.addEventListener('click', ()=>{
      Auto.plant = !Auto.plant; syncBtnPlant(); autoSave();
      notifyBus.show({ type: Auto.plant?'success':'warn', title:'Auto Plant', desc: Auto.plant?'ON':'OFF' });
    });
    syncBtnPlant();
    bar.appendChild(btnPlant);
  } else {
    btnPlant.classList.toggle('active', Auto.plant);
    btnPlant.textContent = 'Auto Plant: ' + (Auto.plant ? 'ON' : 'OFF');
  }

  // --- Remove Pot mode (chỉ gắn 1 lần) ---
  if (!bar.querySelector('.btnRemoveMode')) {
    const btnRemove = document.createElement('button');
    btnRemove.className = 'btnRemoveMode';
    btnRemove.textContent = 'Remove Pot: OFF';

    let removeMode = false;
    const sync = ()=> {
      btnRemove.classList.toggle('active', removeMode);
      btnRemove.textContent = 'Remove Pot: ' + (removeMode ? 'ON' : 'OFF');
      document.body.classList.toggle('remove-mode', removeMode);
    };
    btnRemove.addEventListener('click', ()=>{
      removeMode = !removeMode;
      sync();
      notifyBus.show({
        type: removeMode ? 'warn' : 'info',
        title: 'Remove Pot',
        desc: removeMode ? 'Click vào ô muốn xoá pot' : 'Đã tắt',
      });
    });
    sync();
    bar.appendChild(btnRemove);

    // Delegate click lên plots (gắn duy nhất 1 lần)
    const floorsRoot = document.getElementById('floors');
    if (floorsRoot && !floorsRoot.__removeModeBound){
      floorsRoot.__removeModeBound = true;
      floorsRoot.addEventListener('click', async (e)=>{
        if (!removeMode) return;
        const plot = e.target.closest('.plot');
        if (!plot) return;
        const floor = plot.closest('.floor');
        const floorId = parseInt(floor?.dataset.floorId, 10);
        const slot = parseInt(plot?.dataset.slot, 10);
        if (!floorId || !slot) return;

        const floorName = floor?.querySelector('h3')?.textContent || `#${floorId}`;
        if (!confirm(`Remove pot ở ${floorName} · Slot ${slot}?`)) return;
        try{
          await api('/plot/remove', { floorId, slot });
          notifyBus.show({ type:'warn', title:'Removed', meta:`Floor ${floorId} · Slot ${slot}` });
          await refresh({ soft:true });
        }catch(err){ showError(err,'remove'); }
      });
    }
  }

  // --- Auto Filters box ---
  let box = bar.querySelector('.auto-filters');
  if (!box){ box = document.createElement('div'); box.className = 'auto-filters'; bar.appendChild(box); }
  box.innerHTML = '';

  // Class group
  const classes = getAvailableClassesFromState();
  classes.forEach(cls=>{ if (!(cls in Auto.filters.classes)) Auto.filters.classes[cls] = true; });
  box.appendChild(buildCollapsedFilterGroup({
    titleText:'Class',
    allChecked: Auto.filters.useAllClasses,
    onToggleAll: (v)=>{ Auto.filters.useAllClasses = v; },
    isOpen: ()=> Auto.ui.clsOpen,
    onToggleOpen: (v)=>{ Auto.ui.clsOpen = v; },
    onClearAll: ()=>{
      Auto.filters.useAllClasses = false;
      classes.forEach(c=> Auto.filters.classes[c] = false);
    },
    chips: classes.map(cls=>({
      id:'cls-'+cls, label:cls, checked: !!Auto.filters.classes[cls],
      disabled: Auto.filters.useAllClasses,
      onChange: (v)=>{ Auto.filters.classes[cls] = v; }
    }))
  }));

  // Pot group
  ['timeskip','gold','basic'].forEach(pt=>{ if (!(pt in Auto.filters.pots)) Auto.filters.pots[pt] = true; });
  box.appendChild(buildCollapsedFilterGroup({
    titleText:'Pot',
    allChecked: Auto.filters.pots.timeskip && Auto.filters.pots.gold && Auto.filters.pots.basic,
    onToggleAll: (v)=>{ Auto.filters.pots.timeskip = Auto.filters.pots.gold = Auto.filters.pots.basic = v; },
    isOpen: ()=> Auto.ui.potOpen,
    onToggleOpen: (v)=>{ Auto.ui.potOpen = v; },
    onClearAll: ()=>{
      Auto.filters.pots.timeskip = false;
      Auto.filters.pots.gold = false;
      Auto.filters.pots.basic = false;
    },
    chips: ['timeskip','gold','basic'].map(pt=>({
      id:'pot-'+pt, label:pt, checked: !!Auto.filters.pots[pt],
      disabled:false, onChange: (v)=>{ Auto.filters.pots[pt] = v; }
    }))
  }));

  // Mutation group
  MUT_KEYS.forEach(k=>{ if (!(k in Auto.filters.muts)) Auto.filters.muts[k] = true; });
  box.appendChild(buildCollapsedFilterGroup({
    titleText:'Mutation',
    allChecked: Auto.filters.useAllMuts,
    onToggleAll: (v)=>{ Auto.filters.useAllMuts = v; },
    isOpen: ()=> Auto.ui.mutOpen,
    onToggleOpen: (v)=> { Auto.ui.mutOpen = v; },
    onClearAll: ()=>{
      Auto.filters.useAllMuts = false;
      MUT_KEYS.forEach(k=> Auto.filters.muts[k] = false);
    },
    chips: MUT_KEYS.map(k=>({
      id:'mut-'+k, label:k, checked: !!Auto.filters.muts[k],
      disabled: Auto.filters.useAllMuts,
      onChange: (v)=>{ Auto.filters.muts[k] = v; }
    }))
  }));
}


function findEmptyNoPotPlot() {
  if (!state) return null;
  for (const fp of state.plots) {
    for (const p of fp.plots) {
      if (!p.pot_id && (p.stage === 'empty' || !p.stage)) {
        return { floorId: fp.floor.id, slot: p.slot, floorIdx: fp.floor.idx };
      }
    }
  }
  return null;
}
function pickPotFromInv(){
  const inv = Array.isArray(state?.potInv) ? state.potInv.slice() : [];
  const order = { timeskip: 0, gold: 1, basic: 2 };
  const allowed = inv.filter(p => Auto.filters.pots[p.type]);
  allowed.sort((a,b)=> (order[a.type]??9) - (order[b.type]??9));
  return allowed[0] || null;
}
function findEmptyWithPotPlot(){
  if (!state) return null;
  for (const fp of state.plots) {
    for (const p of fp.plots) {
      if (p.pot_id && p.stage === 'empty') {
        return { floorId: fp.floor.id, slot: p.slot, floorIdx: fp.floor.idx };
      }
    }
  }
  return null;
}

/* ======= PATCHED: pickSeedForPlant() bỏ seed inflight & vừa trồng ======= */
function pickSeedForPlant(){
  const seeds = Array.isArray(state?.seedInv) ? state.seedInv : [];
  // Bỏ seed mature, seed đang inflight, seed vừa trồng (chờ state đồng bộ)
  const pool = seeds.filter(s =>
    s.is_mature === 0 &&
    !AUTO_INFLIGHT.has(s.id) &&
    !AUTO_RECENT_PLANTED.has(s.id)
  );

  // Filter theo class
  const classFilter = (s)=>{
    if (Auto.filters.useAllClasses) return true;
    return Auto.filters.classes[s.class] !== false;
  };
  // Filter theo mutation
  const mutFilter = (s)=>{
    if (Auto.filters.useAllMuts) return true;
    const key = s.mutation || s.mutation_name || null;
    if (!key) return false;
    return Auto.filters.muts[key] !== false;
  };

  const filtered = pool.filter(s => classFilter(s) && mutFilter(s));
  return filtered[0] || null;
}

/* ======= PATCHED: autoTickOnce() – optimistic update & guards ======= */
async function autoTickOnce(){
  if (Auto._busy || (!Auto.pot && !Auto.plant)) return;
  Auto._busy = true;
  try{
    if (Auto.pot){
      const target = findEmptyNoPotPlot();
      const pot = pickPotFromInv();
      if (target && pot){
        await api('/plot/place-pot', { floorId: target.floorId, slot: target.slot, potId: pot.id });
        notifInfo('Auto Pot', `#${pot.id} (${pot.type})`, `Floor ${target.floorIdx} · Slot ${target.slot}`);
        await refresh({ soft:true });
        return;
      } else {
        // NEW: Auto Pot tự tắt nếu không còn slot trống hoặc hết pot
        Auto.pot = false;
        syncAutoButtons();
        notifyBus.show({ type:'info', title:'Auto Pot', desc:'Đã tự tắt (hết slot trống hoặc không còn pot phù hợp)' });
      }
    }

    if (Auto.plant){
      const target = findEmptyWithPotPlot();
      const seed = pickSeedForPlant();
      if (target && seed){

        // 1) Đánh dấu đang xử lý để vòng sau không chọn lại
        AUTO_INFLIGHT.add(seed.id);
        try{
          const body = {
            floorId: target.floorId,
            slot: target.slot,
            seedId: seed.id,
            mutation: seed.mutation || seed.mutation_name || null
          };
          await api('/plot/plant', body);

          // 2) Optimistic update: xóa seed khỏi local inventory ngay
          if (Array.isArray(state?.seedInv)) {
            state.seedInv = state.seedInv.filter(x => x.id !== seed.id);
          }

          // 3) Cập nhật local plot để UI không chọn lại plot này ngay tick sau
          const fp = (state?.plots || []).find(fp => fp.floor.id === target.floorId);
          const plotLocal = fp?.plots?.find(p => p.slot === target.slot);
          if (plotLocal){
            plotLocal.stage = 'planted';
            plotLocal.seed_id = seed.id;
            plotLocal.class = seed.class;
            plotLocal.mutation_name = seed.mutation || seed.mutation_name || null;
            plotLocal.mutation_mult = seed.mutation_mult || null;
          }

          // 4) Đánh dấu “vừa plant” để pickSeedForPlant() không nhặt lại trước khi state đồng bộ
          AUTO_RECENT_PLANTED.add(seed.id);

          // 5) Thông báo + render mềm, sau đó đợi nhẹ & refresh mềm để đồng bộ state từ server/WS
          notifPlant({
            cls: seed.class,
            seedName: seed.class,
            floorName: `Floor ${target.floorIdx}`,
            potId: target.slot,
            mutation: seed.mutation || seed.mutation_name,
            seed
          });
          renderState(state, { soft: true });
          await sleep(150);
          await refresh({ soft: true });
          return;

        } catch(e){
          showError(e, 'auto-plant');
        } finally {
          // 6) Gỡ inflight; sau 2.5s gỡ "recent" (đủ thời gian server đẩy state mới)
          AUTO_INFLIGHT.delete(seed.id);
          setTimeout(()=> AUTO_RECENT_PLANTED.delete(seed.id), 2500);
        }
      }
    }

  } catch(e){
    showError(e, 'auto');
  } finally {
    Auto._busy = false;
  }
}

function startAutoLoop(){
  if (Auto._timerId) return;
  // 1200ms: nhịp default an toàn để state/WS kịp đồng bộ
  Auto._timerId = setInterval(autoTickOnce, 1200);
}
(function initAutoFeatures(){
  document.addEventListener('DOMContentLoaded', ()=>{
    ensureFarmAutoControls();
    startAutoLoop();
    removeLegacyFloorButtons();
  });
})();

/* ---------- Phím tắt ← / → để chuyển trang tầng ---------- */
document.addEventListener('keydown', (e)=>{
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag==='input' || tag==='select' || tag==='textarea' || e.altKey || e.ctrlKey || e.metaKey) return;
  const activeTab = Array.from($$('.tabs button')).find(b=>b.classList.contains('active'))?.dataset.tab;
  if (activeTab !== 'farm' && activeTab !== 'shop' && activeTab !== 'inventory') {
    // vẫn cho phép
  }
  if (e.key === 'ArrowLeft'){
    const total = getTotalFloorPagesFromState(state||{plots:[]});
    if (floorPage > 0){
      floorPage--; saveFloorPageToStorage(); renderState(state, {forceFloors:true});
    }
    e.preventDefault();
  }
  if (e.key === 'ArrowRight'){
    const total = getTotalFloorPagesFromState(state||{plots:[]});
    if (floorPage < total - 1){
      floorPage++; saveFloorPageToStorage(); renderState(state, {forceFloors:true});
    }
    e.preventDefault();
  }
});
/* =========================
   PATCH: One-image-only & in-place plot sync (avoid duplicates)
   - After soft updates (WS/poll), clean the .visual and re-add *one* pot and *one* plant.
   - Keeps sizes constrained by CSS so images always fit the card.
   ========================= */

function __gbg_buildVisualInto(visual, p){
  // Clean existing children to enforce ONE pot + ONE plant
  visual.innerHTML = '';

  // POT
  if (p.pot_type){
    const pot = document.createElement('img');
    pot.className = 'pot';
    pot.src = `/assets/Pots_Image/${p.pot_type==='gold'?'pot2.png':(p.pot_type==='timeskip'?'pot3.png':'pot1.png')}`;
    pot.loading = 'lazy';
    visual.appendChild(pot);
  }

  // PLANT
  if (p.class && p.stage){
    const folder = p.stage==='planted' ? 'Seed_Planted' : (p.stage==='growing' ? 'Seed_Growing' : 'Seed_Mature');
    const plant = document.createElement('img');
    plant.className = 'plant';
    plant.src = `/assets/${folder}/seed_${p.stage}_${p.class}.png`;
    plant.loading = 'lazy';
    visual.appendChild(plant);

    const mmeta = getMutationMeta(p);
    if (mmeta?.key) applyMutationFilterToPlant(plant, mmeta.key);
    addMutationBadge(visual, p);
  }
}

function __gbg_patchPlotsInPlace(newState){
  try{
    const plotMap = new Map();
    (newState?.plots||[]).forEach(fp=> (fp.plots||[]).forEach(p=> plotMap.set(p.id, p)));

    document.querySelectorAll('#floors .plot').forEach(el=>{
      const id = parseInt(el.dataset.plotId, 10);
      if (!id) return;
      const p = plotMap.get(id);
      if (!p) return;

      // Update datasets
      el.dataset.stage = p.stage || 'empty';
      el.dataset.class = p.class || '';
      if (p.mature_at) el.dataset.matureAt = p.mature_at; else delete el.dataset.matureAt;
      if (p.mutation_name || p.mutation) el.dataset.mutation = p.mutation_name || p.mutation; else delete el.dataset.mutation;
      el.dataset.locked = (p.locked ? '1' : '0');
      el.classList.toggle('is-locked', !!p.locked);
      el.classList.toggle('mature', p.stage === 'mature');

      // Update stat text (class, mut, lock)
      const clsVal = el.querySelector('.stat.cls .value');
      if (clsVal) clsVal.textContent = p.class || 'empty';

      const mutBox = el.querySelector('.stat.mut .value');
      if (mutBox){
        const mutText = (p.mutation_name || p.mutation) ? `${p.mutation_name || p.mutation}${Number.isFinite(p?.mutation_mult) ? ` ×${p.mutation_mult}`:''}` : '';
        mutBox.textContent = mutText;
      }
      const lockBox = el.querySelector('.stat.lock .value');
      if (lockBox){
        lockBox.textContent = p.locked ? 'ON' : 'OFF';
      }
      const lockBtn = el.querySelector('.btn-lock');
      if (lockBtn){
        lockBtn.textContent = p.locked ? '🔒' : '🔓';
        lockBtn.title = p.locked ? 'Unlock plot' : 'Lock plot';
      }

      // Rebuild the visual area to guarantee only one image each
      const visual = el.querySelector('.visual');
      if (visual) __gbg_buildVisualInto(visual, p);
    });
  }catch(err){
    console.warn('patchPlotsInPlace failed:', err);
  }
}

// Wrap the existing renderState to always patch visuals after soft updates
(function(){
  if (typeof renderState === 'function'){
    const __orig = renderState;
    renderState = function(s, opts={}){
      __orig(s, opts);
      // After any render, do an in-place sync to eliminate image duplicates
      __gbg_patchPlotsInPlace(s);
    };
  }
})();
// Polling nhẹ (soft) mỗi 10s, bỏ qua khi đang ở tab online
setInterval(()=>{
  if($('#tabs').classList.contains('hidden')) return;
  const active = Array.from($$('.tabs button')).find(b=>b.classList.contains('active'))?.dataset.tab;
  if (active === 'online') return;
  refresh({ soft: true }).catch(()=>{});
}, 10000);

/* ===================== GACHA (NEW TAB) ===================== */

const Gacha = {
  loaded: false,
  busy: false,
  lastState: null
};

// Label helper with backward-compat (class/count vs cls/cnt)
function gachaReqSeqLabel(req){
  if (!req) return '';
  const cls = req.class ?? req.cls ?? '?';
  const cnt = req.count ?? req.cnt ?? 0;
  return `${cnt} × ${cls}`;
}
function gachaMatureHaveFor(cls){
  const by = groupMatureByClass();
  return by[cls] || 0;
}
async function gachaFetchState(){
  try {
    const d = await get('/gacha/state');
    // Server có thể trả {ok:true, gacha:{...}} hoặc trả thẳng {...}
    return d?.gacha || d || null;
  } catch (e) {
    const statusEl = document.getElementById('gachaStatus');
    if (statusEl) statusEl.textContent = 'Gacha chưa khả dụng (server chưa cập nhật /gacha/state).';
    console.warn('[gacha] state failed', e);
    return null;
  }
}

function gachaRenderBars(gs){
  // pity 10
  const p10 = Math.min(10, Math.max(0, +gs.pity10 || 0));
  const p10Bar = document.getElementById('gachaPity10Bar');
  const p10Txt = document.getElementById('gachaPity10Text');
  if (p10Bar) p10Bar.style.width = `${(p10/10)*100}%`;
  if (p10Txt) p10Txt.textContent = `${p10}/10`;

  // pity 90
  const p90 = Math.min(90, Math.max(0, +gs.pity90 || 0));
  const p90Bar = document.getElementById('gachaPity90Bar');
  const p90Txt = document.getElementById('gachaPity90Text');
  if (p90Bar) p90Bar.style.width = `${(p90/90)*100}%`;
  if (p90Txt) p90Txt.textContent = `${p90}/90`;
}

function gachaRenderQueue(gs){
  const nowEl = document.getElementById('gachaNowReq');
  const listEl = document.getElementById('gachaQueue');
  if (nowEl){
    const nowReq = gs?.requirement || gs?.current || null;
    if (nowReq){
      const nowCls = nowReq.class ?? nowReq.cls ?? '?';
      const nowCnt = nowReq.count ?? nowReq.cnt ?? 0;
      const have = gachaMatureHaveFor(nowCls);
      nowEl.textContent = `Hiện tại cần: ${nowCnt} ${nowCls} (có sẵn: ${have})`;
    } else {
      nowEl.textContent = 'Chưa có yêu cầu hiện tại.';
    }
  }
  if (listEl){
    listEl.innerHTML='';
    const q = gs?.queue || gs?.next || [];
    q.slice(0, 10).forEach((req, i)=>{
      const li = document.createElement('li');
      li.textContent = `${i+1}) ${gachaReqSeqLabel(req)}`;
      listEl.appendChild(li);
    });
  }
  const cnts = document.getElementById('gachaHaveCounts');
  if (cnts){
    const by = groupMatureByClass();
    const keys = Object.keys(by).sort();
    cnts.textContent = keys.length ? keys.map(k=>`${k}:${by[k]}`).join(' · ') : '(chưa có hạt mature)';
  }
}

function gachaRenderHeader(gs){
  const totalEl = document.getElementById('gachaTotalPulls');
  const stepEl  = document.getElementById('gachaStep');
  const baseEl  = document.getElementById('gachaBaseHint');
  if (totalEl) totalEl.textContent = String(gs?.totalPulls ?? gs?.total ?? 0);
  if (stepEl)  stepEl.textContent  = String(gs?.step ?? 0);
  if (baseEl)  baseEl.textContent  = `Base Rainbow = pull_index × 100000`;
}

function gachaSoftRefresh(){
  // chỉ update phần "have" và enable nút theo state Gacha hiện có
  if (!Gacha.lastState) return;
  gachaRenderQueue(Gacha.lastState);
  gachaUpdateButtons(Gacha.lastState);
}

function gachaCanRoll(gs){
  const req = gs?.requirement || gs?.current;
  if (!req) return false;
  const cls = req.class ?? req.cls ?? '?';
  const cnt = req.count ?? req.cnt ?? 0;
  const have = gachaMatureHaveFor(cls);
  return have >= cnt;
}
function gachaUpdateButtons(gs){
  const b1 = document.getElementById('btnGachaRoll');
  const b10= document.getElementById('btnGachaRoll10');
  const can = gachaCanRoll(gs);
  if (b1) b1.disabled = !can || Gacha.busy;
  if (b10){
    // chỉ enable Roll10 nếu có thể đáp ứng được dãy 10 theo preview hiện tại
    const first = gs?.requirement || gs?.current;
    const rest = gs?.queue || gs?.next || [];
    const q = [first, ...rest].filter(Boolean).slice(0, 10);
    const have = groupMatureByClass();
    let ok10 = true;
    const need = {};
    q.forEach(req=>{
      const cls = req.class ?? req.cls ?? '?';
      const cnt = req.count ?? req.cnt ?? 0;
      need[cls] = (need[cls]||0) + cnt;
    });
    for (const k in need){
      if ((have[k]||0) < need[k]) { ok10 = false; break; }
    }
    b10.disabled = !ok10 || Gacha.busy;
  }
}

function notifGachaResult(r){
  // Hỗ trợ cả 2 format: 
  // 1) flat: { out_class, out_mutation, out_base, pull_index, consumed:{class,count} }
  // 2) nested: { reward:{class, mutation, base}, totals:{pulls}, consumed:{cls,cnt} }
  const reward = r?.reward || r;
  const cls = reward?.class || reward?.out_class || reward?.outClass || '?';
  const mut = reward?.mutation || reward?.out_mutation || reward?.outMutation || null;
  const base = (reward?.base ?? reward?.out_base ?? r?.out_base) ?? null;
  const pull = (r?.pull_index ?? r?.pullIndex ?? r?.totals?.pulls) ?? null;

  let consumed = r?.consumed || {};
  const consCls = consumed.class ?? consumed.cls;
  const consCnt = consumed.count ?? consumed.cnt;

  const mutTxt = formatMutationShort(mut);

  let type = 'success';
  if (mut === 'rainbow') type = 'gold';
  else if (mut === 'red' || mut === 'gold') type = 'warn';

  const metaParts = [];
  if (consCls) metaParts.push(`Tiêu hao: ${consCnt} × ${consCls}`);
  if (pull != null) metaParts.push(`Pull #${pull}`);

  notifyBus.show({
    type,
    title: 'Gacha',
    desc: `→ ${cls}${mutTxt? ` · Mut: ${mutTxt}`:''}${base!=null? ` · base ${base}`:''}`,
    meta: metaParts.join(' · '),
    key: `gacha:${cls}:${mut||'normal'}`
  });
}

async function gachaRefresh(){
  const gs = await gachaFetchState();
  if (!gs) return;
  Gacha.lastState = gs;
  gachaRenderHeader(gs);
  gachaRenderBars(gs);
  gachaRenderQueue(gs);
  gachaUpdateButtons(gs);
}

function gachaMaybeLoad(){
  if (Gacha.loaded) {
    gachaSoftRefresh();
    return;
  }
  Gacha.loaded = true;
  // bind buttons once
  const b1  = document.getElementById('btnGachaRoll');
  const b10 = document.getElementById('btnGachaRoll10');
  if (b1 && !b1.__bound){
    b1.__bound = true;
    b1.addEventListener('click', withCooldown(b1, async ()=>{
      if (Gacha.busy) return;
      Gacha.busy = true;
      try{
        const r = await api('/gacha/roll', {});
        notifGachaResult(r);
        await refresh({ soft:true });
        await gachaRefresh();
      }catch(e){ showError(e,'gacha-roll'); }
      finally { Gacha.busy = false; }
    }));
  }
  if (b10 && !b10.__bound){
    b10.__bound = true;
    b10.addEventListener('click', withCooldown(b10, async ()=>{
      if (Gacha.busy) return;
      Gacha.busy = true;
      try{
        let okCount = 0;
        for (let i=0;i<10;i++){
          try{
            const r = await api('/gacha/roll', {});
            okCount++;
            notifGachaResult(r);
            // Nếu ra rainbow, server sẽ reset step/queue => vẫn tiếp tục hoặc có thể dừng tuỳ thích
            if ((r?.out_mutation||r?.outMutation||r?.reward?.mutation) === 'rainbow') {
              // dừng sớm để người chơi xem thưởng
              break;
            }
          }catch(err){
            // thiếu nguyên liệu giữa chừng -> dừng
            break;
          }
        }
        await refresh({ soft:true });
        await gachaRefresh();
        if (okCount===0) notifyBus.show({ type:'error', title:'Gacha', desc:'Thiếu nguyên liệu để Roll.' });
      }catch(e){ showError(e,'gacha-roll10'); }
      finally { Gacha.busy = false; }
    }));
  }
  // initial load
  gachaRefresh();
}

/* =============== END GACHA =============== */

/* =================== EXTRA: LOCK TOGGLE DELEGATION =================== */
(function bindLockToggle(){
  const floorsRoot = document.getElementById('floors');
  if (!floorsRoot) return;
  if (floorsRoot.__lockBound) return;
  floorsRoot.__lockBound = true;
  floorsRoot.addEventListener('click', async (e)=>{
    const btn = e.target.closest('.btn-lock');
    if (!btn) return;
    const plotEl = btn.closest('.plot');
    if (!plotEl) return;
    const plotId = parseInt(plotEl.dataset.plotId, 10);
    const locked = plotEl.dataset.locked === '1';
    try{
      await api('/plot/lock', { plotId, locked: locked ? 0 : 1 });
      notifyBus.show({ type: locked ? 'info' : 'warn', title:'Plot Lock', desc: locked ? 'Unlocked' : 'Locked' });
      await refresh({ soft:true });
    }catch(err){
      showError(err, 'plot-lock');
    }
  });
})();