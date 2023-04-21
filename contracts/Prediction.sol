// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
pragma abicoder v2;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/security/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

contract Prediction is Ownable, Pausable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  bool public genesisLockOnce = false;
  bool public genesisStartOnce = false;

  AggregatorV3Interface public oracle;

  address public adminAddress; // address of the admin
  address public operatorAddress; // address of the operator
  uint256 public intervalSeconds; // interval in seconds between two prediction rounds
  uint256 public bufferSeconds; // number of seconds for valid execution of a prediction round
  uint256 public minBetAmount; // minimum bet amount (in wei)
  uint256 public oracleLatestRoundId; // converted from uint80 (Chainlink)
  uint256 public oracleUpdateAllowance; // oracle update allowance (in seconds)
  uint256 public treasuryFee; // treasury fee (1000 = 10%, 200 = 2%, 150 = 1.50%)
  uint256 public treasuryAmount; // treasury amount that was not claimed
  uint256 public currentEpoch; // current epoch for prediction round

  uint256 public constant MAX_TREASURY_FEE = 1000; // 10%

  mapping(uint256 => mapping(address => BetInfo)) public ledger;
  mapping(uint256 => Round) public rounds;
  mapping(address => uint256[]) public userRounds;

  enum Position {
    Bull,
    Bear
  }

  struct Round {
    uint256 epoch;
    uint256 startTimestamp;
    uint256 lockTimestamp;
    uint256 closeTimestamp;
    uint256 totalAmount;
    int256 lockPrice;
    int256 closePrice;
    uint256 lockOracleId;
    uint256 closeOracleId;
    uint256 bullAmount;
    uint256 bearAmount;
    uint256 rewardBaseCalAmount;
    uint256 rewardAmount;
    bool oracleCalled;
  }

  struct BetInfo {
    Position position;
    uint256 amount;
    bool claimed; // default false
  }

  event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount);
  event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount);
  event Pause(uint256 indexed epoch);
  event StartRound(uint256 indexed epoch);
  event EndRound(uint256 indexed epoch, uint256 indexed roundId, int256 price);
  event LockRound(uint256 indexed epoch, uint256 indexed roundId, int256 price);
  event RewardsCalculated(
    uint256 indexed epoch,
    uint256 rewardBaseCalAmount,
    uint256 rewardAmount,
    uint256 treasuryAmount
  );

  modifier onlyAdminOrOperator() {
    require(
      msg.sender == adminAddress || msg.sender == operatorAddress,
      "Not operator/admin"
    );
    _;
  }

  modifier onlyOperator() {
    require(msg.sender == operatorAddress, "Not operator");
    _;
  }

  modifier notContract() {
    require(!_isContract(msg.sender), "Contract not allowed");
    require(msg.sender == tx.origin, "Proxy contract not allowed");
    _;
  }

  /**
   * @notice Constructor
   * @param _oracleAddress: oracle address
   * @param _adminAddress: admin address
   * @param _operatorAddress: operator address
   * @param _intervalSeconds: number of time within an interval
   * @param _bufferSeconds: buffer of time for resolution of price
   * @param _minBetAmount: minimum bet amounts (in wei)
   * @param _oracleUpdateAllowance: oracle update allowance
   * @param _treasuryFee: treasury fee (1000 = 10%)
   */
  constructor(
    address _oracleAddress,
    address _adminAddress,
    address _operatorAddress,
    uint256 _intervalSeconds,
    uint256 _bufferSeconds,
    uint256 _minBetAmount,
    uint256 _oracleUpdateAllowance,
    uint256 _treasuryFee
  ) {
    require(_treasuryFee <= MAX_TREASURY_FEE, "Treasury fee too high");

    oracle = AggregatorV3Interface(_oracleAddress);
    adminAddress = _adminAddress;
    operatorAddress = _operatorAddress;
    intervalSeconds = _intervalSeconds;
    bufferSeconds = _bufferSeconds;
    minBetAmount = _minBetAmount;
    oracleUpdateAllowance = _oracleUpdateAllowance;
    treasuryFee = _treasuryFee;
  }

  /**
   * @notice Bet bear position
   * @param epoch: epoch
   */
  function betBear(
    uint256 epoch
  ) external payable whenNotPaused nonReentrant notContract {
    require(epoch == currentEpoch, "Bet is too early/late");
    require(_bettable(epoch), "Round not bettable");
    require(
      msg.value >= minBetAmount,
      "Bet amount must be greater than minBetAmount"
    );
    require(
      ledger[epoch][msg.sender].amount == 0,
      "Can only bet once per round"
    );

    // Update round data
    uint256 amount = msg.value;
    Round storage round = rounds[epoch];
    round.totalAmount = round.totalAmount + amount;
    round.bearAmount = round.bearAmount + amount;

    // Update user data
    BetInfo storage betInfo = ledger[epoch][msg.sender];
    betInfo.position = Position.Bear;
    betInfo.amount = amount;
    userRounds[msg.sender].push(epoch);

    emit BetBear(msg.sender, epoch, amount);
  }

  /**
   * @notice Bet bull position
   * @param epoch: epoch
   */
  function betBull(
    uint256 epoch
  ) external payable whenNotPaused nonReentrant notContract {
    require(epoch == currentEpoch, "Bet is too early/late");
    require(_bettable(epoch), "Round not bettable");
    require(
      msg.value >= minBetAmount,
      "Bet amount must be greater than minBetAmount"
    );
    require(
      ledger[epoch][msg.sender].amount == 0,
      "Can only bet once per round"
    );

    // Update round data
    uint256 amount = msg.value;
    Round storage round = rounds[epoch];
    round.totalAmount = round.totalAmount + amount;
    round.bullAmount = round.bullAmount + amount;

    // Update user data
    BetInfo storage betInfo = ledger[epoch][msg.sender];
    betInfo.position = Position.Bull;
    betInfo.amount = amount;
    userRounds[msg.sender].push(epoch);

    emit BetBull(msg.sender, epoch, amount);
  }

  /**
   * @notice Start the next round n, lock price for round n-1, end round n-2
   * @dev Callable by operator
   */
  function executeRound() external whenNotPaused onlyOperator {
    require(
      genesisStartOnce && genesisLockOnce,
      "Can only run after genesisStartRound and genesisLockRound is triggered"
    );

    (uint80 currentRoundId, int256 currentPrice) = _getPriceFromOracle();

    oracleLatestRoundId = uint256(currentRoundId);

    // CurrentEpoch refers to previous round (n-1)
    _safeLockRound(currentEpoch, currentRoundId, currentPrice);
    _safeEndRound(currentEpoch - 1, currentRoundId, currentPrice);
    _calculateRewards(currentEpoch - 1);

    // Increment currentEpoch to current round (n)
    currentEpoch = currentEpoch + 1;
    _safeStartRound(currentEpoch);
  }

  /**
   * @notice Lock genesis round
   * @dev Callable by operator
   */
  function genesisLockRound() external whenNotPaused onlyOperator {
    require(
      genesisStartOnce,
      "Can only run after genesisStartRound is triggered"
    );
    require(!genesisLockOnce, "Can only run genesisLockRound once");

    (uint80 currentRoundId, int256 currentPrice) = _getPriceFromOracle();

    oracleLatestRoundId = uint256(currentRoundId);

    _safeLockRound(currentEpoch, currentRoundId, currentPrice);

    currentEpoch = currentEpoch + 1;
    _startRound(currentEpoch);
    genesisLockOnce = true;
  }

  /**
   * @notice Start genesis round
   * @dev Callable by admin or operator
   */
  function genesisStartRound() external whenNotPaused onlyOperator {
    require(!genesisStartOnce, "Can only run genesisStartRound once");

    currentEpoch = currentEpoch + 1;
    _startRound(currentEpoch);
    genesisStartOnce = true;
  }

  /**
   * @notice Get latest recorded price from oracle
   * If it falls below allowed buffer or has not updated, it would be invalid.
   */
  function _getPriceFromOracle() internal view returns (uint80, int256) {
    uint256 leastAllowedTimestamp = block.timestamp + oracleUpdateAllowance;
    (uint80 roundId, int256 price, , uint256 timestamp, ) = oracle
      .latestRoundData();
    require(
      timestamp <= leastAllowedTimestamp,
      "Oracle update exceeded max timestamp allowance"
    );
    require(
      uint256(roundId) > oracleLatestRoundId,
      "Oracle update roundId must be larger than oracleLatestRoundId"
    );
    return (roundId, price);
  }

  /**
   * @notice called by the admin to pause, triggers stopped state
   * @dev Callable by admin or operator
   */
  function pause() external whenNotPaused onlyAdminOrOperator {
    _pause();

    emit Pause(currentEpoch);
  }

  /**
   * @notice Start round
   * Previous round n-2 must end
   * @param epoch: epoch
   */
  function _startRound(uint256 epoch) internal {
    Round storage round = rounds[epoch];
    round.startTimestamp = block.timestamp;
    round.lockTimestamp = block.timestamp + intervalSeconds;
    round.closeTimestamp = block.timestamp + (2 * intervalSeconds);
    round.epoch = epoch;
    round.totalAmount = 0;

    emit StartRound(epoch);
  }

  /**
   * @notice Calculate rewards for round
   * @param epoch: epoch
   */
  function _calculateRewards(uint256 epoch) internal {
    require(
      rounds[epoch].rewardBaseCalAmount == 0 && rounds[epoch].rewardAmount == 0,
      "Rewards calculated"
    );
    Round storage round = rounds[epoch];
    uint256 rewardBaseCalAmount;
    uint256 treasuryAmt;
    uint256 rewardAmount;

    // Bull wins
    if (round.closePrice > round.lockPrice) {
      rewardBaseCalAmount = round.bullAmount;
      treasuryAmt = (round.totalAmount * treasuryFee) / 10000;
      rewardAmount = round.totalAmount - treasuryAmt;
    }
    // Bear wins
    else if (round.closePrice < round.lockPrice) {
      rewardBaseCalAmount = round.bearAmount;
      treasuryAmt = (round.totalAmount * treasuryFee) / 10000;
      rewardAmount = round.totalAmount - treasuryAmt;
    }
    // House wins
    else {
      rewardBaseCalAmount = 0;
      rewardAmount = 0;
      treasuryAmt = round.totalAmount;
    }
    round.rewardBaseCalAmount = rewardBaseCalAmount;
    round.rewardAmount = rewardAmount;

    // Add to treasury
    treasuryAmount += treasuryAmt;

    emit RewardsCalculated(
      epoch,
      rewardBaseCalAmount,
      rewardAmount,
      treasuryAmt
    );
  }

  /**
   * @notice End round
   * @param epoch: epoch
   * @param roundId: roundId
   * @param price: price of the round
   */
  function _safeEndRound(
    uint256 epoch,
    uint256 roundId,
    int256 price
  ) internal {
    require(
      rounds[epoch].lockTimestamp != 0,
      "Can only end round after round has locked"
    );
    require(
      block.timestamp >= rounds[epoch].closeTimestamp,
      "Can only end round after closeTimestamp"
    );
    require(
      block.timestamp <= rounds[epoch].closeTimestamp + bufferSeconds,
      "Can only end round within bufferSeconds"
    );
    Round storage round = rounds[epoch];
    round.closePrice = price;
    round.closeOracleId = roundId;
    round.oracleCalled = true;

    emit EndRound(epoch, roundId, round.closePrice);
  }

  /**
   * @notice Lock round
   * @param epoch: epoch
   * @param roundId: roundId
   * @param price: price of the round
   */
  function _safeLockRound(
    uint256 epoch,
    uint256 roundId,
    int256 price
  ) internal {
    require(
      rounds[epoch].startTimestamp != 0,
      "Can only lock round after round has started"
    );
    require(
      block.timestamp >= rounds[epoch].lockTimestamp,
      "Can only lock round after lockTimestamp"
    );
    require(
      block.timestamp <= rounds[epoch].lockTimestamp + bufferSeconds,
      "Can only lock round within bufferSeconds"
    );
    Round storage round = rounds[epoch];
    round.closeTimestamp = block.timestamp + intervalSeconds;
    round.lockPrice = price;
    round.lockOracleId = roundId;

    emit LockRound(epoch, roundId, round.lockPrice);
  }

  /**
   * @notice Start round
   * Previous round n-2 must end
   * @param epoch: epoch
   */
  function _safeStartRound(uint256 epoch) internal {
    require(
      genesisStartOnce,
      "Can only run after genesisStartRound is triggered"
    );
    require(
      rounds[epoch - 2].closeTimestamp != 0,
      "Can only start round after round n-2 has ended"
    );
    require(
      block.timestamp >= rounds[epoch - 2].closeTimestamp,
      "Can only start new round after round n-2 closeTimestamp"
    );
    _startRound(epoch);
  }

  /**
   * @notice Determine if a round is valid for receiving bets
   * Round must have started and locked
   * Current timestamp must be within startTimestamp and closeTimestamp
   */
  function _bettable(uint256 epoch) internal view returns (bool) {
    return
      rounds[epoch].startTimestamp != 0 &&
      rounds[epoch].lockTimestamp != 0 &&
      block.timestamp > rounds[epoch].startTimestamp &&
      block.timestamp < rounds[epoch].lockTimestamp;
  }

  /**
   * @notice Returns true if `account` is a contract.
   * @param account: account address
   */
  function _isContract(address account) internal view returns (bool) {
    uint256 size;
    assembly {
      size := extcodesize(account)
    }
    return size > 0;
  }
}
