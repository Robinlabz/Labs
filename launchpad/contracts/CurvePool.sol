// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurveBondDeployer {
    function deploy(address token, address weth, address v3Factory, address platform, address curve)
        external
        returns (address);
}

interface ICurveBond {
    function post(uint256 sherwoodWeth, uint256 sherwoodTokens, uint256 bountyWeth, uint256 ambushTokens) external;
}

/// @title CurvePool — a bonding curve that IS a real Uniswap v3 pool (DEX + DexScreener from block one)
/// @notice Instead of a math curve holding ETH off-DEX, the launch seeds the token as a single-sided
/// concentrated v3 position spanning [start, grad] price. That position behaves like a bonding curve — buyers
/// swap WETH in and walk the price up the range — but it's a genuine Uniswap pool, so DexScreener indexes and
/// charts it the moment it's created. When price reaches the graduation end (the curve is bought out), anyone
/// calls `graduate()`: it collects the raised WETH + any unsold token and posts the Bond (Sherwood + Bounty +
/// Ambush) into the SAME pool. No ETH from the platform — the token seeds its own liquidity; buyers bring ETH.
contract CurvePool is IUniswapV3MintCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    int24 public constant SPACING = 200;
    uint128 internal constant U128_MAX = type(uint128).max;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Factory public immutable v3Factory;
    IUniswapV3Pool public immutable pool;
    address public immutable token0;
    address public immutable token1;
    address public immutable platform; // buy-side (LP) fees + graduation sweep
    address public immutable dev; // project dev
    address public immutable bondDeployer;
    bool public immutable tokenIsToken0;

    uint256 public immutable curveSupply; // seeded as the single-sided curve
    uint256 public immutable ambushSupply; // paired into the Bond + rolled with any unsold curve tokens
    int24 public immutable startTick; // price at launch (curve bottom)
    int24 public immutable gradTick; // the curve's CEILING — buys can climb up to here, never past it
    int24 public immutable minGradTick; // graduation becomes eligible here ("let it ride" up to gradTick)

    uint16 public constant SHERWOOD_WETH_BPS = 6000; // 60% of the raise -> Sherwood LP, 40% -> Bounty floor
    uint16 public constant DEV_GRAD_BPS = 2500; // 25% of the raise -> the creator at graduation (launch incentive)
    int24 public constant GRAD_MAX_DEV = 50; // graduation can't post above the ceiling by more than this (anti-manipulation)
    uint16 public constant DEFAULT_GRAD_FRAC = 40; // default gradTarget sits 40% up the [min, ceiling] tick range
        // (≈+50% mcap over the bare minimum) so a hands-off launch graduates with a healthier floor / lighter wall
    uint256 public constant GRAD_TIMEOUT = 7 days; // abandon-proof: after this, anyone may graduate at the MINIMUM
        // even if the dev set a higher target and walked away — the floor can be delayed but never denied

    bool public seeded;
    bool public graduated;
    uint64 public seedTime; // when the curve was seeded — starts the graduation timeout clock
    address public bond;
    int24 public curveLo;
    int24 public curveHi;
    uint128 public curveL;
    int24 public gradTarget; // dev-set auto-graduation target: graduate() unlocks once price reaches here.
        // Defaults to minGradTick (graduatable at the $30k minimum); the dev may raise it toward the ceiling
        // to "let it ride" for a thicker floor, or lower it (never below the minimum) to graduate sooner.

    bool private _minting;

    error NotSeeded();
    error AlreadySeeded();
    error AlreadyGraduated();
    error NotReady();
    error NotPool();
    error NotDev();
    error BadTarget();

    event Seeded(int24 curveLo, int24 curveHi, uint128 liquidity);
    event Graduated(address indexed bond, uint256 raisedWeth, uint256 leftoverToken);
    event GradTargetSet(int24 targetTick);

    /// @param curveWidth_ tick span from start to the curve CEILING (a positive multiple of SPACING).
    /// @param minGradWidth_ tick span from start to the MINIMUM graduation price (< curveWidth_). Graduation
    /// is eligible from there up to the ceiling — "let it ride": the later it graduates, the bigger the raise
    /// and the thicker the floor.
    constructor(
        address token_,
        address weth_,
        address v3Factory_,
        address platform_,
        address dev_,
        address bondDeployer_,
        uint256 curveSupply_,
        uint256 ambushSupply_,
        int24 startTick_,
        int24 curveWidth_,
        int24 minGradWidth_
    ) {
        require(
            token_ != address(0) && weth_ != address(0) && v3Factory_ != address(0) && platform_ != address(0)
                && dev_ != address(0) && bondDeployer_ != address(0),
            "zero"
        );
        require(
            curveSupply_ > 0 && ambushSupply_ > 0 && curveWidth_ > 0 && curveWidth_ % SPACING == 0
                && startTick_ % SPACING == 0 && minGradWidth_ > 0 && minGradWidth_ % SPACING == 0
                && minGradWidth_ < curveWidth_,
            "params"
        );
        token = IERC20(token_);
        WETH = weth_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        platform = platform_;
        dev = dev_;
        bondDeployer = bondDeployer_;
        curveSupply = curveSupply_;
        ambushSupply = ambushSupply_;
        startTick = startTick_;

        bool tIs0 = token_ < weth_;
        tokenIsToken0 = tIs0;
        (token0, token1) = tIs0 ? (token_, weth_) : (weth_, token_);
        // The curve holds only the TOKEN. token0 => the token is on the ABOVE-price side (price rises with
        // tick); token1 => the token is on the BELOW-price side (price rises as tick falls).
        gradTick = tIs0 ? startTick_ + curveWidth_ : startTick_ - curveWidth_;
        minGradTick = tIs0 ? startTick_ + minGradWidth_ : startTick_ - minGradWidth_;
        // Default graduation target sits 40% of the way up the [min, ceiling] tick range — a healthier
        // hands-off structure than the bare minimum. The dev can move it anywhere in [min, ceiling] via
        // setGradTarget (down to the minimum to graduate sooner, up to the ceiling to ride).
        int24 gspan = tIs0 ? gradTick - minGradTick : minGradTick - gradTick; // positive tick distance
        int24 goff = int24((int256(gspan) * int256(uint256(DEFAULT_GRAD_FRAC))) / 100);
        gradTarget = tIs0 ? minGradTick + goff : minGradTick - goff;

        // Claim + initialize the pool at the start price (DEX + DexScreener live from here).
        address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, POOL_FEE);
        if (p == address(0)) p = IUniswapV3Factory(v3Factory_).createPool(token_, weth_, POOL_FEE);
        IUniswapV3Pool(p).initialize(PoolMath.getSqrtRatioAtTick(startTick_));
        pool = IUniswapV3Pool(p);
    }

    /// @notice Seed the curve — mint the single-sided token position. Call once, after this contract has been
    /// funded with `curveSupply + ambushSupply` tokens. Permissionless (idempotent-guarded).
    function seed() external nonReentrant {
        if (seeded) revert AlreadySeeded();
        seeded = true;
        seedTime = uint64(block.timestamp); // start the abandon-proof graduation timeout
        // Curve range: token0 => [start, grad] above; token1 => [grad, start] below.
        (int24 lo, int24 hi) = tokenIsToken0 ? (startTick, gradTick) : (gradTick, startTick);
        curveLo = lo;
        curveHi = hi;
        uint128 L =
            PoolMath.singleSidedLiquidity(PoolMath.getSqrtRatioAtTick(lo), PoolMath.getSqrtRatioAtTick(hi), curveSupply, tokenIsToken0);
        curveL = L;
        _mint(lo, hi, L);
        // Arm the TWAP oracle for the Bond's poke() guard. Robinhood Chain runs ~0.1s blocks and stores ≤1
        // observation per active block, so the ring buffer must hold enough slots to span the Bond's TWAP
        // window. 200 slots cover ~20s of continuous every-block trading (> the Bond's 15s window). We cannot
        // ask for more here: Robinhood Chain caps a single tx at 2**24 (~16.7M) gas, and pre-initializing the
        // observation slots is ~20k gas each, so a bigger bump would push launch() over the per-tx cap. Coins
        // that want a wider TWAP margin ramp the buffer up post-launch via growOracle() (many cheap txs).
        pool.increaseObservationCardinalityNext(200);
        emit Seeded(lo, hi, L);
    }

    /// @notice Permissionless: grow the pool's TWAP observation buffer toward `target`. Split across as many
    /// calls as needed so each stays under Robinhood Chain's per-tx gas cap. Only ever increases the buffer
    /// (Uniswap ignores a target ≤ the current one), so it can't shrink or grieve the oracle.
    function growOracle(uint16 target) external {
        pool.increaseObservationCardinalityNext(target);
    }

    /// @notice The pool price at the curve's CEILING. Buyers/routers cap the buy swap here so price can climb
    /// the whole curve (up to the ceiling) but never run past it into empty space.
    function gradSqrtPriceX96() external view returns (uint160) {
        return PoolMath.getSqrtRatioAtTick(gradTick);
    }

    /// @notice The pool price at the MINIMUM graduation point (where the graduate button first lights up).
    function minGradSqrtPriceX96() external view returns (uint160) {
        return PoolMath.getSqrtRatioAtTick(minGradTick);
    }

    /// @notice Auto-graduate: the dev sets the target price the coin graduates at. Must sit between the $30k
    /// minimum and the ceiling. `graduate()` (permissionless — a keeper/frontend fires it) unlocks once price
    /// reaches this. The dev can move it any time before graduation: raise it to ride for a thicker floor, or
    /// lower it (never below the minimum) to graduate sooner. Never lets a sniper graduate before the dev's mark.
    function setGradTarget(int24 targetTick) external {
        if (msg.sender != dev) revert NotDev();
        if (graduated) revert AlreadyGraduated();
        // target must be a real price in [minimum, ceiling], respecting token/WETH ordering
        bool ok = tokenIsToken0
            ? (targetTick >= minGradTick && targetTick <= gradTick)
            : (targetTick <= minGradTick && targetTick >= gradTick);
        if (!ok) revert BadTarget();
        gradTarget = targetTick;
        emit GradTargetSet(targetTick);
    }

    /// @notice Progress: is the coin graduatable? Normally price must reach the dev's target (default 40% up
    /// the curve). Abandon-proof fallback: once GRAD_TIMEOUT has passed since seeding, reaching the MINIMUM is
    /// enough — so a dev who sets a high target and walks away can delay the floor but never deny it.
    function ready() public view returns (bool) {
        if (!seeded || graduated) return false;
        (, int24 tick,,,,,) = pool.slot0();
        bool atTarget = tokenIsToken0 ? tick >= gradTarget : tick <= gradTarget;
        bool atMin = tokenIsToken0 ? tick >= minGradTick : tick <= minGradTick;
        return atTarget || (atMin && block.timestamp >= uint256(seedTime) + GRAD_TIMEOUT);
    }

    /// @notice Graduate — collect the raised WETH + unsold token from the curve and post the Bond. Permissionless.
    function graduate() external nonReentrant {
        if (!seeded) revert NotSeeded();
        if (graduated) revert AlreadyGraduated();
        if (!ready()) revert NotReady();

        // Anti-manipulation: the Bond is posted around the CURRENT price, so that price must be honest. Inside
        // the curve range [minGradTick, gradTick] it always is — to move spot UP a buyer must consume curve
        // liquidity, i.e. pay real WETH that JOINS the raise/floor, so a "high" spot is one the attacker funded
        // and the floor sits below it: nothing can be drained. The ONLY unbacked zone is ABOVE the ceiling
        // (no liquidity past gradTick, so spot is free to shove there), so we simply refuse to graduate above
        // the ceiling. That closes the floor-drain vector while allowing "let it ride" anywhere below it.
        (uint160 sp, int24 tickNow,,,,,) = pool.slot0();
        bool aboveCeil = tokenIsToken0 ? tickNow > gradTick + GRAD_MAX_DEV : tickNow < gradTick - GRAD_MAX_DEV;
        if (aboveCeil) revert NotReady();
        graduated = true;

        // pull the whole curve position back here (raised WETH + the still-unsold curve tokens)
        pool.burn(curveLo, curveHi, curveL);
        (uint256 c0, uint256 c1) = pool.collect(address(this), curveLo, curveHi, U128_MAX, U128_MAX);
        (uint256 raisedWeth, uint256 leftToken) = tokenIsToken0 ? (c1, c0) : (c0, c1);
        require(raisedWeth > 0, "empty");

        // Creator's graduation reward: a fixed cut of the raise paid to the dev as WETH (a launch incentive
        // on top of the ongoing sell-tax). Taken as a fraction so it can never exceed the raise or leave the
        // Bond unfunded — the remaining ≥75% funds the floor. WETH transfer can't reenter (nonReentrant + no
        // callback), and dev is guaranteed non-zero at construction.
        uint256 devReward = (raisedWeth * DEV_GRAD_BPS) / 10_000;
        if (devReward > 0) {
            raisedWeth -= devReward;
            IERC20(WETH).safeTransfer(dev, devReward);
        }

        // Post the Bond around the CURRENT price. The Sherwood LP needs tokens; pair them from the Ambush
        // reserve PLUS any still-unsold curve tokens (rolled in here rather than burned), and the remainder
        // becomes the Ambush sell-wall whose earnings deepen the floor. Graduating later => bigger raise =>
        // thicker floor AND fewer unsold tokens => a lighter sell-wall.
        uint256 sherwoodWeth = (raisedWeth * SHERWOOD_WETH_BPS) / 10_000;
        uint256 bountyWeth = raisedWeth - sherwoodWeth;
        // The whole token balance goes to the Bond: the ambush reserve + the unsold curve tokens just
        // collected + any rounding dust the seed mint left behind. Using the actual balance (rather than
        // ambushSupply + leftToken) guarantees nothing is stranded in the curve. A stray token donation would
        // only inflate the harmless Ambush wall — it can't be extracted.
        uint256 tokenPool = token.balanceOf(address(this));
        uint256 quote = PoolMath.quoteWethPerToken(sp, tokenIsToken0);
        require(quote > 0, "price"); // fail fast rather than divide-by-zero at an extreme (mis-configured) price
        uint256 sherwoodTokens = Math.min(tokenPool, Math.mulDiv(sherwoodWeth, 1e18, quote));
        uint256 ambushForBond = tokenPool - sherwoodTokens;

        address b = ICurveBondDeployer(bondDeployer).deploy(address(token), WETH, address(v3Factory), platform, address(this));
        bond = b;
        IERC20(WETH).safeTransfer(b, raisedWeth);
        IERC20(token).safeTransfer(b, tokenPool); // = sherwoodTokens + ambushForBond
        ICurveBond(b).post(sherwoodWeth, sherwoodTokens, bountyWeth, ambushForBond);

        // sweep any WETH dust
        uint256 wethDust = IERC20(WETH).balanceOf(address(this));
        if (wethDust > 0) IERC20(WETH).safeTransfer(platform, wethDust);

        emit Graduated(b, raisedWeth, leftToken);
    }

    function _mint(int24 lo, int24 hi, uint128 L) internal {
        _minting = true;
        pool.mint(address(this), lo, hi, L, "");
        _minting = false;
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external override {
        if (msg.sender != address(pool)) revert NotPool();
        require(_minting, "no mint");
        if (amount0Owed > 0) IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransfer(msg.sender, amount1Owed);
    }
}
