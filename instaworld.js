// Instaworld Merchant API v2 — sirf parhne (read) ke liye. Booking/cancel app nahi karti.
const BASE = 'https://one-be.instaworld.pk/merchant-api/v2';

async function api(key, path, query = {}, attempt = 0) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.append(k, String(v));
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } });
  if (r.status === 429 && attempt < 3) {
    const wait = Number(r.headers.get('retry-after')) || 20;
    await new Promise((res) => setTimeout(res, wait * 1000));
    return api(key, path, query, attempt + 1);
  }
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const e = (body && body.error) || {};
    throw new Error(`Instaworld ${r.status} ${e.code || ''}: ${e.message || text.slice(0, 200)}`);
  }
  return body;
}

async function listShipments(key, params) {
  const rows = [];
  let cursor;
  for (let page = 0; page < 40; page++) {
    const r = await api(key, '/shipments', { ...params, limit: 200, cursor });
    rows.push(...(r.data || []));
    cursor = r.meta && r.meta.next_cursor;
    if (!cursor) break;
  }
  return rows;
}

module.exports = { listShipments, api };
