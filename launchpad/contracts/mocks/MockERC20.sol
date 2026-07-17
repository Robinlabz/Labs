// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Plain ERC20 for bonding-curve tests (the curve custodies and dispenses it).
contract MockERC20 is ERC20 {
    constructor(uint256 supply) ERC20("Curve Token", "CRV") {
        _mint(msg.sender, supply);
    }
}
