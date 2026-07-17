// The read API. Plain node:http (no framework). Everything is derived from the
// coins + trades tables by query, so it always reflects the current canonical
// chain — even right after a reorg re-scan. Volume/price are summed as ETH-scale
// REAL for ranking + display; per-trade wei stay exact in /api/trades.
import http from "node:http";
import { db } from "./db.js";
import { CFG } from "./config.js";
import { getHead } from "./indexer.js";

const DAY = 86400;

// One row per coin, enriched with all-time + 24h activity and last price (ETH/token).
const coinsStmt = (sort, filter, hasQ) => {
  const order = {
    new: "c.launch_block DESC",
    trending: "vol_24h DESC, trades_24h DESC, c.launch_block DESC",
    top: "vol_all DESC, c.launch_block DESC",
    graduated: "c.grad_block DESC",
  }[sort] || "c.launch_block DESC";
  const where = [];
  if (filter === "live") where.push("c.graduated = 0");
  if (filter === "graduated") where.push("c.graduated = 1");
  if (hasQ) where.push("(LOWER(c.name) LIKE @q OR LOWER(c.symbol) LIKE @q OR c.token LIKE @q)");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM trades t WHERE t.token=c.token) AS trades_all,
      (SELECT COUNT(*) FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS trades_24h,
      (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token) AS vol_all,
      (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS vol_24h,
      (SELECT MAX(t.ts) FROM trades t WHERE t.token=c.token) AS last_trade_ts,
      (SELECT CAST(t.eth AS REAL)/NULLIF(CAST(t.tokens AS REAL),0)
         FROM trades t WHERE t.token=c.token ORDER BY t.block DESC, t.log_index DESC LIMIT 1) AS last_price
    FROM coins c
    ${whereSql}
    ORDER BY ${order}
    LIMIT @limit OFFSET @offset
  `);
};

const shapeCoin = (r) => ({
  token: r.token, curve: r.curve, pool: r.pool, dev: r.dev,
  name: r.name, symbol: r.symbol,
  launchBlock: r.launch_block, launchTs: r.launch_ts, launchTx: r.launch_tx,
  devBought: r.dev_bought,
  graduated: !!r.graduated,
  gradBlock: r.grad_block, gradTs: r.grad_ts, raisedWeth: r.raised_weth, bond: r.bond,
  tradesAll: r.trades_all, trades24h: r.trades_24h,
  volAllEth: r.vol_all, vol24hEth: r.vol_24h,
  lastTradeTs: r.last_trade_ts, lastPriceEth: r.last_price,
  // live curve snapshot — lets the pad render the progress bar + mcap with no
  // per-coin chain read (the whole point of the indexer at scale).
  progress: r.progress, mcapEth: r.mcap_eth, lastTick: r.last_tick, snapTs: r.snap_ts,
  startTick: r.start_tick, minGradTick: r.min_grad_tick, gradTick: r.grad_tick, gradTarget: r.grad_target,
});

const statsStmt = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM coins) AS coins,
    (SELECT COUNT(*) FROM coins WHERE graduated=1) AS graduated,
    (SELECT COUNT(*) FROM trades) AS trades_all,
    (SELECT COUNT(*) FROM trades WHERE ts>=@since) AS trades_24h,
    (SELECT COALESCE(SUM(CAST(eth AS REAL)),0)/1e18 FROM trades) AS vol_all,
    (SELECT COALESCE(SUM(CAST(eth AS REAL)),0)/1e18 FROM trades WHERE ts>=@since) AS vol_24h
`);

const oneCoinStmt = db.prepare(`
  SELECT c.*,
    (SELECT COUNT(*) FROM trades t WHERE t.token=c.token) AS trades_all,
    (SELECT COUNT(*) FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS trades_24h,
    (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token) AS vol_all,
    (SELECT COALESCE(SUM(CAST(t.eth AS REAL)),0)/1e18 FROM trades t WHERE t.token=c.token AND t.ts>=@since) AS vol_24h,
    (SELECT MAX(t.ts) FROM trades t WHERE t.token=c.token) AS last_trade_ts,
    (SELECT CAST(t.eth AS REAL)/NULLIF(CAST(t.tokens AS REAL),0)
       FROM trades t WHERE t.token=c.token ORDER BY t.block DESC, t.log_index DESC LIMIT 1) AS last_price
  FROM coins c WHERE c.token=@token
`);
const tradesStmt = db.prepare(
  "SELECT tx, log_index, side, actor, eth, tokens, fee, block, ts FROM trades WHERE token=? ORDER BY block DESC, log_index DESC LIMIT ?");

function send(res, code, body, origin) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "cache-control": "public, max-age=5",
  });
  res.end(json);
}

export function startApi() {
  const server = http.createServer((req, res) => {
    const origin = CFG.corsOrigin;
    if (req.method === "OPTIONS") { send(res, 204, {}, origin); return; }
    let url;
    try { url = new URL(req.url, "http://x"); } catch { send(res, 400, { error: "bad url" }, origin); return; }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const now = Math.floor(Date.now() / 1000);
    const since = now - DAY;

    try {
      if (path === "/" || path === "/health") {
        const c = db.prepare("SELECT COUNT(*) n FROM coins").get().n;
        const t = db.prepare("SELECT COUNT(*) n FROM trades").get().n;
        const cur = db.prepare("SELECT v FROM meta WHERE k='cursor'").get();
        return send(res, 200, { ok: true, head: getHead(), cursor: cur ? Number(cur.v) : null, coins: c, trades: t }, origin);
      }

      if (path === "/api/stats") {
        const s = statsStmt.get({ since });
        return send(res, 200, {
          coins: s.coins, graduated: s.graduated,
          tradesAll: s.trades_all, trades24h: s.trades_24h,
          volAllEth: s.vol_all, vol24hEth: s.vol_24h,
        }, origin);
      }

      if (path === "/api/coins") {
        const sort = url.searchParams.get("sort") || "new";
        const filter = url.searchParams.get("filter") || "all";
        const qRaw = (url.searchParams.get("q") || "").trim().toLowerCase();
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 60), 1), 200);
        const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
        const rows = coinsStmt(sort, filter, !!qRaw).all({
          since, limit, offset, q: qRaw ? `%${qRaw}%` : "%",
        });
        return send(res, 200, { coins: rows.map(shapeCoin), sort, filter, limit, offset }, origin);
      }

      let m = path.match(/^\/api\/coin\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const r = oneCoinStmt.get({ token: m[1].toLowerCase(), since });
        if (!r) return send(res, 404, { error: "not found" }, origin);
        return send(res, 200, { coin: shapeCoin(r) }, origin);
      }

      m = path.match(/^\/api\/trades\/(0x[0-9a-fA-F]{40})$/);
      if (m) {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 500);
        const rows = tradesStmt.all(m[1].toLowerCase(), limit).map((t) => ({
          tx: t.tx, logIndex: t.log_index, side: t.side, actor: t.actor,
          eth: t.eth, tokens: t.tokens, fee: t.fee, block: t.block, ts: t.ts,
        }));
        return send(res, 200, { trades: rows }, origin);
      }

      return send(res, 404, { error: "no such route" }, origin);
    } catch (e) {
      return send(res, 500, { error: String(e.message || e) }, origin);
    }
  });
  server.listen(CFG.port, () => console.log(`[api] listening on :${CFG.port}  (GET /health)`));
  return server;
}
