// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IUniswapV3Factory, IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";
import {PoolMath} from "./libraries/PoolMath.sol";

/// @title OtcVault
/// @notice Per-launch OTC desk holding 20% of supply. After the token graduates and its TWAP market cap
/// reaches the OTC level (~$10k), the window opens: buyers **burn $ROBIN** to unlock an allocation
/// (bigger burn → bigger per-wallet cap) and buy the token at the fixed OTC price — no matter how high the
/// market has run. The ETH they pay goes straight to the platform wallet. Burning $ROBIN is a permanent
/// supply sink that benefits every $ROBIN holder.
contract OtcVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint24 public constant POOL_FEE = 10000;

    IUniswapV3Factory public immutable v3Factory;
    IERC20 public immutable token; // the launched token (this vault holds 20% of it)
    address public immutable weth;
    IERC20 public immutable robin; // burned for access
    address public immutable platform; // receives the OTC ETH
    bool public immutable tokenIsToken0;
    uint32 public immutable twapWindow;
    uint256 public immutable otcPrice; // WETH-wei per 1e18 token — the fixed "$10k-MC" price + open trigger
    uint256 public immutable burnRatio; // project tokens unlocked per 1 $ROBIN burned

    bool public active;
    IUniswapV3Pool public pool;
    uint256 public totalSold;
    mapping(address => uint256) public burned; // $ROBIN a wallet has burned (cumulative)
    mapping(address => uint256) public purchased; // tokens a wallet has bought (cumulative)

    error NotActive();
    error AlreadyActive();
    error NoPool();
    error NotOpen();
    error OverAllowance();
    error SoldOut();
    error Underpaid();

    event Activated(address indexed pool);
    event OtcBuy(address indexed buyer, uint256 robinBurned, uint256 tokensOut, uint256 ethPaid);

    constructor(
        address v3Factory_,
        address token_,
        address weth_,
        address robin_,
        address platform_,
        uint32 twapWindow_,
        uint256 otcPrice_,
        uint256 burnRatio_
    ) {
        require(
            v3Factory_ != address(0) && token_ != address(0) && weth_ != address(0) && robin_ != address(0)
                && platform_ != address(0),
            "zero"
        );
        require(twapWindow_ >= 600 && otcPrice_ > 0 && burnRatio_ > 0, "params");
        v3Factory = IUniswapV3Factory(v3Factory_);
        token = IERC20(token_);
        weth = weth_;
        robin = IERC20(robin_);
        platform = platform_;
        twapWindow = twapWindow_;
        otcPrice = otcPrice_;
        burnRatio = burnRatio_;
        tokenIsToken0 = token_ < weth_;
    }

    /// @notice Bind the graduated pool (permissionless; validates the canonical initialized pool).
    function activate() external {
        if (active) revert AlreadyActive();
        address p = v3Factory.getPool(address(token), weth, POOL_FEE);
        if (p == address(0)) revert NoPool();
        (uint160 sqrtP,,,,,,) = IUniswapV3Pool(p).slot0();
        if (sqrtP == 0) revert NoPool();
        pool = IUniswapV3Pool(p);
        active = true;
        emit Activated(p);
    }

    /// @notice Is the OTC open? Opens once the 30-min TWAP price reaches the OTC price (~$10k MC).
    function isOpen() public view returns (bool) {
        if (!active) return false;
        return PoolMath.twapPriceWethPerToken(_meanTick(), tokenIsToken0) >= otcPrice;
    }

    /// @notice Tokens `wallet` may still buy, given what it has burned and bought.
    function allowanceOf(address wallet) public view returns (uint256) {
        uint256 unlocked = burned[wallet] * burnRatio / 1e18;
        return unlocked > purchased[wallet] ? unlocked - purchased[wallet] : 0;
    }

    /// @notice Burn `robinBurn` $ROBIN (0 to reuse prior burn) and buy `tokenAmount` at the OTC price.
    function buyOtc(uint256 robinBurn, uint256 tokenAmount) external payable nonReentrant {
        if (!active) revert NotActive();
        if (!isOpen()) revert NotOpen();
        if (tokenAmount == 0) revert SoldOut();

        if (robinBurn > 0) {
            robin.safeTransferFrom(msg.sender, BURN, robinBurn);
            burned[msg.sender] += robinBurn;
        }
        if (tokenAmount > allowanceOf(msg.sender)) revert OverAllowance();
        if (tokenAmount > token.balanceOf(address(this))) revert SoldOut();

        uint256 cost = Math.mulDiv(tokenAmount, otcPrice, 1e18);
        if (msg.value < cost) revert Underpaid();

        purchased[msg.sender] += tokenAmount;
        totalSold += tokenAmount;

        token.safeTransfer(msg.sender, tokenAmount);
        (bool ok,) = platform.call{value: cost}(""); // OTC ETH -> platform wallet
        require(ok, "eth");
        if (msg.value > cost) {
            (bool r,) = msg.sender.call{value: msg.value - cost}(""); // refund overpay
            require(r, "refund");
        }
        emit OtcBuy(msg.sender, robinBurn, tokenAmount, cost);
    }

    function remaining() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function _meanTick() internal view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;
        (int56[] memory cum,) = pool.observe(ago);
        return PoolMath.meanTick(cum[0], cum[1], twapWindow);
    }
}
