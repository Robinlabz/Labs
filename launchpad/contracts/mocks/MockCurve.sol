// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Stand-in for a CurvePool in router unit tests: exposes a settable bond() so we can simulate a coin
/// graduating (bond != 0) and exercise the deferred-fee release / floor flush paths.
contract MockCurve {
    address public bond;
    bool public graduated; // default false; the router reads this to decide whether to price-cap a buy

    function setBond(address b) external {
        bond = b;
    }

    function setGraduated(bool g) external {
        graduated = g;
    }

    // the mock pool ignores the price limit, so any value is fine here
    function gradSqrtPriceX96() external pure returns (uint160) {
        return type(uint160).max;
    }
}
