// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LaunchToken
/// @notice A clean, hookless meme ERC20 with an AUTO-EXPIRING, BUY-SIDE-ONLY, revert-based
/// anti-snipe guard. There is deliberately NO transfer tax (Uniswap v3 forbids fee-on-transfer),
/// NO mint (supply is fixed at construction), NO blacklist power over sells, NO pausable transfers,
/// and NO owner switch to extend the guard. After the window the token is a permanently normal ERC20.
/// @dev All timing uses block.timestamp: on Arbitrum Orbit, block.number tracks the parent L1 block.
contract LaunchToken is ERC20 {
    struct GuardConfig {
        uint32 deadSecs; // buys revert entirely during this initial window
        uint32 phase1Secs; // tighter caps until launchTime + phase1Secs
        uint32 antiSnipeSecs; // guard fully expires at launchTime + antiSnipeSecs
        uint16 maxTxBps1; // phase 1 max buy size (bps of supply)
        uint16 maxWalletBps1; // phase 1 max wallet (bps of supply)
        uint16 maxTxBps2; // phase 2 max buy size
        uint16 maxWalletBps2; // phase 2 max wallet
        uint32 cooldownSecs; // per-wallet buy cooldown during phase 1
    }

    address public immutable factory;

    // Guard config (immutable — frozen at deploy, cannot be weaponized)
    uint32 public immutable deadSecs;
    uint32 public immutable phase1Secs;
    uint32 public immutable antiSnipeSecs;
    uint16 public immutable maxTxBps1;
    uint16 public immutable maxWalletBps1;
    uint16 public immutable maxTxBps2;
    uint16 public immutable maxWalletBps2;
    uint32 public immutable cooldownSecs;

    bool public tradingEnabled;
    address public pool;
    uint64 public launchTime;

    mapping(address => bool) public isExempt; // factory, pool, vault — holders/routers, not snipers
    mapping(address => bool) public blocklist; // add-only, buy-side only, frozen after the window
    mapping(address => uint256) public lastBuy;

    error NotFactory();
    error TradingNotLive();
    error AlreadyEnabled();
    error DeadWindow();
    error Blocked();
    error MaxTx();
    error MaxWallet();
    error Cooldown();
    error WindowOver();

    event TradingEnabled(address indexed pool, uint64 launchTime);
    event Blocklisted(address indexed account);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address factory_,
        GuardConfig memory g
    ) ERC20(name_, symbol_) {
        require(factory_ != address(0), "factory=0");
        require(g.antiSnipeSecs >= g.phase1Secs && g.phase1Secs >= g.deadSecs, "bad windows");
        factory = factory_;
        deadSecs = g.deadSecs;
        phase1Secs = g.phase1Secs;
        antiSnipeSecs = g.antiSnipeSecs;
        maxTxBps1 = g.maxTxBps1;
        maxWalletBps1 = g.maxWalletBps1;
        maxTxBps2 = g.maxTxBps2;
        maxWalletBps2 = g.maxWalletBps2;
        cooldownSecs = g.cooldownSecs;
        isExempt[factory_] = true;
        _mint(factory_, supply_);
    }

    /// @notice Latches trading on and records the pool + exemptions. Called once, atomically, by the
    /// factory at the end of launch(). One-way — there is no disableTrading().
    function enableTrading(address pool_, address vault_, uint64 launchTime_) external onlyFactory {
        if (tradingEnabled) revert AlreadyEnabled();
        require(pool_ != address(0), "pool=0");
        pool = pool_;
        isExempt[pool_] = true;
        if (vault_ != address(0)) isExempt[vault_] = true;
        launchTime = launchTime_;
        tradingEnabled = true;
        emit TradingEnabled(pool_, launchTime_);
    }

    /// @notice Add known sniper bots to the buy-side blocklist. Add-only, and permanently frozen
    /// once the anti-snipe window ends — it can never be used to block a normal holder's sell.
    function seedBlocklist(address[] calldata bots) external onlyFactory {
        if (tradingEnabled && block.timestamp >= uint256(launchTime) + antiSnipeSecs) revert WindowOver();
        for (uint256 i; i < bots.length; ++i) {
            blocklist[bots[i]] = true;
            emit Blocklisted(bots[i]);
        }
    }

    // ----- live view of the guard (for the UI / DexScreener / honeypot scanners) -----
    function antiSnipeActive() public view returns (bool) {
        return tradingEnabled && block.timestamp < uint256(launchTime) + antiSnipeSecs;
    }

    function windowEndsAt() external view returns (uint256) {
        return uint256(launchTime) + antiSnipeSecs;
    }

    function maxTxNow() public view returns (uint256) {
        if (!antiSnipeActive()) return type(uint256).max;
        uint16 bps = block.timestamp < uint256(launchTime) + phase1Secs ? maxTxBps1 : maxTxBps2;
        return (totalSupply() * bps) / 10_000;
    }

    function maxWalletNow() public view returns (uint256) {
        if (!antiSnipeActive()) return type(uint256).max;
        uint16 bps = block.timestamp < uint256(launchTime) + phase1Secs ? maxWalletBps1 : maxWalletBps2;
        return (totalSupply() * bps) / 10_000;
    }

    function cooldownNow() public view returns (uint256) {
        if (!antiSnipeActive()) return 0;
        return block.timestamp < uint256(launchTime) + phase1Secs ? cooldownSecs : 0;
    }

    function _update(address from, address to, uint256 value) internal override {
        // mint / burn always pass (only the constructor mint and any user burns to 0)
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        bool fromExempt = isExempt[from];
        bool toExempt = isExempt[to];

        if (!tradingEnabled) {
            // Pre-trading, only the launch flow (factory as an exempt party) may move tokens.
            if (!fromExempt && !toExempt) revert TradingNotLive();
            super._update(from, to, value);
            return;
        }

        // Only enforce guardrails inside the finite window; afterwards this is a one-SLOAD short-circuit.
        if (block.timestamp < uint256(launchTime) + antiSnipeSecs) {
            bool isBuy = (from == pool);
            if (isBuy && !toExempt) {
                if (block.timestamp < uint256(launchTime) + deadSecs) revert DeadWindow();
                if (blocklist[to]) revert Blocked();
                if (value > maxTxNow()) revert MaxTx();
                if (balanceOf(to) + value > maxWalletNow()) revert MaxWallet();
                uint256 cd = cooldownNow();
                if (cd != 0) {
                    if (block.timestamp <= lastBuy[to] + cd) revert Cooldown();
                    lastBuy[to] = block.timestamp;
                }
            }
            // Sells (to == pool) and ordinary wallet transfers are never restricted (anti-honeypot).
        }

        super._update(from, to, value);
    }
}
