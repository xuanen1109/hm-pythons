const PROJECT_ID = 'hm-pythons-5ecff';
const FIREBASE_API_KEY = 'AIzaSyAnH6a_WrFdVlSEWvW-jLq2cTQElrQ4po0';
const COLLECTION = 'website_traffic_daily';

const ALLOWED_TYPES = new Set(['pageview', 'click']);
const ALLOWED_PAGES = new Map([
  ['首頁', 'home'],
  ['歷史紀錄', 'history']
]);
const ALLOWED_ACTIONS = new Map([
  ['待售個體', 'sale'],
  ['競標專區', 'auction'],
  ['歷史紀錄', 'history'],
  ['查看個體', 'detail'],
  ['聯絡', 'contact'],
  ['關於', 'about']
]);

function taipeiDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

function headers() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Content-Type-Options': 'nosniff'
  };
}

function response(statusCode, body) {
  return { statusCode, headers: headers(), body: JSON.stringify(body) };
}

function isLikelyBot(event) {
  const h = event.headers || {};
  const ua = String(h['user-agent'] || h['User-Agent'] || '').toLowerCase();
  return /bot|crawler|spider|headless|lighthouse|pagespeed|uptime|monitor/.test(ua);
}

function intValue(v) {
  if (!v || typeof v !== 'object') return 0;
  if (v.integerValue != null) return Number(v.integerValue) || 0;
  if (v.doubleValue != null) return Number(v.doubleValue) || 0;
  return 0;
}

function stringValue(v) {
  return v && typeof v === 'object' && v.stringValue != null ? String(v.stringValue) : '';
}

function stringArray(v) {
  return (v && v.arrayValue && Array.isArray(v.arrayValue.values))
    ? v.arrayValue.values.map(stringValue).filter(Boolean)
    : [];
}

function emptyDay(date) {
  return {
    date,
    views: 0,
    visitors: [],
    pages: { '首頁': 0, '歷史紀錄': 0 },
    clicks: { '待售個體': 0, '競標專區': 0, '歷史紀錄': 0, '查看個體': 0, '聯絡': 0, '關於': 0 }
  };
}

function decodeDay(doc) {
  const date = String(doc.name || '').split('/').pop();
  const f = doc.fields || {};
  return {
    date: stringValue(f.date) || date,
    views: intValue(f.views),
    visitors: stringArray(f.visitors),
    pages: {
      '首頁': intValue(f.page_home),
      '歷史紀錄': intValue(f.page_history)
    },
    clicks: {
      '待售個體': intValue(f.click_sale),
      '競標專區': intValue(f.click_auction),
      '歷史紀錄': intValue(f.click_history),
      '查看個體': intValue(f.click_detail),
      '聯絡': intValue(f.click_contact),
      '關於': intValue(f.click_about)
    }
  };
}

function docName(date) {
  return `projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${date}`;
}

async function recordEvent(body) {
  const type = String(body?.type || '');
  if (!ALLOWED_TYPES.has(type)) throw new Error('Unsupported event type');

  const page = ALLOWED_PAGES.has(body?.page) ? body.page : '首頁';
  const action = ALLOWED_ACTIONS.has(body?.action) ? body.action : '';
  if (type === 'click' && !action) throw new Error('Unsupported click action');

  const visitorId = String(body?.visitor_id || '')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 80);

  const date = taipeiDate();
  const transforms = [];

  if (type === 'pageview') {
    transforms.push({ fieldPath: 'views', increment: { integerValue: '1' } });
    transforms.push({ fieldPath: `page_${ALLOWED_PAGES.get(page)}`, increment: { integerValue: '1' } });
    if (visitorId) {
      transforms.push({
        fieldPath: 'visitors',
        appendMissingElements: { values: [{ stringValue: visitorId }] }
      });
    }
  } else {
    transforms.push({ fieldPath: `click_${ALLOWED_ACTIONS.get(action)}`, increment: { integerValue: '1' } });
  }

  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  const payload = {
    writes: [{
      update: {
        name: docName(date),
        fields: { date: { stringValue: date } }
      },
      updateMask: { fieldPaths: ['date'] },
      updateTransforms: transforms
    }]
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Firestore write failed (${r.status}): ${detail.slice(0, 500)}`);
  }
  return { ok: true, date };
}

async function fetchAllDays() {
  const docs = [];
  let pageToken = '';
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}`);
    url.searchParams.set('key', FIREBASE_API_KEY);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('orderBy', '__name__');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (r.status === 404) return [];
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`Firestore read failed (${r.status}): ${detail.slice(0, 500)}`);
    }
    const data = await r.json();
    docs.push(...(data.documents || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return docs.map(decodeDay).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date));
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

async function buildReport() {
  const allDays = await fetchAllDays();
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

  return {
    ok: true,
    storage: 'firestore',
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
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: headers(), body: '' };

  try {
    if (event.httpMethod === 'POST') {
      if (isLikelyBot(event)) return response(200, { ok: true, ignored: 'bot' });
      let body;
      try { body = JSON.parse(event.body || '{}'); }
      catch { return response(400, { error: 'Invalid JSON' }); }
      return response(200, await recordEvent(body));
    }

    if (event.httpMethod === 'GET') return response(200, await buildReport());
    return response(405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('[website-analytics]', error);
    return response(500, {
      error: 'Analytics temporarily unavailable',
      detail: String(error && error.message ? error.message : error)
    });
  }
};
