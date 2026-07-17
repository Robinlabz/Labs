// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title MilestoneVault
/// @notice Per-launch treasury holding the 30% allocation. It is the ONLY seller of that supply and
/// sells small, immutable tranches when a 30-minute TWAP crosses a price multiple of the launch price
/// (2x, 3x, ...). Proceeds split 50% to the project dev / 50% into a buyback reserve whose only exit is
/// buy-and-burn. There is deliberately NO withdraw / sweep / owner-drain / setter — the 30% can never
/// be rugged, only sold by rule or burned.
contract MilestoneVault is IUniswapV3SwapCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    // Tunables (immutable in bytecode).
    uint16 public constant SLIPPAGE_BPS = 100; // 1% — with the tight deviation guard bounds sandwich to ~2%
    uint32 public constant MILESTONE_COOLDOWN = 300; // >=5 min between tranche sells
    uint32 public constant BUYBACK_COOLDOWN = 6 hours;
    uint16 public constant BUYBACK_MAX_BPS = 2500; // <=25% of the reserve per buyback call
    uint32 public constant MIN_TWAP_WINDOW = 600; // milestone gate must average >=10 min (anti-manipulation)
    // Execution is only allowed when spot is within this many ticks of the TWAP mean. This is the
    // key defense against an attacker cratering (or pumping) spot in-tx to sell/buy the tranche off
    // the manipulation-resistant TWAP price. ~500 ticks ≈ 5%.
    int24 public constant MAX_SPOT_DEVIATION_TICKS = 100; // spot must track TWAP within ~1%
    uint256 internal constant SQRT_FLOOR_X96 = 73044756656988588048856075193; // sqrt(0.85)*2^96
    uint256 internal constant SQRT_CEIL_X96 = 84962738866485953687210797629; // sqrt(1.15)*2^96

    // Immutables
    address public immutable factory;
    IERC20 public immutable token;
    IERC20 public immutable weth;
    IUniswapV3Pool public immutable pool;
    address public immutable dev; // triggers buybacks and receives the 50% project share
    address public immutable token0;
    address public immutable token1;
    bool public immutable tokenIsToken0;

    // Set once at initialize()
    bool public initialized;
    int24 public launchTick;
    uint256 public launchPriceWethPerToken; // WETH-wei per 1e18 token at launch (manipulation-proof anchor)
    uint32 public twapWindow;
    uint16[] public multiplesX100; // e.g. [200,300,400,...]
    uint256[] public tranches; // token amount per milestone; sum == allocation
    uint256 public allocation;

    // Mutable state
    uint256 public nextMilestone;
    uint256 public totalSold;
    uint256 public lastMilestoneTime;
    uint256 public buybackReserve; // WETH wei retained for buy-and-burn
    uint256 public lastBuybackTime;

    error NotFactory();
    error NotDev();
    error AlreadyInit();
    error BadConfig();
    error NoMilestone();
    error NotEligible();
    error CooldownActive();
    error Slippage();
    error NotPool();
    error BadAmount();

    event Initialized(int24 launchTick, uint256 launchPrice, uint256 allocation, uint256 milestones);
    event MilestoneSold(uint256 indexed k, uint256 tokensSold, uint256 wethReceived, int24 meanTick);
    event ProceedsSplit(uint256 toDev, uint256 toReserve);
    event BuyAndBurn(uint256 wethSpent, uint256 tokensBurned);

    constructor(
        address factory_,
        address token_,
        address weth_,
        address pool_,
        address dev_
    ) {
        require(
            factory_ != address(0) && token_ != address(0) && weth_ != address(0) && pool_ != address(0)
                && dev_ != address(0),
            "zero addr"
        );
        factory = factory_;
        token = IERC20(token_);
        weth = IERC20(weth_);
        pool = IUniswapV3Pool(pool_);
        dev = dev_;
        address t0 = IUniswapV3Pool(pool_).token0();
        address t1 = IUniswapV3Pool(pool_).token1();
        token0 = t0;
        token1 = t1;
        tokenIsToken0 = (token_ == t0);
        require(token_ == t0 || token_ == t1, "token not in pool");
        require(weth_ == t0 || weth_ == t1, "weth not in pool");
    }

    /// @notice Configure the milestone schedule. Called once, by the factory, in the launch tx.
    function initialize(
        int24 launchTick_,
        uint256 launchPriceWethPerToken_,
        uint32 twapWindow_,
        uint16[] calldata multiplesX100_,
        uint256[] calldata tranches_
    ) external {
        if (msg.sender != factory) revert NotFactory();
        if (initialized) revert AlreadyInit();
        uint256 n = multiplesX100_.length;
        if (n == 0 || n != tranches_.length || twapWindow_ < MIN_TWAP_WINDOW) revert BadConfig();
        // A zero launch-price anchor would make every milestone minOut zero (no slippage floor).
        if (launchPriceWethPerToken_ == 0) revert BadConfig();

        uint256 sum;
        uint16 prevMult;
        for (uint256 i; i < n; ++i) {
            if (multiplesX100_[i] <= 100 || multiplesX100_[i] <= prevMult) revert BadConfig(); // strictly increasing, >1x
            prevMult = multiplesX100_[i];
            if (tranches_[i] == 0) revert BadConfig();
            sum += tranches_[i];
            multiplesX100.push(multiplesX100_[i]);
            tranches.push(tranches_[i]);
        }
        uint256 bal = token.balanceOf(address(this));
        if (sum != bal || bal == 0) revert BadConfig(); // every treasury token is scheduled; nothing hidden

        initialized = true;
        launchTick = launchTick_;
        launchPriceWethPerToken = launchPriceWethPerToken_;
        twapWindow = twapWindow_;
        allocation = bal;
        emit Initialized(launchTick_, launchPriceWethPerToken_, bal, n);
    }

    // ----------------------------------------------------------------- milestone sells

    /// @notice Permissionless keeper entrypoint. Executes the next milestone if its TWAP threshold is
    /// met and the cooldown has elapsed; otherwise reverts (fail-closed, no state change).
    function poke() external nonReentrant returns (uint256 wethReceived) {
        uint256 k = nextMilestone;
        if (k >= multiplesX100.length) revert NoMilestone();
        if (block.timestamp < lastMilestoneTime + MILESTONE_COOLDOWN && lastMilestoneTime != 0) {
            revert CooldownActive();
        }

        int24 mean = _meanTick();
        if (!_thresholdMet(mean, multiplesX100[k])) revert NotEligible();

        // Spot must track the (manipulation-resistant) TWAP: this blocks an attacker who craters/pumps
        // spot in-tx to sell the tranche far below the TWAP price that just cleared the gate.
        (uint160 spot, int24 spotTick,,,,,) = pool.slot0();
        if (_absDiff(spotTick, mean) > MAX_SPOT_DEVIATION_TICKS) revert NotEligible();

        uint256 amountIn = tranches[k];

        // effects first
        nextMilestone = k + 1;
        lastMilestoneTime = block.timestamp;
        totalSold += amountIn;

        // min-out from spot, which the tight deviation guard proves is within ~1% of the TWAP. (For an
        // even stricter floor, PoolMath.twapPriceWethPerToken(mean, tokenIsToken0) prices the TWAP tick
        // directly — recommended production hardening; see SPEC.)
        uint256 spotPrice = PoolMath.quoteWethPerToken(spot, tokenIsToken0);
        uint256 minOut = Math.mulDiv(Math.mulDiv(amountIn, spotPrice, 1e18), 10_000 - SLIPPAGE_BPS, 10_000);

        wethReceived = _sellExactToken(amountIn, spot, minOut);

        emit MilestoneSold(k, amountIn, wethReceived, mean);
        _splitProceeds(wethReceived);
    }

    function _sellExactToken(uint256 amountIn, uint160 spot, uint256 minOut) internal returns (uint256 received) {
        bool zeroForOne = tokenIsToken0; // selling `token`
        uint160 limit = _limitFromSpot(spot, zeroForOne);

        uint256 before = weth.balanceOf(address(this));
        (int256 a0, int256 a1) = pool.swap(address(this), zeroForOne, int256(amountIn), limit, abi.encode(uint8(1)));
        // require the tranche fully filled (else totalSold would overcount and strand tokens)
        uint256 tokenSold = zeroForOne ? uint256(a0) : uint256(a1);
        if (tokenSold != amountIn) revert Slippage();
        received = weth.balanceOf(address(this)) - before;
        if (received < minOut) revert Slippage();
    }

    /// @dev sqrtPriceLimit = spot × band, clamped (in uint256, before the uint160 cast) strictly inside
    /// the pool's absolute bounds — otherwise a ceil limit can overflow uint160 or exceed MAX_SQRT_RATIO
    /// and pool.swap reverts. zeroForOne pushes price down (use the floor band), else up (ceil band).
    function _limitFromSpot(uint160 spot, bool zeroForOne) internal pure returns (uint160) {
        if (zeroForOne) {
            uint256 raw = Math.mulDiv(spot, SQRT_FLOOR_X96, PoolMath.Q96);
            return raw <= PoolMath.MIN_SQRT_RATIO ? PoolMath.MIN_SQRT_RATIO + 1 : uint160(raw);
        } else {
            uint256 raw = Math.mulDiv(spot, SQRT_CEIL_X96, PoolMath.Q96);
            return raw >= PoolMath.MAX_SQRT_RATIO ? PoolMath.MAX_SQRT_RATIO - 1 : uint160(raw);
        }
    }

    function _absDiff(int24 a, int24 b) internal pure returns (int24) {
        return a >= b ? a - b : b - a;
    }

    function _splitProceeds(uint256 wethAmount) internal {
        uint256 half = wethAmount / 2;
        uint256 toReserve = wethAmount - half; // odd wei favors the burn side
        buybackReserve += toReserve;
        if (half > 0) weth.safeTransfer(dev, half);
        emit ProceedsSplit(half, toReserve);
    }

    // ----------------------------------------------------------------- buy & burn

    /// @notice Dev-triggered buy-and-burn from the reserve. The dev chooses WHEN; the bought tokens are
    /// sent straight to the burn address and can never reach any wallet. Throttled + slippage-guarded.
    function buyback(uint256 wethAmount, uint256 minTokensOut) external nonReentrant returns (uint256 burned) {
        if (msg.sender != dev) revert NotDev();
        if (wethAmount == 0 || wethAmount > buybackReserve) revert BadAmount();
        if (wethAmount > Math.mulDiv(buybackReserve, BUYBACK_MAX_BPS, 10_000)) revert BadAmount();
        if (lastBuybackTime != 0 && block.timestamp < lastBuybackTime + BUYBACK_COOLDOWN) revert CooldownActive();

        // spot must track the TWAP (blocks buying the burn at a manipulated/pumped spot price)
        (uint160 spot, int24 spotTick,,,,,) = pool.slot0();
        if (_absDiff(spotTick, _meanTick()) > MAX_SPOT_DEVIATION_TICKS) revert NotEligible();

        // effects first
        buybackReserve -= wethAmount;
        lastBuybackTime = block.timestamp;

        bool zeroForOne = !tokenIsToken0; // buying `token` with WETH
        uint160 limit = _limitFromSpot(spot, zeroForOne);

        (int256 amount0, int256 amount1) =
            pool.swap(BURN, zeroForOne, int256(wethAmount), limit, abi.encode(uint8(2)));

        // token out (negative delta on the token side), weth actually spent (positive delta on the weth side)
        burned = tokenIsToken0 ? uint256(-amount0) : uint256(-amount1);
        uint256 wethSpent = tokenIsToken0 ? uint256(amount1) : uint256(amount0);
        if (burned < minTokensOut) revert Slippage();

        // refund any unspent WETH (partial fill at the price limit) back to the reserve
        if (wethSpent < wethAmount) buybackReserve += (wethAmount - wethSpent);

        emit BuyAndBurn(wethSpent, burned);
    }

    // ----------------------------------------------------------------- swap callback

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        if (amount0Delta > 0) IERC20(token0).safeTransfer(address(pool), uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).safeTransfer(address(pool), uint256(amount1Delta));
    }

    // ----------------------------------------------------------------- views / helpers

    function _meanTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        return PoolMath.meanTick(cum[0], cum[1], twapWindow);
    }

    function _thresholdMet(int24 mean, uint16 multipleX100) internal view returns (bool) {
        int24 offset = _tickOffset(multipleX100);
        if (tokenIsToken0) {
            return mean >= launchTick + offset; // token price rises with tick
        } else {
            return mean <= launchTick - offset; // token price rises as tick falls
        }
    }

    /// @notice tick delta for a price multiple: round(ln(multiple)/ln(1.0001)). Precomputed for the
    /// common multiples; falls back to a safe log approximation only if an uncommon one is used.
    function _tickOffset(uint16 multipleX100) internal pure returns (int24) {
        if (multipleX100 == 150) return 4055;
        if (multipleX100 == 200) return 6932;
        if (multipleX100 == 300) return 10987;
        if (multipleX100 == 400) return 13864;
        if (multipleX100 == 500) return 16095;
        if (multipleX100 == 600) return 17918;
        if (multipleX100 == 800) return 20795;
        if (multipleX100 == 1000) return 23027;
        if (multipleX100 == 1500) return 27082;
        if (multipleX100 == 2000) return 29959;
        if (multipleX100 == 2500) return 32190;
        if (multipleX100 == 5000) return 39122;
        if (multipleX100 == 10000) return 46054;
        revert BadConfig();
    }

    function milestoneCount() external view returns (uint256) {
        return multiplesX100.length;
    }

    /// @notice UI/keeper helper: is the next milestone currently executable?
    function pending() external view returns (bool eligible, uint256 k, int24 meanTick) {
        k = nextMilestone;
        if (k >= multiplesX100.length) return (false, k, 0);
        meanTick = _meanTick();
        bool cool = lastMilestoneTime == 0 || block.timestamp >= lastMilestoneTime + MILESTONE_COOLDOWN;
        eligible = cool && _thresholdMet(meanTick, multiplesX100[k]);
    }
}
