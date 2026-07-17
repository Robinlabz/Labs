// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title LiquidityLocker
/// @notice Immutable owner of every launch's full-range v3 liquidity position. It can collect the
/// pool's accrued swap fees to a fixed per-pool beneficiary, but it has NO decreaseLiquidity / burn /
/// transfer path — so the launch liquidity can never be pulled. This is the "not a rug" guarantee.
/// @dev v3 positions are keyed by (owner, tickLower, tickUpper); the launchpad mints each position
/// with recipient == this contract at [MIN_TICK, MAX_TICK], so this contract is the owner and only it
/// can ever call collect. There is intentionally no function that calls pool.burn.
contract LiquidityLocker {
    address public immutable factory;

    mapping(address => address) public beneficiaryOf; // pool => fee beneficiary (set once)

    error NotFactory();
    error AlreadyRegistered();
    error Unregistered();

    event PoolLocked(address indexed pool, address indexed beneficiary);
    event FeesCollected(address indexed pool, address indexed beneficiary, uint128 amount0, uint128 amount1);

    constructor(address factory_) {
        require(factory_ != address(0), "factory=0");
        factory = factory_;
    }

    /// @notice Record the immutable fee beneficiary for a pool whose LP is locked here.
    function register(address pool, address beneficiary) external {
        if (msg.sender != factory) revert NotFactory();
        require(beneficiary != address(0), "beneficiary=0");
        if (beneficiaryOf[pool] != address(0)) revert AlreadyRegistered();
        beneficiaryOf[pool] = beneficiary;
        emit PoolLocked(pool, beneficiary);
    }

    /// @notice Permissionlessly sweep the locked position's accrued swap fees to its beneficiary.
    /// Anyone may call; funds can only ever go to the pre-registered beneficiary.
    function collectFees(address pool) external returns (uint128 amount0, uint128 amount1) {
        address beneficiary = beneficiaryOf[pool];
        if (beneficiary == address(0)) revert Unregistered();
        (amount0, amount1) = IUniswapV3Pool(pool).collect(
            beneficiary,
            PoolMath.MIN_TICK,
            PoolMath.MAX_TICK,
            type(uint128).max,
            type(uint128).max
        );
        emit FeesCollected(pool, beneficiary, amount0, amount1);
    }
}
