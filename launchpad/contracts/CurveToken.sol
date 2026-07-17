// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A plain, fixed-supply, hookless ERC20 for curve launches. No mint, no tax, no blacklist,
/// no owner — the whole supply is minted once to the launchpad, which splits it (10% vault / 90% curve).
/// Anti-snipe lives on the bonding curve (per-buy cap), not on the token, so this stays fully composable.
contract CurveToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply_, address recipient_)
        ERC20(name_, symbol_)
    {
        _mint(recipient_, supply_);
    }
}
