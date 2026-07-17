// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface IRobinStaking {
    function notifyReward() external payable;
}

/// @title AthVault
/// @notice Per-launch platform treasury (10% of supply). After the token graduates to Uniswap, it trims
/// a small tranche each time the price prints a NEW all-time-high (TWAP-gated, manipulation-resistant),
/// once market cap is past a start gate. Each sale's ETH splits 40% to the project dev (who chooses
/// burn-or-withdraw), 20% to $ROBIN stakers, 40% to the platform. There is no path to withdraw the
/// token allocation itself — it can only be laddered out on new highs or bought-and-burned.
contract AthVault is IUniswapV3SwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint24 public constant POOL_FEE = 10000;

    // split (of each ATH sale's ETH)
    uint16 public constant DEV_BPS = 4000; // 40% -> dev (burn or withdraw)
    uint16 public constant STAKE_BPS = 2000; // 20% -> $ROBIN staking
    // remainder (40%) -> platform

    // ladder tuning
    uint16 public constant TRANCHE_BPS = 150; // sell 1.5% of remaining vault per ATH
    int24 public constant ATH_GAP_TICKS = 488; // ~5% price gap between triggering highs
    int24 public constant MAX_SPOT_DEVIATION_TICKS = 100; // spot must track TWAP within ~1% (anti-sandwich)
    uint32 public constant COOLDOWN = 1 hours;
    uint16 public constant SLIPPAGE_BPS = 100; // 1% — bounds any within-band sandwich to ~2%
    uint256 internal constant SQRT_FLOOR_X96 = 73044756656988588048856075193; // sqrt(0.85)*2^96
    uint256 internal constant SQRT_CEIL_X96 = 84962738866485953687210797629; // sqrt(1.15)*2^96

    // immutables
    IUniswapV3Factory public immutable v3Factory;
    IERC20 public immutable token;
    IERC20 public immutable weth;
    address public immutable dev;
    address public immutable platform;
    IRobinStaking public immutable staking;
    bool public immutable tokenIsToken0;
    address public immutable token0;
    address public immutable token1;
    uint32 public immutable twapWindow;
    int256 public immutable startLevel; // price-level gate (~$5k MC); trimming won't start below it

    // state (set at activation)
    bool public active;
    IUniswapV3Pool public pool;
    int256 public hwm; // highest price-level that has triggered a sale
    uint256 public lastSaleTime;
    uint256 public devReserveWeth; // WETH held for the dev to burn or withdraw
    uint256 public pendingStakeEth; // ETH that failed to reach staking; anyone can retry via flushStaking()

    error NotActive();
    error AlreadyActive();
    error NoPool();
    error NotEligible();
    error CooldownActive();
    error Slippage();
    error NotPool();
    error NotDev();
    error BadAmount();

    event Activated(address indexed pool, int24 launchTick);
    event AthSale(int256 level, uint256 tokensSold, uint256 wethOut);
    event Split(uint256 toDev, uint256 toStake, uint256 toPlatform);
    event DevBurn(uint256 wethSpent, uint256 tokensBurned);
    event DevWithdraw(uint256 amount);

    constructor(
        address v3Factory_,
        address token_,
        address weth_,
        address dev_,
        address platform_,
        address staking_,
        uint32 twapWindow_,
        int256 startLevel_
    ) {
        require(
            v3Factory_ != address(0) && token_ != address(0) && weth_ != address(0) && dev_ != address(0)
                && platform_ != address(0) && staking_ != address(0),
            "zero"
        );
        require(twapWindow_ >= 600, "twap");
        v3Factory = IUniswapV3Factory(v3Factory_);
        token = IERC20(token_);
        weth = IERC20(weth_);
        dev = dev_;
        platform = platform_;
        staking = IRobinStaking(staking_);
        twapWindow = twapWindow_;
        startLevel = startLevel_;
        (address t0, address t1) = token_ < weth_ ? (token_, weth_) : (weth_, token_);
        token0 = t0;
        token1 = t1;
        tokenIsToken0 = (token_ == t0);
    }

    /// @notice Turn the vault on once the token has graduated to its Uniswap pool. Permissionless, but
    /// self-validates against the canonical initialized pool, so it can't be pointed at a fake pool.
    function activate() external {
        if (active) revert AlreadyActive();
        address p = v3Factory.getPool(address(token), address(weth), POOL_FEE);
        if (p == address(0)) revert NoPool();
        (uint160 sqrtP, int24 tick,,,,,) = IUniswapV3Pool(p).slot0();
        if (sqrtP == 0) revert NoPool(); // not initialized yet
        pool = IUniswapV3Pool(p);
        active = true;
        hwm = _level(tick); // first ATH must exceed the graduation price
        emit Activated(p, tick);
    }

    // --------------------------------------------------------------- ATH ladder sell
    /// @notice Permissionless keeper: trims a tranche if price set a new TWAP ATH past the start gate.
    function poke() external nonReentrant returns (uint256 wethOut) {
        if (!active) revert NotActive();
        if (lastSaleTime != 0 && block.timestamp < lastSaleTime + COOLDOWN) revert CooldownActive();

        (uint160 spot, int24 spotTick,,,,,) = pool.slot0();
        int24 mean = _meanTick();
        if (_absDiff(spotTick, mean) > MAX_SPOT_DEVIATION_TICKS) revert NotEligible();

        int256 level = _level(mean);
        if (level < startLevel) revert NotEligible(); // below the ~$5k MC gate
        if (level < hwm + int256(uint256(uint24(ATH_GAP_TICKS)))) revert NotEligible(); // not a new-enough high

        uint256 bal = token.balanceOf(address(this));
        uint256 amountIn = Math.mulDiv(bal, TRANCHE_BPS, 10_000);
        if (amountIn == 0) revert BadAmount();

        // effects
        hwm = level;
        lastSaleTime = block.timestamp;

        // min-out from spot, which the tight deviation guard proves is within ~1% of the TWAP. (For an
        // even stricter floor, PoolMath.twapPriceWethPerToken(mean, tokenIsToken0) prices the TWAP tick
        // directly — recommended production hardening; see SPEC.)
        uint256 spotPrice = PoolMath.quoteWethPerToken(spot, tokenIsToken0);
        uint256 minOut = Math.mulDiv(Math.mulDiv(amountIn, spotPrice, 1e18), 10_000 - SLIPPAGE_BPS, 10_000);
        wethOut = _sellExactToken(amountIn, spot, minOut);

        emit AthSale(level, amountIn, wethOut);
        _split(wethOut);
    }

    function _split(uint256 amount) internal {
        uint256 toDev = Math.mulDiv(amount, DEV_BPS, 10_000);
        uint256 toStake = Math.mulDiv(amount, STAKE_BPS, 10_000);
        uint256 toPlatform = amount - toDev - toStake; // the remaining 40%

        devReserveWeth += toDev; // stays as WETH; dev burns or withdraws later
        if (toPlatform > 0) weth.safeTransfer(platform, toPlatform);
        if (toStake > 0) {
            IWETH9(address(weth)).withdraw(toStake);
            // a reverting staking contract must never brick an ATH sale; hold + retry via flushStaking()
            try staking.notifyReward{value: toStake}() {} catch {
                pendingStakeEth += toStake;
            }
        }
        emit Split(toDev, toStake, toPlatform);
    }

    /// @notice Retry pushing any ETH that previously failed to reach the staking contract.
    function flushStaking() external nonReentrant {
        uint256 amt = pendingStakeEth;
        if (amt == 0) return;
        pendingStakeEth = 0;
        try staking.notifyReward{value: amt}() {} catch {
            pendingStakeEth = amt;
        }
    }

    // --------------------------------------------------------------- dev: burn OR withdraw the 40%
    function devBurn(uint256 wethAmount, uint256 minTokensOut) external nonReentrant returns (uint256 burned) {
        if (msg.sender != dev) revert NotDev();
        if (wethAmount == 0 || wethAmount > devReserveWeth) revert BadAmount();
        devReserveWeth -= wethAmount;

        (uint160 spot,,,,,,) = pool.slot0();
        bool zeroForOne = !tokenIsToken0; // buying token with WETH
        uint160 limit = _limitFromSpot(spot, zeroForOne);
        (int256 a0, int256 a1) = pool.swap(BURN, zeroForOne, int256(wethAmount), limit, abi.encode(uint8(2)));
        burned = tokenIsToken0 ? uint256(-a0) : uint256(-a1);
        uint256 spent = tokenIsToken0 ? uint256(a1) : uint256(a0);
        if (burned < minTokensOut) revert Slippage();
        if (spent < wethAmount) devReserveWeth += (wethAmount - spent); // refund partial fill
        emit DevBurn(spent, burned);
    }

    function devWithdraw(uint256 amount) external nonReentrant {
        if (msg.sender != dev) revert NotDev();
        if (amount == 0 || amount > devReserveWeth) revert BadAmount();
        devReserveWeth -= amount;
        weth.safeTransfer(dev, amount);
        emit DevWithdraw(amount);
    }

    // --------------------------------------------------------------- swap callback
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        if (amount0Delta > 0) IERC20(token0).safeTransfer(address(pool), uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).safeTransfer(address(pool), uint256(amount1Delta));
    }

    receive() external payable {
        require(msg.sender == address(weth), "direct ETH");
    }

    // --------------------------------------------------------------- helpers (shared with MilestoneVault)
    function _sellExactToken(uint256 amountIn, uint160 spot, uint256 minOut) internal returns (uint256 received) {
        bool zeroForOne = tokenIsToken0; // selling token
        uint160 limit = _limitFromSpot(spot, zeroForOne);
        uint256 before = weth.balanceOf(address(this));
        (int256 a0, int256 a1) = pool.swap(address(this), zeroForOne, int256(amountIn), limit, abi.encode(uint8(1)));
        uint256 tokenSold = zeroForOne ? uint256(a0) : uint256(a1);
        if (tokenSold != amountIn) revert Slippage(); // require full fill
        received = weth.balanceOf(address(this)) - before;
        if (received < minOut) revert Slippage();
    }

    function _limitFromSpot(uint160 spot, bool zeroForOne) internal pure returns (uint160) {
        if (zeroForOne) {
            uint256 raw = Math.mulDiv(spot, SQRT_FLOOR_X96, PoolMath.Q96);
            return raw <= PoolMath.MIN_SQRT_RATIO ? PoolMath.MIN_SQRT_RATIO + 1 : uint160(raw);
        } else {
            uint256 raw = Math.mulDiv(spot, SQRT_CEIL_X96, PoolMath.Q96);
            return raw >= PoolMath.MAX_SQRT_RATIO ? PoolMath.MAX_SQRT_RATIO - 1 : uint160(raw);
        }
    }

    function _meanTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        return PoolMath.meanTick(cum[0], cum[1], twapWindow);
    }

    /// @dev monotonic price level: higher == higher token price regardless of token0/token1 ordering.
    function _level(int24 tick) internal view returns (int256) {
        return tokenIsToken0 ? int256(tick) : -int256(tick);
    }

    function _absDiff(int24 a, int24 b) internal pure returns (int24) {
        return a >= b ? a - b : b - a;
    }

    // views
    function tokenBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function pending() external view returns (bool eligible, int256 level, int256 nextThreshold) {
        if (!active) return (false, 0, 0);
        int24 mean = _meanTick();
        level = _level(mean);
        nextThreshold = hwm + int256(uint256(uint24(ATH_GAP_TICKS)));
        bool cool = lastSaleTime == 0 || block.timestamp >= lastSaleTime + COOLDOWN;
        eligible = cool && level >= startLevel && level >= nextThreshold;
    }
}
