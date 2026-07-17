# Build a Bot

Everything on Robin Labs is **permissionless and public** — no API key, no
allow-list, no sign-up. If you can send a transaction, you can integrate. This
page is the fast path for bot devs: the three things you need and nothing else.

## The three calls

**1. Watch for new launches** — subscribe to one event on the factory:

```js
import { ethers } from "ethers";
const provider = new ethers.JsonRpcProvider("https://robinhoodchain.blockscout.com/api/eth-rpc");
const FACTORY = "0xc208e393990B6f2BC8D0d330E0be38C6eCA1e25B";

const factory = new ethers.Contract(FACTORY, [
  "event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought)",
], provider);

factory.on("Launched", (token, curve, pool, dev) => {
  console.log("new coin:", token, "curve:", curve, "pool:", pool);
  // ...decide whether to snipe it
});
```

**2. Buy** — native ETH in, no approval:

```js
const ROUTER = "0x1988dEFfE3799Fb56F949ffb20C65D20c1547570";
const router = new ethers.Contract(ROUTER,
  ["function buy(address token,uint256 minOut) payable returns (uint256)"], signer);

const value = ethers.parseEther("0.1");
const quoted = await router.buy.staticCall(token, 0n, { value });
await (await router.buy(token, quoted * 99n / 100n, { value })).wait(); // 1% slippage
```

**3. Sell** — one exact-amount approval, then sell:

```js
const erc20 = new ethers.Contract(token, ["function approve(address,uint256) returns (bool)"], signer);
await (await erc20.approve(ROUTER, amountIn)).wait();
const r = new ethers.Contract(ROUTER, ["function sell(address token,uint256 amountIn,uint256 minOutEth) returns (uint256)"], signer);
await (await r.sell(token, amountIn, minOutEth)).wait();
```

That's a working trade bot. See the [Integration Guide](integration.md) for the
full surface (quotes, reading curve progress, graduation).

## Skip the RPC crawl — use the API

Don't poll the chain for discovery. The [Indexer API](api.md) hands you every
coin, sorted and enriched, in one request:

```http
GET /api/coins?sort=new&limit=50        # freshest launches, for a snipe feed
GET /api/coins?sort=trending             # what's hot in the last 24h
GET /api/trades/{token}?limit=100        # a coin's recent flow
```

Each coin comes back with `progress`, `mcapEth`, `vol24hEth` and price — no
per-coin chain reads. Perfect for an alert bot or a trending scanner.

## Ideas that print

- **Snipe bot** — buy on the `Launched` event, inside the same block the dev opens.
- **Buy-alert / trending bot** — poll `/api/coins?sort=trending`, post to Telegram/X.
- **Keeper** — `graduate()` is permissionless; fire it the moment `ready()` flips.
- **Copy-trade** — watch `Bought`/`Sold` for a wallet, mirror it.

## No gatekeeping

There is nothing to request and no rate limit on-chain. Build it, ship it, and
every trade your bot routes still pays the coin's fee in-protocol — so the whole
ecosystem (and the coin's floor) grows with your volume. Bring the bots.
