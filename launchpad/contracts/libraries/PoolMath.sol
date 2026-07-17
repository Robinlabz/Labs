// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PoolMath
/// @notice Just enough Uniswap v3 math for the launchpad, built ONLY on OZ Math (mulDiv/sqrt).
/// We deliberately avoid TickMath/FullMath: milestone triggers use tick-offset arithmetic and
/// `launchTick` is read straight from slot0, so we never convert tick<->price on-chain.
library PoolMath {
    uint256 internal constant Q96 = 0x1000000000000000000000000; // 2**96
    uint256 internal constant Q192 = 0x1000000000000000000000000000000000000000000000000; // 2**192

    // Full-range position bounds (MIN/MAX tick snapped to tickSpacing 200) and their sqrt ratios,
    // precomputed off-chain (verified) so no TickMath is needed.
    int24 internal constant MIN_TICK = -887200;
    int24 internal constant MAX_TICK = 887200;
    // Exact Uniswap TickMath.getSqrtRatioAtTick(±887200) — must match what a real pool uses.
    uint160 internal constant SQRT_RATIO_AT_MIN_TICK = 4310618292;
    uint160 internal constant SQRT_RATIO_AT_MAX_TICK = 1456195216270955103206513029158776779468408838535;

    // Absolute pool bounds (for unbounded swaps, we clamp just inside these).
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// @notice sqrtPriceX96 = sqrt(amount1 / amount0) * 2**96, derived from the seed deposit ratio.
    /// @dev 512-bit safe via mulDiv; result must fit in uint160.
    function sqrtPriceX96FromAmounts(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        require(amount0 > 0 && amount1 > 0, "amounts=0");
        uint256 ratioX192 = Math.mulDiv(amount1, Q192, amount0);
        uint256 sqrtP = Math.sqrt(ratioX192);
        require(sqrtP <= type(uint160).max, "sqrtP overflow");
        // Bound to the full-range POSITION's tick-snapped sqrt ratios (not the absolute pool bounds),
        // so fullRangeLiquidity's (sqrtB - sqrtP) / (sqrtP - sqrtA) can never underflow.
        require(sqrtP > SQRT_RATIO_AT_MIN_TICK && sqrtP < SQRT_RATIO_AT_MAX_TICK, "price out of range");
        return uint160(sqrtP);
    }

    /// @notice Liquidity for a full-range position given the current price and both amounts.
    /// Standard Uniswap LiquidityAmounts.getLiquidityForAmounts specialized to the full range;
    /// returns min(L0, L1) so neither owed amount can exceed what we hold.
    function fullRangeLiquidity(uint160 sqrtP, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128 liquidity)
    {
        uint160 sqrtA = SQRT_RATIO_AT_MIN_TICK;
        uint160 sqrtB = SQRT_RATIO_AT_MAX_TICK;
        // sqrtP is guaranteed strictly between sqrtA and sqrtB for any launch price.
        uint256 l0 = _liquidityForAmount0(sqrtP, sqrtB, amount0);
        uint256 l1 = _liquidityForAmount1(sqrtA, sqrtP, amount1);
        uint256 l = l0 < l1 ? l0 : l1;
        require(l > 0 && l <= type(uint128).max, "bad liquidity");
        liquidity = uint128(l);
    }

    /// @notice Like fullRangeLiquidity but returns 0 instead of reverting when the fees are one-sided or too
    /// small to mint any liquidity. Lets the Bond compound Sherwood fees back in and skip gracefully on dust.
    function fullRangeLiquidityOrZero(uint160 sqrtP, uint256 amount0, uint256 amount1)
        internal
        pure
        returns (uint128)
    {
        if (amount0 == 0 || amount1 == 0) return 0;
        uint256 l0 = _liquidityForAmount0(sqrtP, SQRT_RATIO_AT_MAX_TICK, amount0);
        uint256 l1 = _liquidityForAmount1(SQRT_RATIO_AT_MIN_TICK, sqrtP, amount1);
        uint256 l = l0 < l1 ? l0 : l1;
        if (l == 0 || l > type(uint128).max) return 0;
        return uint128(l);
    }

    function _liquidityForAmount0(uint160 sqrtLower, uint160 sqrtUpper, uint256 amount0)
        private
        pure
        returns (uint256)
    {
        // L = amount0 * (sqrtLower * sqrtUpper / Q96) / (sqrtUpper - sqrtLower)
        uint256 intermediate = Math.mulDiv(uint256(sqrtLower), uint256(sqrtUpper), Q96);
        return Math.mulDiv(amount0, intermediate, uint256(sqrtUpper) - uint256(sqrtLower));
    }

    function _liquidityForAmount1(uint160 sqrtLower, uint160 sqrtUpper, uint256 amount1)
        private
        pure
        returns (uint256)
    {
        // L = amount1 * Q96 / (sqrtUpper - sqrtLower)
        return Math.mulDiv(amount1, Q96, uint256(sqrtUpper) - uint256(sqrtLower));
    }

    /// @notice Liquidity for a SINGLE-SIDED (range-order) position that sits entirely on one side of the
    /// current price. `token0Side` = the band is entirely ABOVE the current tick (holds only token0);
    /// otherwise it is entirely BELOW (holds only token1). `sqrtLo`/`sqrtHi` are the band's tick bounds.
    function singleSidedLiquidity(uint160 sqrtLo, uint160 sqrtHi, uint256 amount, bool token0Side)
        internal
        pure
        returns (uint128)
    {
        require(sqrtHi > sqrtLo, "band");
        uint256 l = token0Side
            ? _liquidityForAmount0(sqrtLo, sqrtHi, amount)
            : _liquidityForAmount1(sqrtLo, sqrtHi, amount);
        require(l > 0 && l <= type(uint128).max, "bad L");
        return uint128(l);
    }

    /// @notice Like singleSidedLiquidity but returns 0 instead of reverting when the band is empty or the
    /// amount is too small to make any liquidity. Lets a caller (the Bond) skip a placement gracefully.
    function singleSidedLiquidityOrZero(uint160 sqrtLo, uint160 sqrtHi, uint256 amount, bool token0Side)
        internal
        pure
        returns (uint128)
    {
        if (amount == 0 || sqrtHi <= sqrtLo) return 0;
        uint256 l = token0Side ? _liquidityForAmount0(sqrtLo, sqrtHi, amount) : _liquidityForAmount1(sqrtLo, sqrtHi, amount);
        if (l == 0 || l > type(uint128).max) return 0;
        return uint128(l);
    }

    /// @notice Canonical Uniswap v3 TickMath.getSqrtRatioAtTick — sqrt(1.0001^tick) * 2^96.
    /// Used to price the TWAP mean tick for manipulation-resistant slippage floors (relies on unchecked
    /// overflow exactly as Uniswap's original does).
    function getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        unchecked {
            uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
            require(absTick <= 887272, "T");
            uint256 ratio =
                absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
            if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
            if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
            if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
            if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
            if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
            if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
            if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
            if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
            if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
            if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
            if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
            if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
            if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
            if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
            if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
            if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
            if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
            if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
            if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
            if (tick > 0) ratio = type(uint256).max / ratio;
            sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
        }
    }

    /// @notice WETH-per-token (1e18-scaled) at a TWAP mean tick — manipulation-resistant (unlike spot).
    function twapPriceWethPerToken(int24 tick, bool tokenIsToken0) internal pure returns (uint256) {
        return quoteWethPerToken(getSqrtRatioAtTick(tick), tokenIsToken0);
    }

    /// @notice Arithmetic-mean tick over `window` seconds from the pool's oracle cumulatives.
    function meanTick(int56 tickCumulativeStart, int56 tickCumulativeEnd, uint32 window)
        internal
        pure
        returns (int24)
    {
        int56 delta = tickCumulativeEnd - tickCumulativeStart;
        int56 avg = delta / int56(uint56(window));
        // Round toward negative infinity (matches Uniswap OracleLibrary) for exactness.
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) avg--;
        return int24(avg);
    }

    /// @notice price(WETH per token, scaled by 1e18) implied by a sqrtPriceX96, respecting ordering.
    /// Only used for slippage/min-out estimates, never for the milestone gate.
    /// @dev Never squares the full sqrtPrice directly (that overflows uint256 for large sqrtPrice);
    /// the intermediate is divided by Q96 first so mulDiv stays in range.
    function quoteWethPerToken(uint160 sqrtPriceX96, bool tokenIsToken0) internal pure returns (uint256) {
        uint256 s = uint256(sqrtPriceX96);
        if (tokenIsToken0) {
            // WETH per token = (sqrtP/2^96)^2, scaled by 1e18
            uint256 p = Math.mulDiv(s, s, Q96); // = price * 2^96, no overflow
            return Math.mulDiv(p, 1e18, Q96);
        } else {
            // token is token1: WETH per token = (2^96/sqrtP)^2 = 2^192 / sqrtP^2, scaled by 1e18
            uint256 a = Math.mulDiv(Q96, 1e18, s);
            return Math.mulDiv(a, Q96, s);
        }
    }
}
