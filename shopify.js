const crypto = require('crypto');
const { phonesOf } = require('./util');
const cfg = require('./config');

const API = '2026-07';
const tokens = {};

// Dev Dashboard app: Client ID + Secret se 24 ghante wala token (khud refresh hota hai).
async function token(store) {
  if (store.adminToken) return store.adminToken;
  const t = tokens[store.key];
  if (t && t.exp > Date.now() + 3600000) return t.v;
  const r = await fetch(`https://${store.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: store.clientId, client_secret: store.clientSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Shopify login fail (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  tokens[store.key] = { v: j.access_token, exp: Date.now() + (j.expires_in || 86399) * 1000 };
  return j.access_token;
}

async function gql(store, query, variables, attempt = 0) {
  const r = await fetch(`https://${store.shop}/admin/api/${API}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await token(store) },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json().catch(() => ({}));
  const throttled = r.status === 429 || (j.errors && JSON.stringify(j.errors).includes('THROTTLED'));
  if (throttled && attempt < 4) {
    await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    return gql(store, query, variables, attempt + 1);
  }
  if (r.status === 401) delete tokens[store.key];
  if (!r.ok || j.errors) throw new Error(`Shopify ${r.status}: ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  return j.data;
}

const gid = (id) => `gid://shopify/Order/${id}`;

function isManual(source, tags) {
  const s = (source || '').toLowerCase();
  const t = (tags || []).map((x) => x.toLowerCase());
  return cfg.MANUAL_SOURCES.includes(s) || t.includes(cfg.KEEP_TAG);
}

// GraphQL order -> app ka format
function fromGql(n) {
  const tags = n.tags || [];
  const f = (n.displayFulfillmentStatus || '').toUpperCase();
  return {
    id: String(n.legacyResourceId),
    name: n.name,
    createdAt: n.createdAt,
    cancelled: !!n.cancelledAt,
    source: n.sourceName,
    tags,
    phones: phonesOf([n.phone, n.shippingAddress && n.shippingAddress.phone, n.billingAddress && n.billingAddress.phone]),
    ip: n.clientIp || null,
    shipped: f !== '' && f !== 'UNFULFILLED' && f !== 'SCHEDULED' && f !== 'ON_HOLD' && f !== 'REQUEST_DECLINED',
    manual: isManual(n.sourceName, tags),
  };
}

// Webhook (REST) order -> app ka format
function fromWebhook(o) {
  const tags = (o.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    id: String(o.id),
    name: o.name,
    createdAt: o.created_at,
    cancelled: !!o.cancelled_at,
    source: o.source_name,
    tags,
    phones: phonesOf([o.phone, o.shipping_address && o.shipping_address.phone, o.billing_address && o.billing_address.phone, o.customer && o.customer.phone]),
    ip: o.browser_ip || (o.client_details && o.client_details.browser_ip) || null,
    shipped: o.fulfillment_status === 'fulfilled' || o.fulfillment_status === 'partial',
    manual: isManual(o.source_name, tags),
  };
}

const ORDERS_Q = `query($q:String!,$after:String){ orders(first:100, after:$after, query:$q, sortKey:UPDATED_AT){
  pageInfo{hasNextPage endCursor}
  nodes{ legacyResourceId name createdAt cancelledAt sourceName tags phone clientIp displayFulfillmentStatus
    shippingAddress{phone} billingAddress{phone} } } }`;

async function fetchOrders(store, field, sinceIso) {
  const out = [];
  let after = null;
  for (let page = 0; page < 100; page++) {
    const d = await gql(store, ORDERS_Q, { q: `${field}:>='${sinceIso}'`, after });
    out.push(...d.orders.nodes.map(fromGql));
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

async function cancelOrder(store, id, note) {
  const d = await gql(store, `mutation($id:ID!,$note:String){ orderCancel(orderId:$id, reason:OTHER, restock:true, notifyCustomer:false,
    refundMethod:{originalPaymentMethodsRefund:true}, staffNote:$note){ job{id} orderCancelUserErrors{message code} } }`,
  { id: gid(id), note: note.slice(0, 250) });
  const errs = d.orderCancel.orderCancelUserErrors || [];
  if (errs.length) {
    const msg = errs.map((e) => e.message).join('; ');
    if (/already.*cancel/i.test(msg)) return; // pehle se cancel hai = theek
    throw new Error(msg);
  }
}

async function addTags(store, id, tags) {
  const d = await gql(store, `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{message} } }`,
    { id: gid(id), tags: tags.map((t) => t.slice(0, 40)) });
  const e = d.tagsAdd.userErrors;
  if (e && e.length) throw new Error(e.map((x) => x.message).join('; '));
}

// Cancel fail ho to fulfillment hold, taake order ship na ho sake.
async function holdOrder(store, id, note) {
  const d = await gql(store, `query($id:ID!){ order(id:$id){ fulfillmentOrders(first:10){ nodes{ id status } } } }`, { id: gid(id) });
  const fos = (d.order && d.order.fulfillmentOrders.nodes) || [];
  let held = 0;
  for (const fo of fos) {
    if (!['OPEN', 'SCHEDULED'].includes(fo.status)) continue;
    const r = await gql(store, `mutation($id:ID!,$h:FulfillmentOrderHoldInput!){ fulfillmentOrderHold(id:$id, fulfillmentHold:$h){ userErrors{message} } }`,
      { id: fo.id, h: { reason: 'OTHER', reasonNotes: note.slice(0, 250) } });
    if (!(r.fulfillmentOrderHold.userErrors || []).length) held++;
  }
  return held;
}

async function ensureWebhook(store, url) {
  const d = await gql(store, `{ webhookSubscriptions(first:50, topics:[ORDERS_CREATE]){ nodes{ id uri } } }`);
  if (d.webhookSubscriptions.nodes.some((n) => n.uri === url)) return 'pehle se laga hua';
  const r = await gql(store, `mutation($url:String!){ webhookSubscriptionCreate(topic:ORDERS_CREATE, webhookSubscription:{uri:$url, format:JSON}){
    userErrors{message} webhookSubscription{id} } }`, { url });
  const e = r.webhookSubscriptionCreate.userErrors;
  if (e && e.length) throw new Error(e.map((x) => x.message).join('; '));
  return 'naya laga diya';
}

function verifyHmac(store, rawBody, header) {
  if (!header) return false;
  const secrets = [store.webhookSecret, store.clientSecret].filter(Boolean);
  return secrets.some((sec) => {
    const digest = crypto.createHmac('sha256', sec).update(rawBody).digest('base64');
    const a = Buffer.from(digest), b = Buffer.from(header);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

const adminLink = (store, id) => `https://admin.shopify.com/store/${store.shop.split('.')[0]}/orders/${id}`;

module.exports = { fetchOrders, fromWebhook, cancelOrder, addTags, holdOrder, ensureWebhook, verifyHmac, adminLink, token };
