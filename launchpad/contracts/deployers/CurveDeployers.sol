// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CurveToken} from "../CurveToken.sol";
import {BondingCurve} from "../BondingCurve.sol";
import {Bond} from "../Bond.sol";
import {CurvePool} from "../CurvePool.sol";
import {LaunchToken} from "../LaunchToken.sol";
import {OtcVault} from "../OtcVault.sol";

/// @notice Thin deployers so the big contracts' creation bytecode isn't inlined into CurveLaunchFactory
/// (24KB contract-size limit). Each is deployed once and its address handed to the factory.

contract CurveTokenDeployer {
    function deploy(string calldata name, string calldata symbol, uint256 supply, address recipient)
        external
        returns (address)
    {
        return address(new CurveToken(name, symbol, supply, recipient));
    }
}

contract BondingCurveDeployer {
    function deploy(
        address token,
        address weth,
        address v3Factory,
        address platform,
        address dev,
        uint256 virtEth,
        uint256 curveSupply,
        uint256 gradTarget,
        uint32 antiSnipeSecs,
        uint256 maxBuyWei,
        address bondDeployer,
        uint256 ambushSupply
    ) external returns (address) {
        return address(
            new BondingCurve(
                token, weth, v3Factory, platform, dev, virtEth, curveSupply, gradTarget, antiSnipeSecs, maxBuyWei,
                bondDeployer, ambushSupply
            )
        );
    }
}

contract BondDeployer {
    function deploy(address token, address weth, address v3Factory, address platform, address curve)
        external
        returns (address)
    {
        return address(new Bond(token, weth, v3Factory, platform, curve));
    }
}

contract LaunchTokenDeployer {
    /// @dev CREATE2 with a caller-supplied salt so the token (and therefore its Uniswap pool) address is not
    /// a predictable function of this deployer's nonce. That closes a launch-DoS where an attacker precreates
    /// AND initializes the token's WETH pool at the next predictable address, making CurvePool's own
    /// initialize() revert and permanently bricking every launch that reuses that address.
    function deploy(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address factory,
        LaunchToken.GuardConfig calldata g,
        bytes32 salt
    ) external returns (address) {
        return address(new LaunchToken{salt: salt}(name, symbol, supply, factory, g));
    }
}

contract CurvePoolDeployer {
    function deploy(
        address token,
        address weth,
        address v3Factory,
        address platform,
        address dev,
        address bondDeployer,
        uint256 curveSupply,
        uint256 ambushSupply,
        int24 startTick,
        int24 curveWidth,
        int24 minGradWidth
    ) external returns (address) {
        return address(
            new CurvePool(
                token, weth, v3Factory, platform, dev, bondDeployer, curveSupply, ambushSupply, startTick, curveWidth, minGradWidth
            )
        );
    }
}

contract OtcVaultDeployer {
    function deploy(
        address v3Factory,
        address token,
        address weth,
        address robin,
        address platform,
        uint32 twapWindow,
        uint256 otcPrice,
        uint256 burnRatio
    ) external returns (address) {
        return address(new OtcVault(v3Factory, token, weth, robin, platform, twapWindow, otcPrice, burnRatio));
    }
}
