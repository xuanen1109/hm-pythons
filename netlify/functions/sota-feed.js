const PROJECT_ID = 'hm-pythons-5ecff';
const FIREBASE_API_KEY = 'AIzaSyAnH6a_WrFdVlSEWvW-jLq2cTQElrQ4po0';
const COLLECTION = 'snakes';
const ALLOWED_ORIGINS = new Set([
  'https://sotareptile.com',
  'https://www.sotareptile.com'
]);

function corsHeaders(origin) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://sotareptile.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(statusCode, body, origin, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=120',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(origin),
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

function fromFirestoreValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) out[key] = fromFirestoreValue(value);
  return out;
}

function normalizeSex(value) {
  const s = String(value || '').trim().toUpperCase();
  if (s === 'M' || s === 'MALE' || s === '公') return 'M';
  if (s === 'F' || s === 'FEMALE' || s === '母') return 'F';
  return 'U';
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeImages(data) {
  const candidates = [];
  if (typeof data.imgUrl === 'string') candidates.push(data.imgUrl);
  if (Array.isArray(data.images)) candidates.push(...data.images);
  if (Array.isArray(data.imageUrls)) candidates.push(...data.imageUrls);

  return [...new Set(candidates)]
    .filter(x => typeof x === 'string')
    .map(x => x.trim())
    .filter(Boolean)
    .filter(x => {
      try { return new URL(x).protocol === 'https:'; }
      catch (_) { return false; }
    });
}

function publicSnake(doc) {
  const data = decodeFields(doc.fields || {});
  const sourceId = String(doc.name || '').split('/').pop();
  const updatedAt = normalizeTimestamp(data.updatedAt) || normalizeTimestamp(data.createdAt);

  return {
    source_id: sourceId,
    morph: String(data.morph || data.nameEn || data.nameZh || '').trim(),
    name: String(data.nameZh || data.nameEn || data.morph || '').trim(),
    sex: normalizeSex(data.sex),
    description: String(data.sotaDescription || '').trim(),
    images: normalizeImages(data),
    available: data.status !== 'sold',
    updated_at: updatedAt
  };
}

async function fetchSnakeDocuments() {
  const docs = [];
  let pageToken = '';

  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}`);
    url.searchParams.set('key', FIREBASE_API_KEY);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Firestore read failed (${response.status}): ${detail.slice(0, 500)}`);
    }

    const payload = await response.json();
    docs.push(...(payload.documents || []));
    pageToken = payload.nextPageToken || '';
  } while (pageToken);

  return docs;
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method Not Allowed' }, origin, { 'Allow': 'GET, OPTIONS' });
  }

  try {
    const docs = await fetchSnakeDocuments();
    const items = docs
      .filter(doc => {
        const data = decodeFields(doc.fields || {});
        return data.itemType !== 'breeding_group' &&
          data.species === 'ball_python' &&
          data.showOnSota === true;
      })
      .map(publicSnake)
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

    return jsonResponse(200, items, origin);
  } catch (error) {
    console.error('[sota-feed]', error);
    return jsonResponse(502, { error: 'Feed temporarily unavailable' }, origin, {
      'Cache-Control': 'no-store'
    });
  }
};
