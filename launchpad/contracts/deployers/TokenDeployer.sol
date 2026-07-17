// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchToken} from "../LaunchToken.sol";

/// @notice Deploys LaunchToken instances on behalf of the factory. Kept separate so the launched
/// token's creation bytecode is NOT inlined into LaunchpadFactory (contract-size limit).
/// @dev The deployed token's `factory` is set to the LaunchpadFactory (passed in), so all
/// onlyFactory hooks (enableTrading, seedBlocklist) answer to the launchpad, not this deployer.
contract TokenDeployer {
    function deploy(
        bytes32 salt,
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address factory,
        LaunchToken.GuardConfig calldata guard
    ) external returns (address) {
        return address(new LaunchToken{salt: salt}(name, symbol, supply, factory, guard));
    }
}
