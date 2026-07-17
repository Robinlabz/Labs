// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool, IUniswapV3SwapCallback} from "../interfaces/IUniswapV3.sol";

/// @notice Test-only helper to execute a real exact-input swap directly against a Uniswap v3 pool
/// (no periphery exists on Robinhood Chain). Used by the fork tests to prove a graduated pool trades.
contract SwapProbe is IUniswapV3SwapCallback {
    uint160 internal constant MIN_SQRT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT = 1461446703485210103287273052203988822378723970342 - 1;

    /// @dev Caller must approve this contract to pull `tokenIn`. Output is sent to the caller.
    function swapExactIn(address pool, address tokenIn, uint256 amountIn)
        external
        returns (int256 amount0, int256 amount1)
    {
        bool zeroForOne = tokenIn == IUniswapV3Pool(pool).token0();
        (amount0, amount1) = IUniswapV3Pool(pool).swap(
            msg.sender,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT : MAX_SQRT,
            abi.encode(tokenIn, msg.sender)
        );
    }

    /// @dev Like swapExactIn but stops at `sqrtLimit` (e.g. the graduation price), so a buyout can't push
    /// the price past the curve's top into the empty region.
    function swapExactInLimit(address pool, address tokenIn, uint256 amountIn, uint160 sqrtLimit)
        external
        returns (int256 amount0, int256 amount1)
    {
        bool zeroForOne = tokenIn == IUniswapV3Pool(pool).token0();
        (amount0, amount1) =
            IUniswapV3Pool(pool).swap(msg.sender, zeroForOne, int256(amountIn), sqrtLimit, abi.encode(tokenIn, msg.sender));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external override {
        (address tokenIn, address payer) = abi.decode(data, (address, address));
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IERC20(tokenIn).transferFrom(payer, msg.sender, owed); // pool is msg.sender
    }
}
