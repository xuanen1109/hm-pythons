const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'hm-website-traffic';
const ALLOWED_TYPES = new Set(['pageview', 'click']);
const ALLOWED_PAGES = new Set(['首頁', '歷史紀錄']);
const ALLOWED_ACTIONS = new Set(['待售個體', '競標專區', '歷史紀錄', '查看個體', '聯絡', '關於']);

function taipeiDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function emptyDay(date) {
  return { date, views: 0, visitors: [], pages: {}, clicks: {} };
}

function isLikelyBot(req) {
  const ua = (req.headers.get('user-agent') || '').toLowerCase();
  return /bot|crawler|spider|headless|lighthouse|pagespeed|uptime|monitor/.test(ua);
}

async function updateDay(store, date, payload) {
  const key = `day/${date}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const data = entry?.data && typeof entry.data === 'object' ? entry.data : emptyDay(date);
    data.date = date;
    data.views = Number(data.views || 0);
    data.visitors = Array.isArray(data.visitors) ? data.visitors : [];
    data.pages = data.pages && typeof data.pages === 'object' ? data.pages : {};
    data.clicks = data.clicks && typeof data.clicks === 'object' ? data.clicks : {};

    if (payload.type === 'pageview') {
      data.views += 1;
      data.pages[payload.page] = Number(data.pages[payload.page] || 0) + 1;
      if (payload.visitor_id && !data.visitors.includes(payload.visitor_id)) {
        data.visitors.push(payload.visitor_id);
      }
    } else if (payload.type === 'click' && payload.action) {
      data.clicks[payload.action] = Number(data.clicks[payload.action] || 0) + 1;
    }

    const result = entry
      ? await store.setJSON(key, data, { onlyIfMatch: entry.etag })
      : await store.setJSON(key, data, { onlyIfNew: true });
    if (result.modified) return data;
  }
  throw new Error('Traffic counter was busy, please retry');
}

function aggregate(days) {
  const visitorSet = new Set();
  let views = 0;
  let clicks = 0;
  for (const d of days) {
    views += Number(d.views || 0);
    for (const v of (Array.isArray(d.visitors) ? d.visitors : [])) visitorSet.add(v);
    clicks += Object.values(d.clicks || {}).reduce((a, b) => a + Number(b || 0), 0);
  }
  return { views, visitors: visitorSet.size, clicks };
}

async function handleRequest(req) {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: corsHeaders() });

  try {
    const store = getStore({ name: STORE_NAME, consistency: 'strong' });

    if (req.method === 'POST') {
      if (isLikelyBot(req)) return json({ ok: true, ignored: 'bot' });
      let body;
      try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

      const type = String(body?.type || '');
      const page = ALLOWED_PAGES.has(body?.page) ? body.page : '首頁';
      const action = ALLOWED_ACTIONS.has(body?.action) ? body.action : '';
      const visitorId = String(body?.visitor_id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

      if (!ALLOWED_TYPES.has(type)) return json({ error: 'Unsupported event type' }, 400);
      if (type === 'click' && !action) return json({ error: 'Unsupported click action' }, 400);

      await updateDay(store, taipeiDate(), { type, page, action, visitor_id: visitorId });
      return json({ ok: true });
    }

    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    const { blobs } = await store.list({ prefix: 'day/' });
    const allDays = [];
    for (const blob of blobs) {
      const data = await store.get(blob.key, { type: 'json' });
      if (data && /^\d{4}-\d{2}-\d{2}$/.test(String(data.date || ''))) allDays.push(data);
    }
    allDays.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const byDate = new Map(allDays.map(d => [d.date, d]));
    const last30Dates = Array.from({ length: 30 }, (_, i) => taipeiDate(i - 29));
    const last30Days = last30Dates.map(date => byDate.get(date) || emptyDay(date));
    const last7Days = last30Days.slice(-7);
    const todayDay = last30Days[last30Days.length - 1];

    const pages = {};
    const clicks = {};
    for (const d of allDays) {
      for (const [k, v] of Object.entries(d.pages || {})) pages[k] = Number(pages[k] || 0) + Number(v || 0);
      for (const [k, v] of Object.entries(d.clicks || {})) clicks[k] = Number(clicks[k] || 0) + Number(v || 0);
    }

    return json({
      generated_at: new Date().toISOString(),
      timezone: 'Asia/Taipei',
      today: aggregate([todayDay]),
      last7: aggregate(last7Days),
      last30: aggregate(last30Days),
      total: aggregate(allDays),
      daily: last30Days.map(d => ({
        date: d.date,
        views: Number(d.views || 0),
        visitors: new Set(Array.isArray(d.visitors) ? d.visitors : []).size
      })),
      pages,
      clicks
    });
  } catch (error) {
    console.error('[website-analytics]', error);
    return json({ error: error?.message || 'Analytics temporarily unavailable' }, 500);
  }
}



exports.handler = async (event) => {
  const headers = new Headers(event.headers || {});
  const url = new URL(event.rawUrl || event.url || `https://local${event.path || '/'}`);
  const init = { method: event.httpMethod || 'GET', headers };
  if (event.body && !['GET','HEAD'].includes(init.method)) {
    init.body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body;
  }
  const req = new Request(url, init);
  const res = await handleRequest(req);
  const outHeaders = {};
  res.headers.forEach((v,k) => { outHeaders[k] = v; });
  return {
    statusCode: res.status,
    headers: outHeaders,
    body: await res.text()
  };
};
