// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface IBondDeployer {
    function deploy(address token, address weth, address v3Factory, address platform, address curve)
        external
        returns (address);
}

interface IBond {
    function post(uint256 sherwoodWeth, uint256 sherwoodTokens, uint256 bountyWeth, uint256 ambushTokens) external;
}

/// @title BondingCurve
/// @notice A simple constant-product (x*y=k) bonding curve with virtual reserves, like ape.store /
/// pump.fun. Buyers trade ETH<->token on the curve for price discovery; when real ETH raised reaches
/// GRAD_TARGET the curve **graduates**: it seeds a Uniswap v3 pool at the curve's final price with the
/// unsold tokens + all raised ETH, permanently locks the LP, and disables curve trading forever.
///
/// Invariants (proven + brute-forced in sim/curve-sim.mjs):
///   INV-J:   reserveEth <= ceilDiv(K, reserveToken) after every op (buy floors, sell ceils). This is the
///            load-bearing property: it makes round-trip/sequence profit impossible and keeps the curve
///            solvent (reserveEth >= VIRT_ETH always).
///   INV-BAL: address(this).balance == raised() + platformBuffer + devSellReserve. The curve can only ever
///            pay out ETH it actually took in; graduation deposits exactly raised() into the LP.
///   INV-GRAD: graduation happens at most once, only when raised >= GRAD_TARGET, seeds the pool at the
///            curve's EXACT final price (continuous), burns the unsold remainder, and locks the LP.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    // Fees: BUY 1% -> platform (streamed live, minus a 0.1% buffer swept to platform at graduation).
    //       SELL 1% -> the project dev, who can burn-and-collect it. LP swap fees -> platform.
    uint16 public constant BUY_FEE_BPS = 100; // 1% on buys
    uint16 public constant BUY_BUFFER_BPS = 10; // 0.1% of a buy kept in-curve as a buffer, sent to platform at grad
    uint16 public constant SELL_FEE_BPS = 100; // 1% on sells -> project dev
    uint16 public constant CARDINALITY = 200; // TWAP observation slots armed at graduation (for the Bond)
    uint16 public constant SHERWOOD_WETH_BPS = 6000; // 60% of the raise seeds the Sherwood LP; 40% seeds the Bounty floor

    // immutables
    IERC20 public immutable token;
    address public immutable WETH;
    IUniswapV3Factory public immutable v3Factory;
    address public immutable bondDeployer; // deploys the per-launch Bond at graduation
    uint256 public immutable ambushSupply; // tokens (held by this curve) handed to the Bond's Ambush at grad
    address public immutable platform; // buy fee + LP (Sherwood) fee recipient
    address public immutable dev; // project dev — receives sell fees (burn or collect)

    uint256 public immutable VIRT_ETH; // virtual ETH reserve (sets the starting price)
    uint256 public immutable CURVE_SUPPLY; // tokens for sale on the curve (must be funded to this contract)
    uint256 public immutable K; // = VIRT_ETH * CURVE_SUPPLY (constant product)
    uint256 public immutable GRAD_TARGET; // real ETH (net of fees) that triggers graduation
    uint160 public immutable gradSqrtPriceX96; // pool price committed + initialized at launch

    // anti-snipe (first window: cap the net ETH per buy; auto-expires)
    uint64 public immutable startTime;
    uint32 public immutable antiSnipeSecs;
    uint256 public immutable maxBuyWei;

    // state
    uint256 public reserveEth; // virtual + real
    uint256 public reserveToken; // tokens still in the curve
    uint256 public platformBuffer; // accrued 0.1% buy buffer, swept to platform at graduation
    uint256 public devSellReserve; // accrued 1% sell fees, for the project dev to burn or collect
    bool public graduated;
    address public pool;
    address public bond; // the Bond posted at graduation (Sherwood + Bounty + Ambush)

    error AlreadyGraduated();
    error NotGraduated();
    error SnipeCap();
    error Slippage();
    error NothingOut();
    error NotPool();
    error TargetNotReached();
    error NotDev();
    error BadAmount();

    event Buy(address indexed buyer, uint256 ethIn, uint256 fee, uint256 tokensOut, uint256 reserveEth, uint256 reserveToken);
    event Sell(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee, uint256 reserveEth, uint256 reserveToken);
    event Graduated(address indexed pool, uint256 ethToLp, uint256 tokensToLp, uint160 sqrtPriceX96);
    event DevCollect(uint256 amount);
    event DevBurn(uint256 ethSpent, uint256 tokensBurned);

    constructor(
        address token_,
        address weth_,
        address v3Factory_,
        address platform_,
        address dev_,
        uint256 virtEth_,
        uint256 curveSupply_,
        uint256 gradTarget_,
        uint32 antiSnipeSecs_,
        uint256 maxBuyWei_,
        address bondDeployer_,
        uint256 ambushSupply_
    ) {
        require(
            token_ != address(0) && weth_ != address(0) && v3Factory_ != address(0)
                && platform_ != address(0) && dev_ != address(0) && bondDeployer_ != address(0),
            "zero addr"
        );
        require(virtEth_ > 0 && curveSupply_ > 0 && gradTarget_ > 0, "params");
        // graduation LP must be a meaningful fraction of the raise (bounds any rounding edge); the
        // continuous-price seeding already removes the step, this just rejects degenerate configs.
        require(gradTarget_ >= virtEth_, "grad<virt");
        token = IERC20(token_);
        WETH = weth_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        bondDeployer = bondDeployer_;
        ambushSupply = ambushSupply_;
        platform = platform_;
        dev = dev_;
        VIRT_ETH = virtEth_;
        CURVE_SUPPLY = curveSupply_;
        K = virtEth_ * curveSupply_; // reverts on overflow (checked)
        GRAD_TARGET = gradTarget_;
        antiSnipeSecs = antiSnipeSecs_;
        maxBuyWei = maxBuyWei_;
        startTime = uint64(block.timestamp);

        reserveEth = virtEth_;
        reserveToken = curveSupply_;

        // Claim + initialize the Uniswap pool NOW, at the deterministic graduation price (the price when
        // raised == GRAD_TARGET). This closes the pre-initialization DoS: since we own+price the pool from
        // launch, no third party can initialize it off-price during the bonding phase to brick graduation.
        // (Deploy token+curve atomically — as CurveLaunchFactory does — so there's no gap before this runs.)
        uint256 gradRE = virtEth_ + gradTarget_;
        uint256 gradRT = K / gradRE;
        (uint256 ga0, uint256 ga1) = token_ < weth_ ? (gradRT, gradRE) : (gradRE, gradRT);
        uint160 sp = PoolMath.sqrtPriceX96FromAmounts(ga0, ga1);
        gradSqrtPriceX96 = sp;
        address p = IUniswapV3Factory(v3Factory_).getPool(token_, weth_, POOL_FEE);
        if (p == address(0)) p = IUniswapV3Factory(v3Factory_).createPool(token_, weth_, POOL_FEE);
        IUniswapV3Pool(p).initialize(sp);
        pool = p;
    }

    /// @notice Real ETH raised so far (net of fees) = what's held for graduation.
    function raised() public view returns (uint256) {
        return reserveEth - VIRT_ETH;
    }

    /// @notice Current spot price, ETH-wei per 1e18 token (1e18-scaled). Never reverts. For display/UX.
    function spotPriceE18() public view returns (uint256) {
        return Math.mulDiv(reserveEth, 1e18, reserveToken);
    }

    /// @notice Progress toward graduation, in basis points (0..10000).
    function gradProgressBps() external view returns (uint256) {
        uint256 r = raised();
        return r >= GRAD_TARGET ? 10_000 : (r * 10_000) / GRAD_TARGET;
    }

    // --------------------------------------------------------------- buy
    /// @notice Buy tokens with ETH along the curve. 1% buy fee: 0.9% streamed to the platform wallet in
    /// real time, 0.1% held in-curve as a buffer and swept to the platform at graduation.
    function buy(uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        if (graduated) revert AlreadyGraduated();
        uint256 fee = (msg.value * BUY_FEE_BPS) / 10_000;
        uint256 netEth = msg.value - fee;
        if (netEth == 0) revert NothingOut();
        if (block.timestamp < uint256(startTime) + antiSnipeSecs && netEth > maxBuyWei) revert SnipeCap();

        // Cap the graduating buy so `raised()` lands EXACTLY on GRAD_TARGET and refund the excess (keeps
        // graduation at the price the pool was initialized to at launch — price-continuous).
        uint256 refundEth;
        {
            uint256 room = GRAD_TARGET - raised(); // > 0 (not graduated)
            if (netEth > room) {
                uint256 acceptGross = Math.ceilDiv(room * 10_000, 10_000 - BUY_FEE_BPS);
                if (acceptGross > msg.value) acceptGross = msg.value;
                refundEth = msg.value - acceptGross;
                fee = acceptGross - room;
                netEth = room;
            }
        }

        // constant product: new token reserve = K / new eth reserve
        uint256 newReserveEth = reserveEth + netEth;
        // buy rounding is generous by <1 token-wei; safety comes from the sell-side ceilDiv + the
        // fees (invariant: reserveEth <= ceilDiv(K, reserveToken)), NOT from dust staying in the curve.
        uint256 newReserveToken = K / newReserveEth;
        tokensOut = reserveToken - newReserveToken;
        if (tokensOut < minTokensOut) revert Slippage();
        if (tokensOut == 0) revert NothingOut();

        reserveEth = newReserveEth;
        reserveToken = newReserveToken;

        // split the buy fee: 0.1% buffer stays, the rest streams to the platform wallet now
        uint256 buffer = (fee * BUY_BUFFER_BPS) / BUY_FEE_BPS; // 0.1% of the buy (= 10% of the fee)
        platformBuffer += buffer;
        uint256 stream = fee - buffer;

        token.safeTransfer(msg.sender, tokensOut);
        if (stream > 0) _sendEth(platform, stream); // real-time to the platform wallet (a fixed EOA)
        if (refundEth > 0) _sendEth(msg.sender, refundEth);
        emit Buy(msg.sender, msg.value - refundEth, fee, tokensOut, reserveEth, reserveToken);

        if (raised() >= GRAD_TARGET) _graduate();
    }

    // --------------------------------------------------------------- sell
    /// @notice Sell tokens back to the curve for ETH. 1% fee accrues to the project dev (burn or collect).
    function sell(uint256 tokensIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        if (graduated) revert AlreadyGraduated();
        require(tokensIn > 0, "zero");
        // never let outstanding tokens on the curve exceed what was funded (solvency depends on it;
        // also rejects sells backed by any supply beyond CURVE_SUPPLY, e.g. a mis-funded/rebasing token)
        require(reserveToken + tokensIn <= CURVE_SUPPLY, "oversell");
        token.safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 newReserveToken = reserveToken + tokensIn;
        uint256 newReserveEth = Math.ceilDiv(K, newReserveToken); // ceil -> curve keeps dust (pays out less)
        uint256 grossOut = reserveEth - newReserveEth;
        if (grossOut == 0) revert NothingOut(); // sub-threshold sell would burn tokens for 0 ETH
        reserveToken = newReserveToken;
        reserveEth = newReserveEth;

        uint256 fee = (grossOut * SELL_FEE_BPS) / 10_000;
        ethOut = grossOut - fee;
        if (ethOut < minEthOut) revert Slippage();
        devSellReserve += fee; // accrues to the project dev — burn or collect

        _sendEth(msg.sender, ethOut);
        emit Sell(msg.sender, tokensIn, ethOut, fee, reserveEth, reserveToken);
    }

    // --------------------------------------------------------------- project dev: sell fees (burn or collect)
    /// @notice The project dev withdraws accrued sell fees as ETH.
    function devCollect(uint256 amount) external nonReentrant {
        if (msg.sender != dev) revert NotDev();
        if (amount == 0 || amount > devSellReserve) revert BadAmount();
        devSellReserve -= amount;
        _sendEth(dev, amount);
        emit DevCollect(amount);
    }

    /// @notice The project dev spends accrued sell fees to buy tokens on the curve and burn them
    /// (deflationary + adds ETH toward graduation). Pre-graduation only; afterwards use devCollect.
    function devBurn(uint256 amount, uint256 minTokensOut) external nonReentrant returns (uint256 burned) {
        if (msg.sender != dev) revert NotDev();
        if (graduated) revert AlreadyGraduated();
        if (amount == 0 || amount > devSellReserve) revert BadAmount();

        uint256 room = GRAD_TARGET - raised();
        uint256 spend = amount > room ? room : amount; // don't overshoot graduation
        devSellReserve -= spend;

        uint256 newReserveEth = reserveEth + spend;
        uint256 newReserveToken = K / newReserveEth;
        burned = reserveToken - newReserveToken;
        if (burned < minTokensOut) revert Slippage();
        reserveEth = newReserveEth;
        reserveToken = newReserveToken;

        token.safeTransfer(0x000000000000000000000000000000000000dEaD, burned);
        emit DevBurn(spend, burned);

        if (raised() >= GRAD_TARGET) _graduate();
    }

    // --------------------------------------------------------------- graduation
    /// @notice Force-check graduation (also runs automatically at the end of a qualifying buy).
    function graduate() external nonReentrant {
        if (graduated) revert AlreadyGraduated();
        if (raised() < GRAD_TARGET) revert TargetNotReached();
        _graduate();
    }

    function _graduate() internal {
        graduated = true;
        uint256 ethToLp = raised(); // real ETH raised (accrued fees stay claimable, not deposited)
        require(ethToLp > 0, "empty grad");

        // The pool is ours from launch, so it must still be at gradSqrtPriceX96. Requiring this refuses to
        // seed into a pool whose price a griefer moved (they'd need real liquidity + a swap — costly, no
        // profit, defeated by a private mempool); reverting graduation is safe (no theft, ETH exitable).
        address p = pool;
        (uint160 existing,,,,,,) = IUniswapV3Pool(p).slot0();
        require(existing == gradSqrtPriceX96, "pool price moved");
        IUniswapV3Pool(p).increaseObservationCardinalityNext(CARDINALITY); // arm the TWAP for the Bond's poke guard

        // Split the raise: SHERWOOD_WETH_BPS seeds the Sherwood LP, the rest seeds the Bounty floor.
        uint256 sherwoodWeth = (ethToLp * SHERWOOD_WETH_BPS) / 10_000;
        uint256 bountyWeth = ethToLp - sherwoodWeth;

        // Sherwood tokens: pair `sherwoodWeth` at the committed graduation price; burn the unsold curve remainder
        // (NOT the ambush reserve, which is handed to the Bond's Ambush).
        uint256 quote = PoolMath.quoteWethPerToken(gradSqrtPriceX96, address(token) < WETH); // WETH-wei per 1e18 token
        require(quote > 0, "bad price");
        uint256 sherwoodTokens = Math.min(reserveToken, Math.mulDiv(sherwoodWeth, 1e18, quote));
        require(sherwoodTokens > 0, "empty grad");
        uint256 burnTokens = reserveToken - sherwoodTokens;
        if (burnTokens > 0) token.safeTransfer(0x000000000000000000000000000000000000dEaD, burnTokens);

        // Deploy the Bond, fund it (all raised ETH as WETH + Sherwood tokens + the Ambush reserve), and post.
        IWETH9(WETH).deposit{value: ethToLp}();
        address b = IBondDeployer(bondDeployer).deploy(address(token), WETH, address(v3Factory), platform, address(this));
        bond = b;
        IERC20(WETH).safeTransfer(b, ethToLp);
        IERC20(token).safeTransfer(b, sherwoodTokens + ambushSupply);
        IBond(b).post(sherwoodWeth, sherwoodTokens, bountyWeth, ambushSupply);

        // sweep the accrued buy-fee buffer to the platform (the devSellReserve stays for the dev)
        uint256 buf = platformBuffer;
        platformBuffer = 0;
        if (buf > 0) _sendEth(platform, buf);

        // sweep any token/WETH dust left by rounding
        uint256 tokDust = token.balanceOf(address(this));
        if (tokDust > 0) token.safeTransfer(0x000000000000000000000000000000000000dEaD, tokDust);
        uint256 wethDust = IERC20(WETH).balanceOf(address(this));
        if (wethDust > 0) IERC20(WETH).safeTransfer(platform, wethDust);

        emit Graduated(p, ethToLp, sherwoodTokens, gradSqrtPriceX96);
    }

    // --------------------------------------------------------------- helpers
    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "eth send");
    }
}
