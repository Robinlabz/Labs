// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {CurveTokenDeployer, BondingCurveDeployer} from "./deployers/CurveDeployers.sol";

/// @title CurveLaunchFactory
/// @notice Launchpad-for-many (bonding-curve model). Each launch mints a fixed 1B supply and funds a single
/// bonding curve with all of it: 75% trades on the curve, 25% is reserved as the Bond's Ambush. When the
/// curve collects GRAD_TARGET it graduates and posts "The Bond" — Sherwood (locked full-range LP) +
/// Bounty (an ETH floor that buys dips) + Ambush (the 25%, sold only into strength). Buy fee 1% -> platform;
/// sell fee 1% -> project dev; Sherwood LP swap fees -> platform. Projects only pick name / ticker / dev.
contract CurveLaunchFactory is Ownable2Step {
    using SafeERC20 for IERC20;

    uint16 public constant AMBUSH_BPS = 2500; // 25% reserved for the Bond's Ambush; 75% trades on the curve

    address public immutable WETH;
    address public immutable v3Factory;
    CurveTokenDeployer public immutable tokenDeployer;
    BondingCurveDeployer public immutable curveDeployer;
    address public immutable bondDeployer; // deploys the per-launch Bond at graduation

    address public platform; // buy fee + Sherwood LP fee recipient

    // ---- fixed, oracle-free terms — identical for every launch ----
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether; // 1B tokens (18 decimals)
    uint256 public constant VIRT_ETH = 0.8 ether;               // start MC = 1.25*VIRT = 1 ETH (~$1.9k)
    uint256 public constant GRAD_TARGET = 4 ether;              // graduate when the curve collects 4 ETH
    uint32 public constant ANTISNIPE_SECS = 300;                // 5-min opening window
    uint256 public constant MAX_BUY_WEI = 0.1 ether;            // per-buy cap during that window

    struct LaunchParams {
        string name;
        string symbol;
        address dev; // project dev: gets the 1% sell fee (burn or collect)
    }

    struct Record {
        address token;
        address curve;
        address dev;
        uint256 at;
    }

    mapping(address => Record) public recordOf;
    address[] public allTokens;

    error BadValue();

    event Launched(address indexed token, address indexed curve, address dev, uint256 supply);
    event PlatformChanged(address platform);

    constructor(
        address weth_,
        address v3Factory_,
        address platform_,
        address owner_,
        address tokenDeployer_,
        address curveDeployer_,
        address bondDeployer_
    ) Ownable(owner_) {
        require(
            weth_ != address(0) && v3Factory_ != address(0) && platform_ != address(0) && tokenDeployer_ != address(0)
                && curveDeployer_ != address(0) && bondDeployer_ != address(0),
            "zero"
        );
        WETH = weth_;
        v3Factory = v3Factory_;
        platform = platform_;
        tokenDeployer = CurveTokenDeployer(tokenDeployer_);
        curveDeployer = BondingCurveDeployer(curveDeployer_);
        bondDeployer = bondDeployer_;
    }

    /// @notice Launch a token on the pad's standard, oracle-free terms: 1B supply, ~$1.9k start MC,
    /// graduation at 4 ETH, 75% curve / 25% Ambush. Projects only pick name / ticker / dev.
    function launch(LaunchParams calldata p) external returns (address token, address curve) {
        if (p.dev == address(0)) revert BadValue();

        uint256 ambushAmt = (TOTAL_SUPPLY * AMBUSH_BPS) / 10_000; // 25% -> Bond Ambush (held by the curve until grad)
        uint256 curveAmt = TOTAL_SUPPLY - ambushAmt; // 75% trades on the curve

        // 1) token minted to this factory
        token = tokenDeployer.deploy(p.name, p.symbol, TOTAL_SUPPLY, address(this));

        // 2) bonding curve — trades `curveAmt`, holds `ambushAmt` for the Bond; posts the Bond at graduation
        curve = curveDeployer.deploy(
            token, WETH, v3Factory, platform, p.dev, VIRT_ETH, curveAmt, GRAD_TARGET, ANTISNIPE_SECS, MAX_BUY_WEI,
            bondDeployer, ambushAmt
        );

        // 3) fund the curve with the whole supply (curveAmt tradeable + ambushAmt reserved for the Bond)
        IERC20(token).safeTransfer(curve, TOTAL_SUPPLY);

        recordOf[token] = Record(token, curve, p.dev, block.timestamp);
        allTokens.push(token);
        emit Launched(token, curve, p.dev, TOTAL_SUPPLY);
        // NOTE: after graduation the Bond exists at BondingCurve.bond(); anyone can call Bond.poke() to
        // recenter the floor (permissionless keeper).
    }

    function setPlatform(address p_) external onlyOwner {
        require(p_ != address(0), "zero");
        platform = p_;
        emit PlatformChanged(p_);
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }
}
