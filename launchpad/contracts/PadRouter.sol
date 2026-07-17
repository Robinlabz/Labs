// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurveForBond {
    function bond() external view returns (address);
}

interface ICurveState {
    function graduated() external view returns (bool);
    function gradSqrtPriceX96() external view returns (uint160);
}

interface IBondPoke {
    function poke() external;
}

/// @title PadRouter — the Pad's swap desk + the project fee
/// @notice Robinhood Chain has no canonical Uniswap periphery, so this IS the router every trade goes
/// through. Buys take native ETH (no token approval); sells take the token (one exact-amount approval to
/// THIS router). It applies a per-coin swap fee (1%–4% per side):
///
///   • The DEFAULT 1% is the platform's — collected as **0.9% immediately** and **0.1% held until the coin
///     graduates**, then released to the platform.
///   • Anything a project stacks ABOVE the 1% default is split: **25% is the platform buy-back cut**
///     (accrued separately and paid out to the platform, which buys/burns the platform token off-chain) and **75% is
///     the project's** — across its own wallet, deepening that coin's Bond floor, and auto-burning supply.
///
/// So a coin on the plain 1% just pays the house; a coin that runs a spicier fee sends the platform a bigger
/// slice earmarked for the platform buy-back. The fee is a swap-desk fee, NOT a token transfer tax (which would break
/// Uniswap v3 and flag as a honeypot), so the token stays clean and tradeable.
///
/// Design note: fee shares accumulate as ESCROW and are paid out by separate, permissionless flush/withdraw
/// calls — never inside the user's trade. So a bad project wallet, a paused Bond, or a burn swap can never
/// make someone's buy or sell revert.
contract PadRouter is Ownable2Step, ReentrancyGuard, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_TAX_BPS = 400; // 4% hard cap, per side
    uint16 public constant DEFAULT_FEE_BPS = 100; // the baseline 1% every coin pays; also the floor
    uint16 public constant PLATFORM_IMMEDIATE_BPS = 90; // of the default 1%: 0.9% to platform now
    uint16 public constant PLATFORM_DEFERRED_BPS = 10; // ...and 0.1% held until graduation
    uint16 public constant EXCESS_PLATFORM_BPS = 2500; // 25% of the ABOVE-default fee -> platform (platform buy-back cut)
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable WETH;

    struct Cfg {
        address pool;
        address curve;
        address projectWallet;
        uint16 buyBps; // ≤ MAX_TAX_BPS
        uint16 sellBps; // ≤ MAX_TAX_BPS
        uint16 walletBps; // split of the PROJECT share (the 75%); the three sum to 10000
        uint16 floorBps;
        uint16 burnBps;
        bool set;
    }

    address public factory; // only the factory may register a coin (set once)
    mapping(address => Cfg) internal _cfg;
    mapping(address => address) public bondOf; // token -> its Bond (once graduated)

    // escrowed fee shares (all in native ETH), paid out by permissionless flushers
    uint256 public platformEscrow; // the 0.9% immediate cut (+ deferred once claimed)
    uint256 public platformCutEscrow; // 25% of every above-default fee -> paid to the platform buy-back
    mapping(address => uint256) public deferredEscrow; // the 0.1% held per coin until it graduates
    mapping(address => uint256) public devEscrow;
    mapping(address => uint256) public floorEscrow;
    mapping(address => uint256) public burnEscrow;

    bool private _swapping;
    address private _activePool; // the pool we're mid-swap with (callback authenticity check)

    error Unknown();
    error OnlyFactory();
    error NotCreator();
    error AlreadySet();
    error BadTax();
    error BadAlloc();
    error Slippage();
    error Dust();

    event Registered(address indexed token, uint16 buyBps, uint16 sellBps, uint16 walletBps, uint16 floorBps, uint16 burnBps);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 fee, uint256 ethOut);
    event FeeSplit(address indexed token, uint256 platform, uint256 deferred, uint256 platformCut, uint256 dev, uint256 floor, uint256 burn);

    constructor(address weth_, address owner_) Ownable(owner_) {
        require(weth_ != address(0), "zero");
        WETH = weth_;
    }

    receive() external payable {} // WETH.withdraw

    function setFactory(address f) external onlyOwner {
        require(factory == address(0) && f != address(0), "set");
        factory = f;
    }

    /// @notice Ownership is load-bearing — the platform's immediate cut, deferred 0.1% and platform buy-back cut all
    /// pay out to owner(). Renouncing would strand those escrows forever, so it is permanently disabled.
    /// (Ownership can still be transferred via Ownable2Step's two-step transferOwnership/acceptOwnership.)
    function renounceOwnership() public pure override {
        revert("disabled");
    }

    function configOf(address token) external view returns (Cfg memory) {
        return _cfg[token];
    }

    /// @notice Registered once, by the factory, when a coin launches. Enforces the 4% caps and that the
    /// project-share allocation sums to 100%.
    function register(
        address token,
        address pool,
        address curve,
        address projectWallet,
        uint16 buyBps,
        uint16 sellBps,
        uint16 walletBps,
        uint16 floorBps,
        uint16 burnBps
    ) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (_cfg[token].set) revert AlreadySet(); // register-once: a coin's config can never be overwritten
        // every coin pays at least the default 1%, up to the 4% cap, per side
        if (buyBps < DEFAULT_FEE_BPS || sellBps < DEFAULT_FEE_BPS || buyBps > MAX_TAX_BPS || sellBps > MAX_TAX_BPS) {
            revert BadTax();
        }
        if (uint256(walletBps) + floorBps + burnBps != 10_000) revert BadAlloc();
        // the project wallet always receives money now (the sell-side 1% base), so it can never be zero
        if (projectWallet == address(0)) revert BadAlloc();
        _cfg[token] = Cfg(pool, curve, projectWallet, buyBps, sellBps, walletBps, floorBps, burnBps, true);
        emit Registered(token, buyBps, sellBps, walletBps, floorBps, burnBps);
    }

    // ─────────────────────────────────────────────────────────── trading ──
    /// @notice Buy `token` with native ETH. No token approval. `minOut` guards slippage.
    function buy(address token, uint256 minOut) external payable nonReentrant returns (uint256 tokensOut) {
        Cfg storage c = _cfg[token];
        if (!c.set) revert Unknown();
        uint256 feeMax = (msg.value * c.buyBps) / 10_000;
        uint256 netMax = msg.value - feeMax;
        if (netMax == 0) revert Dust();

        IWETH9(WETH).deposit{value: netMax}();
        // pre-graduation, cap the buy at the graduation price so a big buy stops exactly at the curve top
        // instead of running the price into the empty space beyond it (which would brick graduation)
        uint160 cap;
        if (c.curve != address(0) && !ICurveState(c.curve).graduated()) cap = ICurveState(c.curve).gradSqrtPriceX96();
        uint256 consumed;
        (tokensOut, consumed) = _swap(token, c.pool, WETH, netMax, msg.sender, cap);
        if (tokensOut < minOut) revert Slippage();

        // How much WETH the pool actually took, straight from the swap (NOT balanceOf — a donor could inflate
        // that to evade the fee). On a normal buy consumed == netMax; on a buy that hits the graduation cap the
        // pool takes less and leaves a remainder.
        uint256 leftover = netMax - consumed;
        uint256 fee;
        uint256 spent;
        if (leftover == 0) {
            // fully consumed — charge the fee on the gross, exactly as configured
            fee = feeMax;
            spent = msg.value;
            _distribute(token, msg.value, c.buyBps, false);
        } else {
            // Partial fill (buy overshot the curve): charge the fee only on what was actually consumed and
            // refund the rest — fee included — so a buyer whose order can't be fully absorbed is never taxed
            // on ETH that never entered the trade.
            IWETH9(WETH).withdraw(leftover);
            fee = (consumed * c.buyBps) / 10_000;
            spent = consumed + fee;
            uint256 refund = msg.value - spent; // = feeMax + leftover - fee, always ≥ 0
            if (refund > 0) {
                (bool r,) = msg.sender.call{value: refund}("");
                require(r, "refund");
            }
            _distribute(token, consumed, c.buyBps, false);
        }
        emit Bought(token, msg.sender, spent, fee, tokensOut);
    }

    /// @notice Sell `amountIn` of `token` for native ETH. Requires an exact-amount approval to THIS router
    /// (the one approval in the app). `minOutEth` guards slippage AFTER the tax.
    function sell(address token, uint256 amountIn, uint256 minOutEth) external nonReentrant returns (uint256 ethOut) {
        Cfg storage c = _cfg[token];
        if (!c.set) revert Unknown();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);

        (uint256 wethOut,) = _swap(token, c.pool, token, amountIn, address(this), 0);
        IWETH9(WETH).withdraw(wethOut);

        uint256 fee = (wethOut * c.sellBps) / 10_000;
        ethOut = wethOut - fee;
        if (ethOut < minOutEth) revert Slippage();

        _distribute(token, wethOut, c.sellBps, true);
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "pay");
        emit Sold(token, msg.sender, amountIn, fee, ethOut);
    }

    /// @dev Swap `amountIn` of `tokenIn` through the pool to `recipient`; returns the output amount.
    /// The router already holds `amountIn` of `tokenIn` (wrapped WETH for a buy, pulled token for a sell);
    /// the callback pays it. Swaps as far as the pool allows (slippage is checked by the caller).
    /// @param capLimit optional sqrtPriceX96 cap (0 = swap as far as the pool allows). Used to stop a
    /// pre-graduation buy exactly at the graduation price so it can't overshoot the curve into empty space.
    function _swap(address token, address pool, address tokenIn, uint256 amountIn, address recipient, uint160 capLimit)
        internal
        returns (uint256 out, uint256 consumedIn)
    {
        bool tokenIsToken0 = token < WETH;
        bool tokenInIsToken0 = tokenIn == WETH ? !tokenIsToken0 : tokenIsToken0;
        bool zeroForOne = tokenInIsToken0;
        uint160 limit = capLimit != 0 ? capLimit : (zeroForOne ? PoolMath.MIN_SQRT_RATIO + 1 : PoolMath.MAX_SQRT_RATIO - 1);

        _swapping = true;
        _activePool = pool;
        (int256 a0, int256 a1) =
            IUniswapV3Pool(pool).swap(recipient, zeroForOne, int256(amountIn), limit, abi.encode(tokenIn));
        _activePool = address(0);
        _swapping = false;
        // The pool reports both sides: the POSITIVE delta is the input it actually took, the NEGATIVE delta is
        // the output it sent. We drive fee/refund accounting off `consumedIn` (never off balanceOf, which a
        // donor could inflate to evade the fee).
        (consumedIn, out) = zeroForOne ? (uint256(a0), uint256(-a1)) : (uint256(a1), uint256(-a0));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        // only reachable during one of our own swaps, and only from THAT pool
        require(_swapping && msg.sender == _activePool, "no swap");
        address tokenIn = abi.decode(data, (address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(tokenIn).safeTransfer(msg.sender, owed);
    }

    /// @dev Split the fee for one trade. `value` is the ETH the fee is charged on (msg.value on a buy, the
    /// WETH-out on a sell); `feeBps` is that side's rate; `sellSide` is true for a sell. The default 1% base
    /// goes to the PLATFORM on a buy (0.9% now, 0.1% deferred to graduation) and to the CREATOR on a sell
    /// (paid to the project wallet). Anything above 1% splits 25% to the platform buy-back and 75% to the
    /// project on both sides.
    function _distribute(address token, uint256 value, uint256 feeBps, bool sellSide) internal {
        // the exact fee charged to the trader (buy/sell computed it the same way); accrue it to the wei
        uint256 fee = (value * feeBps) / 10_000;
        if (fee == 0) return;

        // The above-default excess is the "clean" piece; the default-1% base takes the remainder, so the
        // parts sum to `fee` exactly (no dust).
        uint256 excess = feeBps > DEFAULT_FEE_BPS ? (value * (feeBps - DEFAULT_FEE_BPS)) / 10_000 : 0;
        uint256 base = fee - excess; // the default 1% (absorbs rounding)

        uint256 platformImmediate;
        uint256 deferred;
        uint256 creatorBase;
        if (sellSide) {
            // sell-side default 1% is the CREATOR's — accrues to the project wallet's escrow
            creatorBase = base;
            devEscrow[token] += base;
        } else {
            // buy-side default 1% is the platform's: 0.9% now + 0.1% held until the coin graduates
            deferred = (value * PLATFORM_DEFERRED_BPS) / 10_000;
            platformImmediate = base - deferred;
            platformEscrow += platformImmediate;
            deferredEscrow[token] += deferred;
        }

        uint256 platformCut;
        uint256 dev;
        uint256 floor;
        uint256 burn;
        if (excess > 0) {
            // 25% -> the platform buy-back cut; 75% -> the project's buckets (floor absorbs rounding)
            platformCut = (excess * EXCESS_PLATFORM_BPS) / 10_000;
            platformCutEscrow += platformCut;
            uint256 proj = excess - platformCut;
            Cfg storage c = _cfg[token];
            dev = (proj * c.walletBps) / 10_000;
            burn = (proj * c.burnBps) / 10_000;
            floor = proj - dev - burn;
            devEscrow[token] += dev;
            burnEscrow[token] += burn;
            floorEscrow[token] += floor;
        }
        // `dev` field = everything credited to the project wallet this trade (the sell base + its excess share)
        emit FeeSplit(token, platformImmediate, deferred, platformCut, creatorBase + dev, floor, burn);
    }

    // ─────────────────────────────────────────── permissionless payouts ──
    /// @notice Learn a coin's Bond once it has graduated, so the floor share can be routed to it.
    function syncBond(address token) public returns (address b) {
        Cfg storage c = _cfg[token];
        if (!c.set || c.curve == address(0)) return address(0);
        b = ICurveForBond(c.curve).bond();
        if (b != address(0)) bondOf[token] = b;
    }

    function withdrawPlatform() external nonReentrant {
        uint256 amt = platformEscrow;
        platformEscrow = 0;
        (bool ok,) = owner().call{value: amt}("");
        require(ok, "pay");
    }

    /// @notice Collect the creator's accrued sell-fee + wallet share to the project wallet. Anyone can trigger
    /// it (e.g. from a public dashboard); the funds only ever go to the wallet the project set at launch.
    function withdrawDev(address token) external nonReentrant {
        uint256 amt = devEscrow[token];
        if (amt == 0) return;
        devEscrow[token] = 0;
        (bool ok,) = _cfg[token].projectWallet.call{value: amt}("");
        require(ok, "pay");
    }

    /// @notice The creator's alternative to collecting: spend their accrued escrow buying the coin and burning
    /// it. Only the project wallet may choose to burn its OWN money (a random caller can't torch it); the plain
    /// collect above stays public. Pre-graduation the buy is capped at the graduation price (no curve overshoot).
    function burnDev(address token) external nonReentrant {
        Cfg storage c = _cfg[token];
        if (msg.sender != c.projectWallet) revert NotCreator();
        uint256 amt = devEscrow[token];
        if (amt == 0) return;
        devEscrow[token] = 0;
        IWETH9(WETH).deposit{value: amt}();
        uint160 cap;
        if (c.curve != address(0) && !ICurveState(c.curve).graduated()) cap = ICurveState(c.curve).gradSqrtPriceX96();
        (uint256 bought, uint256 consumed) = _swap(token, c.pool, WETH, amt, address(this), cap);
        IERC20(token).safeTransfer(DEAD, bought);
        // re-credit any WETH the swap couldn't spend (e.g. a burn-buy that hit the graduation cap). Uses the
        // swap's own consumed amount, not balanceOf, so a stray WETH donation can't be scooped into escrow.
        uint256 left = amt - consumed;
        if (left > 0) {
            IWETH9(WETH).withdraw(left);
            devEscrow[token] += left;
        }
    }

    /// @notice Push the accrued floor share into the coin's Bond as fresh WETH, then poke it so it becomes
    /// buy-wall depth. No-op until the coin has graduated and a Bond exists.
    function flushFloor(address token) external nonReentrant {
        uint256 amt = floorEscrow[token];
        if (amt == 0) return;
        address b = bondOf[token];
        if (b == address(0)) b = syncBond(token);
        if (b == address(0)) return; // not graduated yet — leave it escrowed
        floorEscrow[token] = 0;
        IWETH9(WETH).deposit{value: amt}();
        IERC20(WETH).safeTransfer(b, amt); // Bond's next poke() places all held WETH as Bounty
        try IBondPoke(b).poke() {} catch {}
    }

    /// @notice Release a coin's deferred 0.1% to the platform, once it has graduated. No-op before then.
    /// Permissionless; the funds only ever move to the platform escrow.
    function claimDeferred(address token) external nonReentrant {
        uint256 amt = deferredEscrow[token];
        if (amt == 0) return;
        address b = bondOf[token];
        if (b == address(0)) b = syncBond(token);
        if (b == address(0)) return; // not graduated yet — keep it held
        deferredEscrow[token] = 0;
        platformEscrow += amt;
    }

    /// @notice Pay the accrued platform buy-back cut (25% of every above-default fee) to the platform, which buys and
    /// burns the platform token off-chain. Permissionless; the funds only ever go to the platform (owner).
    function withdrawPlatformCut() external nonReentrant {
        uint256 amt = platformCutEscrow;
        if (amt == 0) return;
        platformCutEscrow = 0;
        (bool ok,) = owner().call{value: amt}("");
        require(ok, "pay");
    }

    /// @notice Spend the accrued burn share buying the token and sending it to the dead address.
    function flushBurn(address token) external nonReentrant {
        uint256 amt = burnEscrow[token];
        if (amt == 0) return;
        Cfg storage c = _cfg[token];
        burnEscrow[token] = 0;
        IWETH9(WETH).deposit{value: amt}();
        // pre-graduation, cap at the graduation price so a burn-buy can't overshoot the curve into empty
        // space and brick graduation (same guard the user-facing buy() uses)
        uint160 cap;
        if (c.curve != address(0) && !ICurveState(c.curve).graduated()) cap = ICurveState(c.curve).gradSqrtPriceX96();
        (uint256 bought, uint256 consumed) = _swap(token, c.pool, WETH, amt, address(this), cap);
        IERC20(token).safeTransfer(DEAD, bought);
        // if the swap couldn't consume all of it, re-credit the residual — using the swap's own consumed
        // amount, not balanceOf, so stray donated WETH can't be swept in
        uint256 left = amt - consumed;
        if (left > 0) {
            IWETH9(WETH).withdraw(left);
            burnEscrow[token] += left;
        }
    }
}
