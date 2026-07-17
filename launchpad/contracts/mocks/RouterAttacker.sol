// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPadR {
    function buy(address token, uint256 minOut) external payable returns (uint256);
    function sell(address token, uint256 amountIn, uint256 minOutEth) external returns (uint256);
    function uniswapV3SwapCallback(int256, int256, bytes calldata) external;
    function withdrawPlatform() external;
}

interface IERC20x {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Hostile counterparty used by the adversarial suite. On being paid ETH (a sell payout), it tries to
/// re-enter the router; it can also poke the swap callback directly. Everything it attempts must fail safely.
contract RouterAttacker {
    IPadR public r;
    address public t;
    uint8 public mode; // 0 = passive, 1 = re-enter buy, 2 = re-enter withdrawPlatform

    constructor(address r_, address t_) {
        r = IPadR(r_);
        t = t_;
    }

    receive() external payable {
        if (mode == 1) {
            mode = 0;
            r.buy{value: msg.value}(t, 0); // re-enter a nonReentrant fn -> must revert
        } else if (mode == 2) {
            mode = 0;
            r.withdrawPlatform(); // try to re-enter a payout -> must not double-pay
        }
    }

    function doSell(uint256 a, uint8 m) external {
        mode = m;
        IERC20x(t).approve(address(r), a);
        r.sell(t, a, 0);
    }

    function pokeCallback() external {
        r.uniswapV3SwapCallback(1, -1, abi.encode(t)); // not mid-swap -> must revert
    }
}
