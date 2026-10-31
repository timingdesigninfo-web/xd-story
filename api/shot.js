// XD戦記：スクショのシェアカード（Vercel Functions + Upstash Redis）
//
// POST /api/shot {img:"data:image/jpeg;base64,..."}  カード画像（1200x630 JPEG）を保存して {id} を返す
// GET  /s/:id        → Xなどがカード表示に使うページ（OGP付き）。人が開くとゲームのトップへ移動
// GET  /shot/:id.jpg → カード画像
//
// ログインなし・個人情報なし。画像は約180日で自動削除。環境変数は api/xd.js と同じ。

const crypto = require('crypto');

function envEnding(suffix) {
  const k = Object.keys(process.env).find(k => k.endsWith(suffix) && process.env[k]);
  return k ? process.env[k] : undefined;
}
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envEnding('KV_REST_API_URL') || envEnding('REDIS_REST_URL');
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envEnding('KV_REST_API_TOKEN') || envEnding('REDIS_REST_TOKEN');

const ID_RE = /^[a-z0-9]{10}$/;
const MAX_IMG = 450 * 1024; // base64 を戻したあとのバイト数
const TTL = 180 * 86400;
const TITLE = 'XD戦記';
const DESC = 'あなたはXDをおぼえているか？ XDと雲の仲間たちが、妖精とその生き方を模索しながらクリエイターのチカラを探す旅をする超私的RPG。';

async function db(cmds) {
  const r = await fetch(DB_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('db ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let s = '';
  for await (const c of req) { s += c; if (s.length > MAX_IMG * 1.5) break; }
  try { return JSON.parse(s); } catch { return {}; }
}

function site(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'xd-story.vercel.app').split(',')[0].trim();
  return 'https://' + host;
}

async function rateLimited(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const key = 'xd:shotrl:' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) + ':' + Math.floor(Date.now() / 60000);
  const [n] = await db([['INCR', key], ['EXPIRE', key, 120]]);
  return n > 10;
}

async function upload(req, res) {
  if (await rateLimited(req)) return send(res, 429, { error: 'しばらく 待ってから もう一度 ためしてください' });
  const body = await readBody(req);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.img || ''));
  if (!m) return send(res, 400, { error: 'bad image' });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_IMG || buf.length < 1000 || buf[0] !== 0xff || buf[1] !== 0xd8) return send(res, 400, { error: 'bad image' });
  const id = crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().padEnd(10, '0').slice(0, 10);
  await db([['SET', 'xd:shot:' + id, m[1], 'EX', TTL]]);
  return send(res, 200, { id, url: site(req) + '/s/' + id });
}

async function image(res, id) {
  const [b64] = ID_RE.test(id) ? await db([['GET', 'xd:shot:' + id]]) : [null];
  if (!b64) { res.statusCode = 404; return res.end('not found'); }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  return res.end(Buffer.from(b64, 'base64'));
}

async function page(req, res, id) {
  const ok = ID_RE.test(id);
  const S = site(req), img = ok ? `${S}/shot/${id}.jpg` : `${S}/icon-512.png`;
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${TITLE}">
<meta property="og:url" content="${S}/s/${ok ? id : ''}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0;url=/">
</head><body><script>location.replace('/')</script><a href="/">XD戦記で 遊ぶ</a></body></html>`);
}

module.exports = async (req, res) => {
  try {
    if (!DB_URL || !DB_TOKEN) return send(res, 503, { error: 'サーバーは まだ 準備中です' });
    const u = new URL(req.url, 'http://x'), q = u.searchParams, rq = req.query || {};
    const imgId = rq.img || q.get('img') || (u.pathname.match(/\/shot\/([a-z0-9]+)\.jpg$/) || [])[1];
    const pageId = rq.p || q.get('p') || (u.pathname.match(/\/s\/([a-z0-9]+)\/?$/) || [])[1];
    if (req.method === 'GET' && imgId) return image(res, imgId);
    if (req.method === 'GET' && pageId) return page(req, res, pageId);
    if (req.method === 'POST') return upload(req, res);
    return send(res, 405, { error: 'method' });
  } catch (e) {
    return send(res, 500, { error: 'サーバーで エラーが おきました' });
  }
};
