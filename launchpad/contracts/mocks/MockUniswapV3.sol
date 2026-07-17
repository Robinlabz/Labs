// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    IUniswapV3MintCallback,
    IUniswapV3SwapCallback
} from "../interfaces/IUniswapV3.sol";
import {PoolMath} from "../libraries/PoolMath.sol";

/// @dev A simplified Uniswap v3 pool for unit tests. It reproduces the interface and the
/// callback settlement flow (output sent to recipient, then input pulled via callback), uses a
/// settable flat price for swaps, and a settable arithmetic-mean tick for the oracle. It does NOT
/// model price impact — tests drive price/tick directly. Enough to exercise the launchpad's logic.
contract MockUniswapV3Pool {
    address public token0;
    address public token1;
    uint24 public fee;

    uint160 public sqrtPriceX96;
    int24 public tick; // "current" tick (set at initialize)
    int24 public observeMeanTick; // what observe() reports as the mean
    uint16 public obsCardinalityNext;
    uint128 public liquidity;

    // price of `priceToken` denominated in the other token, 1e18-scaled (WETH per token if priceToken is the token)
    uint256 public priceWethPerToken = 1e18;
    address public wethToken;

    constructor(address t0, address t1, uint24 f) {
        token0 = t0;
        token1 = t1;
        fee = f;
    }

    function setWeth(address w) external {
        wethToken = w;
    }

    function setPrice(uint256 p) external {
        priceWethPerToken = p;
    }

    function setObserveMeanTick(int24 t) external {
        observeMeanTick = t;
    }

    function setTick(int24 t) external {
        tick = t;
    }

    function initialize(uint160 sqrtPriceX96_) external {
        require(sqrtPriceX96 == 0, "init");
        sqrtPriceX96 = sqrtPriceX96_;
        // For tests we anchor launchTick at 0 so milestone gating is driven purely by observeMeanTick.
        tick = 0;
        observeMeanTick = 0;
    }

    function increaseObservationCardinalityNext(uint16 n) external {
        obsCardinalityNext = n;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (sqrtPriceX96, tick, 0, obsCardinalityNext == 0 ? 1 : obsCardinalityNext, obsCardinalityNext, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidity)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidity = new uint160[](secondsAgos.length);
        // cum grows with time; delta over the window / window == observeMeanTick
        // secondsAgos[0] = window (older), secondsAgos[1] = 0 (now)
        tickCumulatives[0] = 0;
        for (uint256 i = 1; i < secondsAgos.length; ++i) {
            uint32 span = secondsAgos[0] - secondsAgos[i];
            tickCumulatives[i] = int56(observeMeanTick) * int56(uint56(span));
        }
    }

    // ---- liquidity add ----
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1)
    {
        recipient;
        tickLower;
        tickUpper;
        (amount0, amount1) = _amountsForLiquidity(amount);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        IUniswapV3MintCallback(msg.sender).uniswapV3MintCallback(amount0, amount1, data);
        require(IERC20(token0).balanceOf(address(this)) >= b0 + amount0, "M0");
        require(IERC20(token1).balanceOf(address(this)) >= b1 + amount1, "M1");
        liquidity += amount;
    }

    function collect(address, int24, int24, uint128, uint128) external pure returns (uint128, uint128) {
        return (0, 0); // no accrued fees in the mock
    }

    // ---- swap ----
    // amountSpecified > 0 = exact input. Sends output to recipient, then pulls input via callback.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1) {
        require(amountSpecified > 0, "exact-in only");
        uint256 amountIn = uint256(amountSpecified);
        address inToken = zeroForOne ? token0 : token1;
        address outToken = zeroForOne ? token1 : token0;

        uint256 outAmount = _quote(inToken, outToken, amountIn);
        require(IERC20(outToken).balanceOf(address(this)) >= outAmount, "reserve");

        // v3 sends output first, then calls back for input
        IERC20(outToken).transfer(recipient, outAmount);
        uint256 inBefore = IERC20(inToken).balanceOf(address(this));

        if (zeroForOne) {
            (amount0, amount1) = (int256(amountIn), -int256(outAmount));
        } else {
            (amount0, amount1) = (-int256(outAmount), int256(amountIn));
        }
        IUniswapV3SwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
        require(IERC20(inToken).balanceOf(address(this)) >= inBefore + amountIn, "pay");
    }

    function _quote(address inToken, address outToken, uint256 amountIn) internal view returns (uint256) {
        // one side is WETH; price is WETH per token (1e18-scaled)
        if (outToken == wethToken) {
            // selling token for WETH: out = in * price / 1e18
            return Math.mulDiv(amountIn, priceWethPerToken, 1e18);
        } else {
            // buying token with WETH: out = in * 1e18 / price
            inToken;
            return Math.mulDiv(amountIn, 1e18, priceWethPerToken);
        }
    }

    // standard v3 getAmountsForLiquidity for a full-range position at the current price
    function _amountsForLiquidity(uint128 L) internal view returns (uint256 amount0, uint256 amount1) {
        uint256 sqrtP = uint256(sqrtPriceX96);
        uint256 sqrtA = uint256(PoolMath.SQRT_RATIO_AT_MIN_TICK);
        uint256 sqrtB = uint256(PoolMath.SQRT_RATIO_AT_MAX_TICK);
        // amount0 = L * (sqrtB - sqrtP) / (sqrtP * sqrtB) * Q96
        amount0 = Math.mulDiv(uint256(L) * PoolMath.Q96, sqrtB - sqrtP, sqrtB) / sqrtP;
        // amount1 = L * (sqrtP - sqrtA) / Q96
        amount1 = Math.mulDiv(uint256(L), sqrtP - sqrtA, PoolMath.Q96);
    }
}

contract MockUniswapV3Factory {
    mapping(bytes32 => address) public pools;
    int24 public spacing = 200;

    function feeAmountTickSpacing(uint24) external view returns (int24) {
        return spacing;
    }

    function setSpacing(int24 s) external {
        spacing = s;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) public view returns (address) {
        (address a, address b) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return pools[keccak256(abi.encode(a, b, fee))];
    }

    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool) {
        (address a, address b) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        bytes32 k = keccak256(abi.encode(a, b, fee));
        require(pools[k] == address(0), "exists");
        pool = address(new MockUniswapV3Pool(a, b, fee));
        pools[k] = pool;
    }
}
