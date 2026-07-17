// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title RobinStaking
/// @notice Stake $ROBIN, earn ETH. Every token launched through the platform routes 20% of its
/// ATH-vault proceeds here as ETH rewards, distributed pro-rata to stakers. Standard accumulator
/// (accRewardPerShare) accounting — O(1) per action, no loops.
/// @dev Rewards arrive as lump-sum ETH via notifyReward(); if nobody is staked at that moment the ETH
/// is queued and distributed on the next notify that has stakers (never lost, never stuck).
contract RobinStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant ACC = 1e18; // fixed-point scaler for accRewardPerShare
    uint256 public constant UNSTAKE_DELAY = 1 days; // min hold after (re)staking — deters just-in-time reward capture

    IERC20 public immutable robin; // the $ROBIN token

    uint256 public totalStaked;
    uint256 public accRewardPerShare; // ETH-wei per staked token, scaled by ACC
    uint256 public queuedRewards; // ETH received while totalStaked == 0

    mapping(address => uint256) public staked;
    mapping(address => uint256) public rewardDebt; // staked*acc/ACC at last settle
    mapping(address => uint256) public accrued; // settled-but-unclaimed ETH
    mapping(address => uint256) public stakedAt; // last (re)stake time; gates unstake by UNSTAKE_DELAY

    error Zero();
    error Insufficient();
    error Locked();

    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event Claimed(address indexed user, uint256 amount);
    event RewardAdded(uint256 amount, bool distributed);

    constructor(address robin_) {
        require(robin_ != address(0), "zero");
        robin = IERC20(robin_);
    }

    /// @notice Pending ETH reward for `user`.
    function pending(address user) public view returns (uint256) {
        uint256 acc = staked[user] * accRewardPerShare / ACC;
        return accrued[user] + (acc - rewardDebt[user]);
    }

    function _settle(address user) internal {
        uint256 acc = staked[user] * accRewardPerShare / ACC;
        accrued[user] += acc - rewardDebt[user];
        rewardDebt[user] = acc;
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert Zero();
        _settle(msg.sender);
        robin.safeTransferFrom(msg.sender, address(this), amount);
        staked[msg.sender] += amount;
        totalStaked += amount;
        stakedAt[msg.sender] = block.timestamp;
        rewardDebt[msg.sender] = staked[msg.sender] * accRewardPerShare / ACC;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert Zero();
        if (staked[msg.sender] < amount) revert Insufficient();
        if (block.timestamp < stakedAt[msg.sender] + UNSTAKE_DELAY) revert Locked();
        _settle(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        rewardDebt[msg.sender] = staked[msg.sender] * accRewardPerShare / ACC;
        robin.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);
        amount = accrued[msg.sender];
        if (amount == 0) revert Zero();
        accrued[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "eth send");
        emit Claimed(msg.sender, amount);
    }

    /// @notice Add ETH rewards to the pool (called by ATH-vaults). Distributes pro-rata to current
    /// stakers; if none are staked, queues the ETH for the next distribution.
    function notifyReward() external payable {
        uint256 amount = msg.value + queuedRewards;
        if (amount == 0) return;
        if (totalStaked == 0) {
            queuedRewards = amount;
            emit RewardAdded(msg.value, false);
        } else {
            queuedRewards = 0;
            accRewardPerShare += Math.mulDiv(amount, ACC, totalStaked);
            emit RewardAdded(amount, true);
        }
    }

    receive() external payable {
        // allow plain ETH sends to count as rewards
        if (totalStaked == 0) {
            queuedRewards += msg.value;
        } else {
            accRewardPerShare += Math.mulDiv(msg.value, ACC, totalStaked);
        }
    }
}
