// XD戦記：みんなのアイデア箱（Vercel Functions + Upstash Redis）
//
// POST /api/idea {action:"post", cat, text}     アイデアを送る（誰でも。ログインなし・個人情報なし）
// POST /api/idea {action:"list", key}           一覧（管理者だけ）
// POST /api/idea {action:"delete", key, raw}    1件削除（管理者だけ）
//
// 管理者の鍵は、Vercel の環境変数 XD_ADMIN_KEY に自分で決めて入れる（未設定なら一覧は開けない）。
// 保存先は api/xd.js と同じ Upstash Redis。

const crypto = require('crypto');

function envEnding(suffix) {
  const k = Object.keys(process.env).find(k => k.endsWith(suffix) && process.env[k]);
  return k ? process.env[k] : undefined;
}
const DB_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || envEnding('KV_REST_API_URL') || envEnding('REDIS_REST_URL');
const DB_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || envEnding('KV_REST_API_TOKEN') || envEnding('REDIS_REST_TOKEN');

const LIST = 'xd:ideas';
const MAX_KEEP = 2000;
const MAX_TEXT = 400;
const CATS = ['敵', '道具・装備', 'ストーリー', 'あそびやすさ', '不具合', 'その他'];

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
  for await (const c of req) { s += c; if (s.length > 20000) break; }
  try { return JSON.parse(s); } catch { return {}; }
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
function isAdmin(key) {
  const real = process.env.XD_ADMIN_KEY;
  if (!real || !key) return false;
  return crypto.timingSafeEqual(sha(real), sha(key));
}
const ipOf = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

module.exports = async (req, res) => {
  try {
    if (!DB_URL || !DB_TOKEN) return send(res, 503, { error: 'アイデア箱は まだ 準備中です' });
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const body = await readBody(req);

    if (body.action === 'post') {
      let text = String(body.text || '').replace(/\r/g, '').trim();
      if (text.length < 3) return send(res, 400, { error: 'もう少し くわしく 書いてください（3文字以上）' });
      if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
      const cat = CATS.includes(body.cat) ? body.cat : 'その他';
      const ih = crypto.createHash('sha256').update(ipOf(req)).digest('hex').slice(0, 16);
      // 同じ端末から、10分に5件まで
      const rl = 'xd:idea:rl:' + ih + ':' + Math.floor(Date.now() / 600000);
      const [n] = await db([['INCR', rl], ['EXPIRE', rl, 1300]]);
      if (n > 5) return send(res, 429, { error: 'たくさん ありがとう！ しばらく してから また 送ってください' });
      // まったく同じ内容は 1日1回だけ
      const dk = 'xd:idea:dup:' + crypto.createHash('sha256').update(cat + '|' + text).digest('hex').slice(0, 20);
      const [ok] = await db([['SET', dk, '1', 'NX', 'EX', 86400]]);
      if (ok !== 'OK') return send(res, 200, { ok: true, dup: true });
      const item = JSON.stringify({ id: crypto.randomBytes(5).toString('hex'), t: Date.now(), cat, text, v: String(body.v || '').slice(0, 20) });
      await db([['LPUSH', LIST, item], ['LTRIM', LIST, 0, MAX_KEEP - 1]]);
      return send(res, 200, { ok: true });
    }

    if (body.action === 'list' || body.action === 'delete') {
      if (!process.env.XD_ADMIN_KEY) return send(res, 503, { error: '管理用の鍵(XD_ADMIN_KEY)が 未設定です' });
      if (!isAdmin(String(body.key || ''))) return send(res, 401, { error: '鍵が ちがいます' });
      if (body.action === 'list') {
        const [rows, len] = await db([['LRANGE', LIST, 0, 499], ['LLEN', LIST]]);
        return send(res, 200, { ok: true, total: len, items: rows });
      }
      const raw = String(body.raw || '');
      if (!raw) return send(res, 400, { error: 'raw が ありません' });
      await db([['LREM', LIST, 0, raw]]);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'unknown action' });
  } catch (e) {
    return send(res, 500, { error: 'サーバーで エラーが おきました' });
  }
};
