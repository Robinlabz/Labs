// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {LaunchTokenDeployer, CurvePoolDeployer} from "./deployers/CurveDeployers.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

interface ICurvePool {
    function pool() external view returns (address);
    function seed() external;
}

interface IPadRouter {
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
    ) external;
}

/// @title CurvePadFactory — DEX-day-one launchpad (the NOXA-style model, plus the Bond)
/// @notice One `launch()` call: deploys a clean anti-snipe token, creates a REAL Uniswap v3 pool, seeds the
/// token as a single-sided "curve" position, enables trading, and (optionally) executes the creator's own
/// **dev buy** of up to 2% in the same transaction — before anyone else can trade — so the dev is never
/// sniped on their own coin. Token is on Uniswap + DexScreener from block one. Free to launch; the platform
/// funds nothing (the token seeds its own liquidity); the dev buy is optional and paid by the dev.
contract CurvePadFactory is Ownable2Step, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    uint16 public constant AMBUSH_BPS = 2500; // 25% -> the Bond's Ambush; 75% is the curve
    uint24 public constant POOL_FEE = 10000;
    uint16 public constant MAX_DEVBUY_BPS = 200; // dev buy capped at 2% of supply
    int24 public constant DEVBUY_SPAN = 600; // price-limit span (~6%) so a dev buy can't run the curve far

    address public immutable WETH;
    address public immutable v3Factory;
    address public immutable router; // PadRouter — the swap desk + project tax
    LaunchTokenDeployer public immutable tokenDeployer;
    CurvePoolDeployer public immutable curveDeployer;
    address public immutable bondDeployer;

    address public platform;
    bool private _swapping; // guards the swap callback (WETH is only ever transient, mid-launch)
    address private _activePool; // the pool we're mid-swap with (callback authenticity check)

    // ---- fixed terms ----
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;
    // Curve geometry is set at deploy so we can run a cheap TEST factory (small width -> graduates after a
    // few $ of buys) next to the real PRODUCTION factory, sharing the same audited code + router.
    int24 public immutable START_TICK_MAG; // e.g. 201600 -> ~$4k start FDV; sign set by ordering
    int24 public immutable CURVE_WIDTH; // span to the curve CEILING (buys can climb here, never past)
    int24 public immutable MIN_GRAD_WIDTH; // span to the MINIMUM graduation price (< CURVE_WIDTH); "let it ride" above

    /// @notice A project's self-chosen tax. Both rates are hard-capped at 4% by the router; the platform
    /// always takes 25% of whatever is collected. The three allocation splits are of the PROJECT'S 75% share
    /// and must sum to 100% (10000 bps): to the project wallet, to deepening the Bond floor, and to auto-burn.
    struct TaxParams {
        uint16 buyBps; // ≤ 400
        uint16 sellBps; // ≤ 400
        uint16 walletBps; // project-share split \_
        uint16 floorBps; //                       > sum to 10000
        uint16 burnBps; //                      _/
        address projectWallet; // 0 => the dev
    }

    struct LaunchParams {
        string name;
        string symbol;
        address dev;
        TaxParams tax;
    }

    struct Record {
        address token;
        address curve;
        address dev;
        uint256 at;
    }

    mapping(address => Record) public recordOf;
    address[] public allTokens;

    error BadValue();

    event Launched(address indexed token, address indexed curve, address indexed pool, address dev, uint256 devBought);
    event PlatformChanged(address platform);

    constructor(
        address weth_,
        address v3Factory_,
        address platform_,
        address owner_,
        address router_,
        address tokenDeployer_,
        address curveDeployer_,
        address bondDeployer_,
        int24 startTickMag_,
        int24 curveWidth_,
        int24 minGradWidth_
    ) Ownable(owner_) {
        require(
            weth_ != address(0) && v3Factory_ != address(0) && platform_ != address(0) && router_ != address(0)
                && tokenDeployer_ != address(0) && curveDeployer_ != address(0) && bondDeployer_ != address(0),
            "zero"
        );
        require(
            startTickMag_ > 0 && curveWidth_ > 0 && startTickMag_ % 200 == 0 && curveWidth_ % 200 == 0
                && minGradWidth_ > 0 && minGradWidth_ % 200 == 0 && minGradWidth_ < curveWidth_,
            "curve"
        );
        WETH = weth_;
        v3Factory = v3Factory_;
        platform = platform_;
        router = router_;
        tokenDeployer = LaunchTokenDeployer(tokenDeployer_);
        curveDeployer = CurvePoolDeployer(curveDeployer_);
        bondDeployer = bondDeployer_;
        START_TICK_MAG = startTickMag_;
        CURVE_WIDTH = curveWidth_;
        MIN_GRAD_WIDTH = minGradWidth_;
    }

    receive() external payable {} // for WETH.withdraw refunds during a dev buy

    /// @notice One tx: token + real pool + seeded curve + trading on. Send ETH to also make the dev's first
    /// buy (≤2%) in the same tx, before trading opens to anyone else. DEX + DexScreener day one.
    function launch(LaunchParams calldata p) external payable returns (address token, address curve, address pool) {
        if (p.dev == address(0)) revert BadValue();

        uint256 ambushAmt = (TOTAL_SUPPLY * AMBUSH_BPS) / 10_000;
        uint256 curveAmt = TOTAL_SUPPLY - ambushAmt;

        LaunchToken.GuardConfig memory g = LaunchToken.GuardConfig({
            deadSecs: 2,
            phase1Secs: 60,
            antiSnipeSecs: 300,
            maxTxBps1: 50,
            maxWalletBps1: 100,
            maxTxBps2: 100,
            maxWalletBps2: 200,
            cooldownSecs: 2
        });
        // CREATE2 salt with per-launch entropy (incl. block.number) so the token — and thus its Uniswap pool
        // address — can't be predicted from the deployer's nonce. An attacker who precreates+initializes the
        // pool to brick a launch would have to win the race for THIS exact block; a retry lands a fresh
        // address, so the DoS can't be made permanent.
        bytes32 salt = keccak256(
            abi.encodePacked(address(this), p.dev, p.name, p.symbol, block.number, block.timestamp, allTokens.length)
        );
        token = tokenDeployer.deploy(p.name, p.symbol, TOTAL_SUPPLY, address(this), g, salt);

        int24 startTick = token < WETH ? -START_TICK_MAG : START_TICK_MAG;
        curve = curveDeployer.deploy(
            token, WETH, v3Factory, platform, p.dev, bondDeployer, curveAmt, ambushAmt, startTick, CURVE_WIDTH, MIN_GRAD_WIDTH
        );
        pool = ICurvePool(curve).pool();

        IERC20(token).safeTransfer(curve, TOTAL_SUPPLY);
        LaunchToken(token).enableTrading(pool, curve, uint64(block.timestamp));
        ICurvePool(curve).seed();

        // register the project's tax with the swap desk (router enforces the 4% caps + 100% allocation)
        address projWallet = p.tax.projectWallet == address(0) ? p.dev : p.tax.projectWallet;
        IPadRouter(router).register(
            token, pool, curve, projWallet, p.tax.buyBps, p.tax.sellBps, p.tax.walletBps, p.tax.floorBps, p.tax.burnBps
        );

        // optional dev buy (≤2%), atomic and ahead of the field
        uint256 devBought;
        if (msg.value > 0) devBought = _devBuy(token, pool, startTick, p.dev);

        recordOf[token] = Record(token, curve, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, curve, pool, p.dev, devBought);
    }

    function _devBuy(address token, address pool, int24 startTick, address dev) internal returns (uint256 bought) {
        bool tokenIsToken0 = token < WETH;
        bool zeroForOne = !tokenIsToken0; // buying the token: WETH-in. WETH is token0 iff !tokenIsToken0.
        // cap the price move to ~2% into the curve so a big dev buy can't run the whole thing (excess refunded)
        int24 capTick = tokenIsToken0 ? startTick + DEVBUY_SPAN : startTick - DEVBUY_SPAN;
        uint160 sqrtLimit = PoolMath.getSqrtRatioAtTick(capTick);

        IWETH9(WETH).deposit{value: msg.value}();
        _swapping = true;
        _activePool = pool;
        IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(msg.value), sqrtLimit, "");
        _activePool = address(0);
        _swapping = false;

        // deliver bought tokens to the dev; enforce the 2% cap; refund any unused ETH
        bought = IERC20(token).balanceOf(address(this));
        require(bought <= (TOTAL_SUPPLY * MAX_DEVBUY_BPS) / 10_000, "dev>2%");
        if (bought > 0) IERC20(token).safeTransfer(dev, bought);
        uint256 leftWeth = IERC20(WETH).balanceOf(address(this));
        if (leftWeth > 0) {
            IWETH9(WETH).withdraw(leftWeth);
            (bool ok,) = dev.call{value: leftWeth}("");
            require(ok, "refund");
        }
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external override {
        require(_swapping && msg.sender == _activePool, "no swap");
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(WETH).safeTransfer(msg.sender, owed); // msg.sender is the pool mid-swap
    }

    function setPlatform(address p_) external onlyOwner {
        require(p_ != address(0), "zero");
        platform = p_;
        emit PlatformChanged(p_);
    }

    /// @notice Owner-only pass-through so the platform can seed a coin's buy-side sniper blocklist during its
    /// anti-snipe window (the token only accepts seedBlocklist from its factory). It is add-only and the token
    /// auto-freezes it when the window ends, so it can never be used to block a normal holder's sell.
    function seedBlocklist(address token, address[] calldata bots) external onlyOwner {
        LaunchToken(token).seedBlocklist(bots);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
