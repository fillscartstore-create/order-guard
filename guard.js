const db = require('./db');
const cfg = require('./config');
const shopify = require('./shopify');
const iw = require('./instaworld');
const { normPhone, normRef, DAY, days } = require('./util');

const status = {}; // dashboard ke liye har store ka haal
const setStatus = (key, part, val) => { status[key] = status[key] || {}; status[key][part] = { ...val, at: new Date().toISOString() }; };

// ---- Har store ka kaam ek waqt mein ek hi chalta hai (do orders ek saath aayen to bhi dono pass na hon)
const queues = {};
function locked(key, fn) {
  const prev = queues[key] || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues[key] = next.catch(() => {});
  return next;
}

// ---- Event log: order number ke baghair kuch bhi log nahi hota
async function logEvent(e) {
  let ref = e.orderRef && String(e.orderRef).trim();
  if (!ref) ref = e.tracking ? `ORDER# NAHI MILA (tracking ${e.tracking})` : 'ORDER# NAHI MILA';
  const r = await db.q(
    `insert into events(store,order_ref,order_id,tracking,phone,type,severity,reason,dedupe)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (dedupe) do nothing returning id`,
    [e.store, ref, e.orderId || null, e.tracking || null, e.phone || null, e.type, e.severity || 'info', e.reason, e.dedupe || null]);
  if (r.rowCount) console.log(`[${e.store}] ${e.type} ${ref}${e.tracking ? ' / ' + e.tracking : ''}: ${e.reason}`);
  return r.rowCount > 0;
}

async function activeFrom() {
  if (cfg.GUARD_ACTIVE_FROM) return new Date(cfg.GUARD_ACTIVE_FROM).getTime();
  let v = await db.kvGet('guard_active_from');
  if (!v) { v = new Date().toISOString(); await db.kvSet('guard_active_from', v); }
  return new Date(v).getTime();
}

async function upsertOrder(store, o) {
  await db.q(
    `insert into orders(store,id,name,name_norm,created_at,cancelled,source,tags,phones,ip,shipped,manual,updated_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     on conflict (store,id) do update set name=excluded.name, name_norm=excluded.name_norm, cancelled=excluded.cancelled,
       source=excluded.source, tags=excluded.tags,
       phones=case when cardinality(excluded.phones)>0 then excluded.phones else orders.phones end,
       ip=coalesce(excluded.ip, orders.ip), shipped=excluded.shipped, manual=excluded.manual, updated_at=now()`,
    [store.key, o.id, o.name, normRef(o.name), o.createdAt, o.cancelled, o.source, o.tags, o.phones, o.ip, o.shipped, o.manual]);
}

// ================= SHOPIFY SYNC =================
async function syncShopify(store) {
  const k = `shopify_sync_${store.key}`;
  const last = await db.kvGet(k);
  const started = new Date();
  let list;
  if (!last) list = await shopify.fetchOrders(store, 'created_at', new Date(Date.now() - cfg.LOOKBACK_DAYS * DAY).toISOString());
  else list = await shopify.fetchOrders(store, 'updated_at', new Date(new Date(last).getTime() - 15 * 60000).toISOString());
  for (const o of list) await upsertOrder(store, o);
  await db.kvSet(k, started.toISOString());
  return list.length;
}

// ================= DUPLICATE RULES =================
async function evaluateStore(store) {
  const W = cfg.DUP_WINDOW_DAYS * DAY, IPW = cfg.IP_WINDOW_DAYS * DAY;
  const from = await activeFrom();
  const { rows } = await db.q(
    `select * from orders where store=$1 and not cancelled
       and (guard_cancel_at is null or guard_cancel_at < now() - interval '10 minutes')
       and created_at >= now() - make_interval(days => $2)
     order by created_at asc, id asc`, [store.key, cfg.DUP_WINDOW_DAYS * 2 + 1]);

  const kept = [];
  const actions = [];
  for (const o of rows) {
    const t = new Date(o.created_at).getTime();
    let match = null, rule = null;
    for (const k of kept) {
      const dt = t - new Date(k.created_at).getTime();
      if (dt <= W && o.phones.some((p) => k.phones.includes(p))) { match = k; rule = 'phone'; break; }
    }
    if (!match && o.ip) {
      for (const k of kept) {
        const dt = t - new Date(k.created_at).getTime();
        if (dt <= IPW && k.ip === o.ip) { match = k; rule = 'ip'; break; }
      }
    }
    if (!match || o.manual) { kept.push(o); continue; } // aap ke apne draft/manual orders kabhi cancel nahi

    // Kaun rahe: manual > ship ho chuka > purana
    let victim = o, keeper = match;
    if (o.shipped && !match.shipped && !match.manual) {
      victim = match; keeper = o;
      kept.splice(kept.indexOf(match), 1, o);
    }
    if (new Date(victim.created_at).getTime() < from) continue; // app lagne se pehle ke purane orders ko nahi chhedta
    actions.push({ victim, keeper, rule });
  }

  for (const a of actions) await cancelDuplicate(store, a);
  await crossStoreNotes(store, kept.filter((o) => new Date(o.created_at).getTime() >= from));
  return actions.length;
}

async function cancelDuplicate(store, { victim, keeper, rule }) {
  const gap = days(new Date(victim.created_at) - new Date(keeper.created_at));
  const shared = rule === 'phone' ? victim.phones.find((p) => keeper.phones.includes(p)) : victim.ip;
  const why = rule === 'phone'
    ? `Same phone ${shared}: order ${keeper.name} pehle se hai (${Math.abs(gap)} din ka farq)`
    : `Same IP ${shared}: order ${keeper.name} pehle se hai (${Math.abs(gap)} din ka farq)`;
  const base = { store: store.key, orderRef: victim.name, orderId: victim.id, phone: victim.phones[0] };

  if (cfg.DRY_RUN) {
    await logEvent({ ...base, type: 'WOULD_CANCEL', severity: 'warn', reason: `TEST MODE (cancel nahi kiya): ${why}`, dedupe: `wc:${store.key}:${victim.id}` });
    return;
  }

  await db.q('update orders set guard_cancel_at=now(), cancel_attempts=cancel_attempts+1 where store=$1 and id=$2', [store.key, victim.id]);
  const attempts = victim.cancel_attempts + 1;
  try {
    await shopify.cancelOrder(store, victim.id, `Order Guard: duplicate. ${why}`);
    if (attempts >= 3) throw new Error(`Cancel ${attempts} baar bheja gaya lekin Shopify mein order abhi bhi open hai`);
    await logEvent({ ...base, type: 'CANCELLED', reason: why, dedupe: `c:${store.key}:${victim.id}` });
    await db.q(`update events set resolved=true where store=$1 and order_id=$2 and type='ACTION_NEEDED'`, [store.key, victim.id]);
    try {
      await shopify.addTags(store, victim.id, ['AUTO-CANCELLED', rule === 'phone' ? 'DUP-PHONE' : 'DUP-IP', `DUP-OF-${normRef(keeper.name)}`]);
    } catch (e) { console.log('tag error', victim.name, e.message); }
  } catch (err) {
    let holdMsg = '';
    try {
      const held = await shopify.holdOrder(store, victim.id, `Order Guard: duplicate, ship na karein. ${why}`);
      holdMsg = held ? ' Order HOLD par laga diya.' : '';
    } catch (e) { holdMsg = ` Hold bhi fail: ${e.message.slice(0, 80)}.`; }
    try { await shopify.addTags(store, victim.id, ['DO-NOT-SHIP', 'DUPLICATE']); holdMsg += ' DO-NOT-SHIP tag laga diya.'; } catch (e) { // ignore
    }
    await db.q('update orders set guard_cancel_at=null where store=$1 and id=$2', [store.key, victim.id]);
    await logEvent({ ...base, type: 'ACTION_NEEDED', severity: 'critical',
      reason: `Auto-cancel FAIL (${err.message.slice(0, 150)}).${holdMsg} Shopify mein khud cancel karein. Wajah: ${why}`,
      dedupe: `cf:${store.key}:${victim.id}` });
  }
}

async function crossStoreNotes(store, kept) {
  const W = cfg.DUP_WINDOW_DAYS;
  for (const o of kept) {
    if (!o.phones.length) continue;
    const { rows } = await db.q(
      `select store, id, name from orders where store<>$1 and not cancelled and phones && $2
         and created_at between $3::timestamptz - make_interval(days => $4) and $3::timestamptz + make_interval(days => $4)`,
      [store.key, o.phones, o.created_at, W]);
    for (const other of rows) {
      const os = cfg.storeByKey(other.store);
      const label = os ? os.label : other.store;
      const isNew = await logEvent({ store: store.key, orderRef: o.name, orderId: o.id, phone: o.phones[0], type: 'NOTE',
        reason: `Same customer ${label} par bhi hai: order ${other.name} (cancel nahi kiya, sirf note)`,
        dedupe: `n:${store.key}:${o.id}:${other.store}:${other.id}` });
      if (isNew && !cfg.DRY_RUN) {
        try { await shopify.addTags(store, o.id, [`ALSO-${other.store.toUpperCase()}-${normRef(other.name)}`]); } catch (e) { // ignore
    }
      }
    }
  }
}

// ================= INSTAWORLD =================
async function syncInstaworld(store) {
  if (!store.iwKey) return null;
  const k = `iw_sync_${store.key}`;
  const last = await db.kvGet(k);
  const started = new Date();
  const params = last
    ? { updated_since: new Date(new Date(last).getTime() - 15 * 60000).toISOString() }
    : { created_from: new Date(Date.now() - cfg.IW_LOOKBACK_DAYS * DAY).toISOString().slice(0, 10) };
  const rows = await iw.listShipments(store.iwKey, params);
  for (const s of rows) {
    if (!s.tracking_number) continue;
    const st = s.status || {};
    await db.q(
      `insert into shipments(store,tracking,ref_no,ref_norm,phone,status_code,status_group,status_label,created_at,updated_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (store,tracking) do update set ref_no=excluded.ref_no, ref_norm=excluded.ref_norm, phone=excluded.phone,
         status_code=excluded.status_code, status_group=excluded.status_group, status_label=excluded.status_label,
         created_at=coalesce(shipments.created_at, excluded.created_at), updated_at=excluded.updated_at`,
      [store.key, s.tracking_number, s.ref_no || null, normRef(s.ref_no), normPhone(s.consignee && s.consignee.phone),
        st.code || null, st.group || null, st.label || st.code || null,
        s.created_at || s.booked_at || s.updated_at || new Date().toISOString(), s.updated_at || new Date().toISOString()]);
  }
  await db.kvSet(k, started.toISOString());
  return rows.length;
}

// Shipment ka Shopify order number dhoondo (ref na ho to phone se)
async function refFor(store, s) {
  if (s.ref_norm) {
    const r = await db.q('select id, name from orders where store=$1 and name_norm=$2 limit 1', [store.key, s.ref_norm]);
    if (r.rows[0]) return { ref: r.rows[0].name, id: r.rows[0].id };
    return { ref: s.ref_no.startsWith('#') ? s.ref_no : '#' + s.ref_no, id: null };
  }
  if (s.phone) {
    const r = await db.q(`select id, name from orders where store=$1 and $2 = any(phones)
      order by abs(extract(epoch from (created_at - $3::timestamptz))) asc limit 1`, [store.key, s.phone, s.created_at]);
    if (r.rows[0]) return { ref: `${r.rows[0].name} (phone se mila)`, id: r.rows[0].id };
  }
  return { ref: `ORDER# NAHI MILA (tracking ${s.tracking})`, id: null };
}

const NOT_ACTIVE = ['CANCELLED'];

async function checkShipments(store) {
  if (!store.iwKey) return 0;
  const from = await activeFrom();
  const W = cfg.DUP_WINDOW_DAYS * DAY;
  let found = 0;
  const { rows: ships } = await db.q(
    `select * from shipments where store=$1 and created_at >= now() - make_interval(days => $2) order by created_at asc, tracking asc`,
    [store.key, cfg.DUP_WINDOW_DAYS * 2 + 1]);
  const live = ships.filter((s) => !NOT_ACTIVE.includes(s.status_code));

  // 1) Ek hi order 2 baar book
  const byRef = {};
  for (const s of live) if (s.ref_norm) (byRef[s.ref_norm] = byRef[s.ref_norm] || []).push(s);
  for (const list of Object.values(byRef)) {
    if (list.length < 2) continue;
    const first = list[0];
    for (const s of list.slice(1)) {
      if (new Date(s.created_at).getTime() < from) continue;
      const r = await refFor(store, s);
      if (await logEvent({ store: store.key, orderRef: r.ref, orderId: r.id, tracking: s.tracking, phone: s.phone, type: 'DUP_SHIPMENT', severity: 'critical',
        reason: `Ek hi order 2 baar book hua: ${first.tracking} (${first.status_label || '-'}) aur ${s.tracking} (${s.status_label || '-'}). Ek ko Instaworld se cancel karein.`,
        dedupe: `ds:${store.key}:${s.tracking}` })) found++;
    }
  }

  // 2) Cancelled order ka parcel book/raste mein
  const { rows: bad } = await db.q(
    `select s.*, o.name as oname, o.id as oid from shipments s join orders o on o.store=s.store and o.name_norm=s.ref_norm
     where s.store=$1 and (o.cancelled or o.guard_cancel_at is not null)
       and coalesce(s.status_code,'') not in ('CANCELLED','DELIVERED','RTO_RETURNED_TO_SHIPPER')
       and coalesce(s.status_group,'') not in ('final')`, [store.key]);
  for (const s of bad) {
    if (new Date(s.created_at).getTime() < from) continue;
    if (await logEvent({ store: store.key, orderRef: s.oname, orderId: s.oid, tracking: s.tracking, phone: s.phone, type: 'SHIPPED_CANCELLED', severity: 'critical',
      reason: `Order cancel hai lekin parcel booked hai (${s.status_label || s.status_code || '-'}). Instaworld se cancel karein / parcel courier ko na dein.`,
      dedupe: `sc:${store.key}:${s.tracking}` })) found++;
  }

  // 3) Same phone ke 2 alag parcels 30 din mein
  const byPhone = {};
  for (const s of live) if (s.phone) (byPhone[s.phone] = byPhone[s.phone] || []).push(s);
  for (const list of Object.values(byPhone)) {
    for (let i = 1; i < list.length; i++) {
      const s = list[i];
      if (new Date(s.created_at).getTime() < from) continue;
      const prev = list.slice(0, i).find((p) => p.ref_norm !== s.ref_norm && new Date(s.created_at) - new Date(p.created_at) <= W);
      if (!prev) continue;
      const r = await refFor(store, s);
      if (r.id) {
        const m = await db.q('select manual from orders where store=$1 and id=$2', [store.key, r.id]);
        if (m.rows[0] && m.rows[0].manual) continue; // aap ka apna manual order
      }
      const pr = await refFor(store, prev);
      if (await logEvent({ store: store.key, orderRef: r.ref, orderId: r.id, tracking: s.tracking, phone: s.phone, type: 'DUP_SHIPMENT_PHONE', severity: 'critical',
        reason: `Same customer (${s.phone}) ke 2 parcels: ${pr.ref} / ${prev.tracking} (${prev.status_label || '-'}) aur ye wala. Check karke ek cancel karein.`,
        dedupe: `dp:${store.key}:${s.tracking}` })) found++;
    }
  }

  // Jo parcel baad mein cancel ho gaye, unke alerts khud resolve
  await db.q(`update events e set resolved=true from shipments s
    where e.store=s.store and e.tracking=s.tracking and s.status_code='CANCELLED' and not e.resolved`);
  return found;
}

// ================= RUNNERS =================
async function runStore(store, { sync = true } = {}) {
  return locked(store.key, async () => {
    if (sync) {
      try { const n = await syncShopify(store); setStatus(store.key, 'shopify', { ok: true, msg: `${n} orders update hue` }); }
      catch (e) { setStatus(store.key, 'shopify', { ok: false, msg: e.message }); }
      if (store.iwKey) {
        try { const n = await syncInstaworld(store); setStatus(store.key, 'instaworld', { ok: true, msg: `${n} shipments update huin` }); }
        catch (e) { setStatus(store.key, 'instaworld', { ok: false, msg: e.message }); }
      } else setStatus(store.key, 'instaworld', { ok: false, msg: 'Instaworld key nahi lagi' });
    }
    try { const n = await evaluateStore(store); setStatus(store.key, 'guard', { ok: true, msg: `${n} duplicate action` }); }
    catch (e) { setStatus(store.key, 'guard', { ok: false, msg: e.message }); }
    try { await checkShipments(store); } catch (e) { setStatus(store.key, 'guard', { ok: false, msg: 'Shipment check: ' + e.message }); }
  });
}

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try { for (const s of cfg.stores) await runStore(s); }
  finally { sweeping = false; await db.kvSet('last_sweep', new Date().toISOString()).catch(() => {}); }
}

async function handleWebhookOrder(store, payload) {
  const o = shopify.fromWebhook(payload);
  await locked(store.key, () => upsertOrder(store, o));
  await runStore(store, { sync: false });
}

module.exports = { sweep, runStore, handleWebhookOrder, status, activeFrom, logEvent };
