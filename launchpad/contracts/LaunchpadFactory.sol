// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3MintCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";
import {LaunchToken} from "./LaunchToken.sol";
import {MilestoneVault} from "./MilestoneVault.sol";
import {LiquidityLocker} from "./LiquidityLocker.sol";
import {TokenDeployer} from "./deployers/TokenDeployer.sol";
import {VaultDeployer} from "./deployers/VaultDeployer.sol";

/// @title LaunchpadFactory
/// @notice Launchpad-for-many on Robinhood Chain. `launch()` atomically deploys a clean token, stands up
/// and seeds a Uniswap v3 pool, permanently locks the LP, funds a rule-bound 30% MilestoneVault, arms the
/// TWAP oracle, and enables trading — with no window a sniper can exploit. Depends on the verified v3
/// factory + pool only (no periphery). The 1% platform fee lives in the separate FeeRouter.
contract LaunchpadFactory is IUniswapV3MintCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint24 public constant POOL_FEE = 10000;
    uint16 public constant TREASURY_BPS = 3000; // 30% to the vault
    // Minimum TWAP observation slots to arm at launch. Must be sized to hold ~30 min of history at the
    // chain's block time (confirm block time before mainnet); a too-small buffer degrades the milestone
    // TWAP toward spot. This is a floor against obviously-broken launches, not a substitute for sizing.
    uint16 public constant MIN_CARDINALITY = 100;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    address public immutable WETH;
    IUniswapV3Factory public immutable v3Factory;
    LiquidityLocker public immutable locker;
    TokenDeployer public immutable tokenDeployer;
    VaultDeployer public immutable vaultDeployer;

    uint256 public launchFeeWei; // optional flat launch fee, owner-set, to feeRecipient
    address public feeRecipient;

    struct LaunchRecord {
        address token;
        address pool;
        address vault;
        address dev;
        uint256 launchedAt;
    }

    mapping(address => LaunchRecord) public recordOf; // token => record
    address[] public allTokens;

    struct LaunchParams {
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 seedEth;
        address dev;
        uint16[] multiplesX100;
        uint256[] tranches;
        uint16 cardinalityNext;
        uint32 twapWindow;
        bytes32 salt;
        LaunchToken.GuardConfig guard;
    }

    error BadValue();
    error PoolExists();
    error PriceMismatch();
    error NotAuthedPool();

    event Launched(
        address indexed token,
        address indexed pool,
        address indexed vault,
        address dev,
        uint256 totalSupply,
        uint256 seedEth,
        uint160 sqrtPriceX96,
        int24 launchTick
    );
    event LaunchFeeChanged(uint256 wei_);
    event FeeRecipientChanged(address recipient);

    constructor(
        address weth_,
        address v3Factory_,
        address feeRecipient_,
        address owner_,
        address tokenDeployer_,
        address vaultDeployer_
    ) Ownable(owner_) {
        require(
            weth_ != address(0) && v3Factory_ != address(0) && feeRecipient_ != address(0)
                && tokenDeployer_ != address(0) && vaultDeployer_ != address(0),
            "zero addr"
        );
        WETH = weth_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        feeRecipient = feeRecipient_;
        tokenDeployer = TokenDeployer(tokenDeployer_);
        vaultDeployer = VaultDeployer(vaultDeployer_);
        locker = new LiquidityLocker(address(this));
        // sanity: the 1% tier must be enabled on this factory
        require(v3Factory.feeAmountTickSpacing(POOL_FEE) == 200, "fee tier off");
    }

    /// @notice Atomically launch a token. `msg.value` = seedEth (LP WETH side) + launchFeeWei.
    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address token, address pool, address vault)
    {
        if (p.seedEth == 0 || p.totalSupply == 0 || p.dev == address(0)) revert BadValue();
        if (p.cardinalityNext < MIN_CARDINALITY) revert BadValue();
        if (msg.value != p.seedEth + launchFeeWei) revert BadValue();

        uint256 treasury = (p.totalSupply * TREASURY_BPS) / 10_000;
        uint256 lpAmount = p.totalSupply - treasury;
        require(treasury > 0 && lpAmount > 0, "supply too small");

        // 1) deploy token (supply minted to this factory). Secret-salted CREATE2 => address unknown ahead.
        bytes32 salt = keccak256(abi.encodePacked(msg.sender, p.salt, allTokens.length));
        token = tokenDeployer.deploy(salt, p.name, p.symbol, p.totalSupply, address(this), p.guard);
        LaunchToken t = LaunchToken(token);
        if (v3Factory.getPool(token, WETH, POOL_FEE) != address(0)) revert PoolExists();

        // 2) order + price from the actual deposit ratio
        (address token0, address token1, uint256 amt0, uint256 amt1) = _order(token, lpAmount, p.seedEth);
        uint160 sqrtPriceX96 = PoolMath.sqrtPriceX96FromAmounts(amt0, amt1);

        // 3) create + initialize + prove we set the price
        pool = v3Factory.createPool(token, WETH, POOL_FEE);
        IUniswapV3Pool(pool).initialize(sqrtPriceX96);
        (uint160 got, int24 launchTick,,,,,) = IUniswapV3Pool(pool).slot0();
        if (got != sqrtPriceX96) revert PriceMismatch();

        // 4) arm the TWAP oracle for the vault
        IUniswapV3Pool(pool).increaseObservationCardinalityNext(p.cardinalityNext);

        // 5) wrap the seed ETH
        IWETH9(WETH).deposit{value: p.seedEth}();

        // 6) deploy + fund + configure the vault
        vault = vaultDeployer.deploy(address(this), token, WETH, pool, p.dev);
        IERC20(token).safeTransfer(vault, treasury);
        bool tokenIsToken0 = token < WETH;
        uint256 launchPrice = PoolMath.quoteWethPerToken(sqrtPriceX96, tokenIsToken0);
        MilestoneVault(vault).initialize(launchTick, launchPrice, p.twapWindow, p.multiplesX100, p.tranches);

        // 7) mint the full-range LP straight to the locker (permanently locked), factory pays via callback
        uint128 L = PoolMath.fullRangeLiquidity(sqrtPriceX96, amt0, amt1);
        IUniswapV3Pool(pool).mint(address(locker), PoolMath.MIN_TICK, PoolMath.MAX_TICK, L, abi.encode(token0, token1));
        locker.register(pool, p.dev);

        // 8) sweep dust: leftover token -> burn, leftover WETH -> dev
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) IERC20(token).safeTransfer(BURN, tokenDust);
        uint256 wethDust = IERC20(WETH).balanceOf(address(this));
        if (wethDust > 0) IERC20(WETH).safeTransfer(p.dev, wethDust);

        // 9) enable trading (arms the anti-snipe window)
        t.enableTrading(pool, vault, uint64(block.timestamp));

        // 10) launch fee
        if (launchFeeWei > 0) {
            (bool ok,) = feeRecipient.call{value: launchFeeWei}("");
            require(ok, "fee xfer");
        }

        recordOf[token] = LaunchRecord(token, pool, vault, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, pool, vault, p.dev, p.totalSupply, p.seedEth, sqrtPriceX96, launchTick);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external override {
        (address token0, address token1) = abi.decode(data, (address, address));
        // Only the canonical pool for these tokens may pull payment.
        if (msg.sender != v3Factory.getPool(token0, token1, POOL_FEE)) revert NotAuthedPool();
        if (amount0Owed > 0) IERC20(token0).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(token1).safeTransfer(msg.sender, amount1Owed);
    }

    function _order(address token, uint256 lpAmount, uint256 seedEth)
        internal
        view
        returns (address token0, address token1, uint256 amt0, uint256 amt1)
    {
        if (token < WETH) {
            (token0, token1, amt0, amt1) = (token, WETH, lpAmount, seedEth);
        } else {
            (token0, token1, amt0, amt1) = (WETH, token, seedEth, lpAmount);
        }
    }

    // ----- admin -----
    function setLaunchFee(uint256 wei_) external onlyOwner {
        launchFeeWei = wei_;
        emit LaunchFeeChanged(wei_);
    }

    function setFeeRecipient(address r) external onlyOwner {
        require(r != address(0), "zero");
        feeRecipient = r;
        emit FeeRecipientChanged(r);
    }

    /// @notice Seed a launched token's buy-side anti-snipe blocklist with known bot addresses. Only
    /// callable by the platform operator, and only works while that token's anti-snipe window is open
    /// (the token itself reverts after the window). It can never block a holder's sell.
    function blocklistBots(address token, address[] calldata bots) external onlyOwner {
        require(recordOf[token].token != address(0), "unknown token");
        LaunchToken(token).seedBlocklist(bots);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
