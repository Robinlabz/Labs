// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MilestoneVault} from "../MilestoneVault.sol";

/// @notice Deploys MilestoneVault instances on behalf of the factory. Kept separate so the vault's
/// creation bytecode is NOT inlined into LaunchpadFactory (contract-size limit).
/// @dev The vault's `factory` is set to the LaunchpadFactory (passed in), so onlyFactory (initialize)
/// answers to the launchpad, not this deployer.
contract VaultDeployer {
    function deploy(address factory, address token, address weth, address pool, address dev)
        external
        returns (address)
    {
        return address(new MilestoneVault(factory, token, weth, pool, dev));
    }
}
