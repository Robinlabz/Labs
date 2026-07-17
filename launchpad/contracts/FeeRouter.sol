// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IUniswapV3Factory, IUniswapV3Pool, IUniswapV3SwapCallback, IWETH9} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title FeeRouter
/// @notice The ONLY place the 1% platform fee exists. The UI routes every swap through here; the fee
/// is skimmed on the WETH leg (never the token), so the launched ERC20 stays tax-free and v3 swaps
/// never break. Swaps go directly to pool.swap() with a callback that validates the caller is the
/// canonical pool (via factory.getPool) — the defense against fake-pool drains. FEE_BPS is immutable
/// and capped at MAX_FEE_BPS: there is no setFee(), the operator can never raise it.
contract FeeRouter is IUniswapV3SwapCallback, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_FEE_BPS = 100;
    uint16 public constant FEE_BPS = 100; // 1%, compile-time constant, <= MAX_FEE_BPS
    uint24 public constant POOL_FEE = 10000;

    address public immutable WETH;
    IUniswapV3Factory public immutable v3Factory;

    address public feeRecipient; // timelock/multisig; change is owner-gated
    uint256 public feesAccrued; // WETH held for the platform
    mapping(address => uint256) public pendingEth; // pull-over-push for failed native sends

    error PoolNotFound();
    error Expired();
    error Slippage();
    error NotPool();
    error ZeroValue();

    event FeeCollected(address indexed token, bool isBuy, address indexed user, uint256 wethNotional, uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event FeeRecipientChanged(address indexed recipient);

    constructor(address weth_, address v3Factory_, address feeRecipient_, address owner_) Ownable(owner_) {
        require(weth_ != address(0) && v3Factory_ != address(0) && feeRecipient_ != address(0), "zero addr");
        WETH = weth_;
        v3Factory = IUniswapV3Factory(v3Factory_);
        feeRecipient = feeRecipient_;
    }

    receive() external payable {
        require(msg.sender == WETH, "direct ETH"); // only WETH.withdraw refunds land here
    }

    // ----------------------------------------------------------------- buy (ETH -> token)

    /// @notice Buy `token` with ETH. Skims 1% of the ETH as a WETH fee, swaps the rest.
    function buyExactInETH(address token, uint256 amountOutMin, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 tokenOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroValue();

        address pool = v3Factory.getPool(token, WETH, POOL_FEE);
        if (pool == address(0)) revert PoolNotFound();

        IWETH9(WETH).deposit{value: msg.value}();
        uint256 fee = (msg.value * FEE_BPS) / 10_000;
        uint256 swapIn = msg.value - fee;
        feesAccrued += fee;

        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        bool zeroForOne = (WETH == t0); // paying WETH, receiving token
        uint160 limit =
            zeroForOne ? uint160(PoolMath.MIN_SQRT_RATIO + 1) : uint160(PoolMath.MAX_SQRT_RATIO - 1);

        (int256 a0, int256 a1) =
            IUniswapV3Pool(pool).swap(msg.sender, zeroForOne, int256(swapIn), limit, abi.encode(t0, t1));
        tokenOut = zeroForOne ? uint256(-a1) : uint256(-a0);
        if (tokenOut < amountOutMin) revert Slippage();

        // refund WETH the swap didn't consume (only possible on a partial fill at the price limit),
        // so it isn't silently stranded in the router
        uint256 wethSpent = zeroForOne ? uint256(a0) : uint256(a1);
        if (wethSpent < swapIn) IERC20(WETH).safeTransfer(msg.sender, swapIn - wethSpent);

        emit FeeCollected(token, true, msg.sender, msg.value, fee);
    }

    // ----------------------------------------------------------------- sell (token -> ETH/WETH)

    /// @notice Sell `token` for WETH (or ETH). Skims 1% of the WETH output; slippage is checked on the
    /// NET amount the user actually receives.
    function sellExactIn(
        address token,
        uint256 amountIn,
        uint256 amountOutMinNet,
        uint256 deadline,
        bool unwrapToETH
    ) external nonReentrant returns (uint256 netWeth) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroValue();

        address pool = v3Factory.getPool(token, WETH, POOL_FEE);
        if (pool == address(0)) revert PoolNotFound();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);

        address t0 = IUniswapV3Pool(pool).token0();
        address t1 = IUniswapV3Pool(pool).token1();
        bool zeroForOne = (token == t0); // paying token, receiving WETH
        uint160 limit =
            zeroForOne ? uint160(PoolMath.MIN_SQRT_RATIO + 1) : uint160(PoolMath.MAX_SQRT_RATIO - 1);

        uint256 before = IERC20(WETH).balanceOf(address(this));
        IUniswapV3Pool(pool).swap(address(this), zeroForOne, int256(amountIn), limit, abi.encode(t0, t1));
        uint256 gross = IERC20(WETH).balanceOf(address(this)) - before;

        uint256 fee = (gross * FEE_BPS) / 10_000;
        netWeth = gross - fee;
        feesAccrued += fee;
        if (netWeth < amountOutMinNet) revert Slippage();

        if (unwrapToETH) {
            IWETH9(WETH).withdraw(netWeth);
            _sendEth(msg.sender, netWeth);
        } else {
            IERC20(WETH).safeTransfer(msg.sender, netWeth);
        }

        emit FeeCollected(token, false, msg.sender, gross, fee);
    }

    // ----------------------------------------------------------------- callback

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        (address t0, address t1) = abi.decode(data, (address, address));
        // Only the canonical pool for (t0,t1,POOL_FEE) may invoke this — blocks fake-pool drains.
        if (msg.sender != v3Factory.getPool(t0, t1, POOL_FEE)) revert NotPool();
        if (amount0Delta > 0) IERC20(t0).safeTransfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(t1).safeTransfer(msg.sender, uint256(amount1Delta));
    }

    // ----------------------------------------------------------------- admin (pull-over-push)

    function withdrawFees() external nonReentrant {
        uint256 amt = feesAccrued;
        feesAccrued = 0;
        IERC20(WETH).safeTransfer(feeRecipient, amt);
        emit FeesWithdrawn(feeRecipient, amt);
    }

    function setFeeRecipient(address r) external onlyOwner {
        require(r != address(0), "zero");
        feeRecipient = r;
        emit FeeRecipientChanged(r);
    }

    function claimPendingEth() external nonReentrant {
        uint256 amt = pendingEth[msg.sender];
        require(amt > 0, "none");
        pendingEth[msg.sender] = 0;
        _sendEth(msg.sender, amt);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) pendingEth[to] += amount; // fallback: recipient pulls later
    }
}
