import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, web3 } from "hardhat";
import { BigNumber, utils, constants } from "ethers";

const ether = (val: string) => web3.utils.toWei(val, "ether");
const getBalance = async (address: string) => await ethers.provider.getBalance(address);
const expectBigNumberArray = (arr1: any[], arr2: any | any[]) => {
  expect(arr1.length).to.equal(arr2.length);
  arr1.forEach((n1, index) => {
    expect(n1.toString()).to.equal(BigNumber.from(arr2[index]).toString());
  });
};

const BLOCK_COUNT_MULTPLIER = 5;
const DECIMALS = 8; // Chainlink default for ETH / USD
const INITIAL_PRICE = 10000000000; // $100, 8 decimal places
const INTERVAL_SECONDS = 20 * BLOCK_COUNT_MULTPLIER; // 20 seconds * multiplier
const BUFFER_SECONDS = 5 * BLOCK_COUNT_MULTPLIER; // 5 seconds * multplier, round must lock/end within this buffer
const MIN_BET_AMOUNT = BigNumber.from(ether("1")); // 1 Wei
const UPDATE_ALLOWANCE = 30 * BLOCK_COUNT_MULTPLIER; // 30s * multiplier
const INITIAL_REWARD_RATE = 0.9; // 90%
const INITIAL_TREASURY_RATE = 0.1; // 10%

// Enum: 0 = Bull, 1 = Bear
const Position = {
  Bull: 0,
  Bear: 1,
};

describe("Prediction", function () {
  async function deployPredictionFixture() {
    const [operator, admin, bullUser1, bullUser2, bearUser1, bearUser2] = await ethers.getSigners();

    const Oracle = await ethers.getContractFactory("MockAggregator");
    const oracle = await Oracle.deploy(DECIMALS, INITIAL_PRICE);

    const Prediction = await ethers.getContractFactory("Prediction");
    const prediction = await Prediction.deploy(
      oracle.address,
      admin.address,
      operator.address,
      INTERVAL_SECONDS,
      BUFFER_SECONDS,
      MIN_BET_AMOUNT,
      UPDATE_ALLOWANCE,
      String(INITIAL_TREASURY_RATE * 10000)
    );

    const owner = await ethers.getSigner(await prediction.owner());

    return {
      prediction,
      oracle,
      owner,
      admin,
      operator,
      bullUser1,
      bullUser2,
      bearUser1,
      bearUser2,
    };
  }

  async function nextEpoch() {
    await time.increaseTo((await time.latest()) + INTERVAL_SECONDS); // Elapse 20 seconds
  }

  it("1.Initialize", async function () {
    const { prediction, admin, operator } = await loadFixture(deployPredictionFixture);
    expect(await getBalance(prediction.address)).to.equal(0);
    expect(await prediction.currentEpoch()).to.equal(0);
    expect(await prediction.intervalSeconds()).to.equal(INTERVAL_SECONDS);
    expect(await prediction.adminAddress()).to.equal(admin.address);
    expect(await prediction.operatorAddress()).to.equal(operator.address);
    expect(await prediction.treasuryAmount()).to.equal(0);
    expect(await prediction.minBetAmount()).to.equal(MIN_BET_AMOUNT.toString());
    expect(await prediction.oracleUpdateAllowance()).to.equal(UPDATE_ALLOWANCE);
    expect(await prediction.oracleUpdateAllowance()).to.equal(UPDATE_ALLOWANCE);
    expect(await prediction.genesisStartOnce()).to.equal(false);
    expect(await prediction.genesisLockOnce()).to.equal(false);
    expect(await prediction.paused()).to.equal(false);
  });

  it("2.Should start genesis rounds (round 1, round 2, round 3)", async () => {
    const { prediction, oracle } = await loadFixture(deployPredictionFixture);

    // Manual block calculation
    let currentTimestamp = await time.latest();

    // Epoch 0
    expect(await time.latest()).to.equal(currentTimestamp);
    expect(await prediction.currentEpoch()).to.equal(0);

    // Epoch 1: Start genesis round 1
    currentTimestamp++;
    const genesisStartRoundTx = await prediction.genesisStartRound();
    await expect(genesisStartRoundTx).to.emit(prediction, "StartRound").withArgs(BigNumber.from(1));
    expect(await prediction.currentEpoch()).to.equal(1);

    // Start round 1
    expect(await prediction.genesisStartOnce()).to.equal(true);
    expect(await prediction.genesisLockOnce()).to.equal(false);
    expect((await prediction.rounds(1)).startTimestamp).to.equal(BigNumber.from(currentTimestamp));
    expect((await prediction.rounds(1)).lockTimestamp).to.equal(BigNumber.from(currentTimestamp + INTERVAL_SECONDS));
    expect((await prediction.rounds(1)).closeTimestamp).to.equal(
      BigNumber.from(currentTimestamp + INTERVAL_SECONDS * 2)
    );
    expect((await prediction.rounds(1)).epoch).to.equal(1);
    expect((await prediction.rounds(1)).totalAmount).to.equal(0);

    // Elapse 20 blocks
    currentTimestamp += INTERVAL_SECONDS;
    await time.increaseTo(currentTimestamp);

    // Epoch 2: Lock genesis round 1 and starts round 2
    const genesisLockRoundTx = await prediction.genesisLockRound();
    await expect(genesisLockRoundTx)
      .to.emit(prediction, "LockRound")
      .withArgs(BigNumber.from(1), BigNumber.from(1), BigNumber.from(INITIAL_PRICE))
      .to.emit(prediction, "StartRound")
      .withArgs(BigNumber.from(2));
    currentTimestamp++;
    expect(await prediction.currentEpoch()).to.equal(BigNumber.from(2));

    // Lock round 1
    expect(await prediction.genesisStartOnce()).to.equal(true);
    expect(await prediction.genesisLockOnce()).to.equal(true);
    expect((await prediction.rounds(1)).lockPrice).to.equal(INITIAL_PRICE);

    // Start round 2
    expect((await prediction.rounds(2)).startTimestamp).to.equal(BigNumber.from(currentTimestamp));
    expect((await prediction.rounds(2)).lockTimestamp).to.equal(BigNumber.from(currentTimestamp + INTERVAL_SECONDS));
    expect((await prediction.rounds(2)).closeTimestamp).to.equal(
      BigNumber.from(currentTimestamp + 2 * INTERVAL_SECONDS)
    );
    expect((await prediction.rounds(2)).epoch).to.equal(BigNumber.from(2));
    expect((await prediction.rounds(2)).totalAmount).to.equal(0);

    // Elapse 20 blocks
    currentTimestamp += INTERVAL_SECONDS;
    await time.increaseTo(currentTimestamp);

    // Epoch 3: End genesis round 1, locks round 2, starts round 3
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId

    await expect(await prediction.executeRound()) // Oracle update and execute round
      .to.emit(prediction, "EndRound")
      .withArgs(BigNumber.from(1), BigNumber.from(2), BigNumber.from(INITIAL_PRICE))
      .to.emit(prediction, "LockRound")
      .withArgs(BigNumber.from(2), BigNumber.from(2), BigNumber.from(INITIAL_PRICE))
      .to.emit(prediction, "StartRound")
      .withArgs(BigNumber.from(3));

    currentTimestamp += 2;

    expect(await prediction.currentEpoch()).to.equal(BigNumber.from(3));

    // End round 1
    expect((await prediction.rounds(1)).closePrice).to.equal(BigNumber.from(INITIAL_PRICE));

    // Lock round 2
    expect((await prediction.rounds(2)).lockPrice).to.equal(BigNumber.from(INITIAL_PRICE));
  });

  it("3.Should not start rounds before genesis start and lock round has triggered", async () => {
    const { prediction, oracle } = await loadFixture(deployPredictionFixture);

    await expect(prediction.genesisLockRound()).to.be.revertedWith("Can only run after genesisStartRound is triggered");
    await expect(prediction.executeRound()).to.be.revertedWith(
      "Can only run after genesisStartRound and genesisLockRound is triggered"
    );
    await prediction.genesisStartRound();
    await expect(prediction.executeRound()).to.be.revertedWith(
      "Can only run after genesisStartRound and genesisLockRound is triggered"
    );
    await nextEpoch();
    await prediction.genesisLockRound(); // Success
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await prediction.executeRound(); // Success
  });

  it("4.Should not lock round before lockTimestamp and end round before closeTimestamp", async () => {
    const { prediction, oracle } = await loadFixture(deployPredictionFixture);

    await prediction.genesisStartRound();
    await expect(prediction.genesisLockRound()).to.be.revertedWith("Can only lock round after lockTimestamp");
    await nextEpoch();
    await prediction.genesisLockRound();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await expect(prediction.executeRound()).to.be.revertedWith("Can only lock round after lockTimestamp");

    await nextEpoch();
    await prediction.executeRound(); // Success
  });

  it("5.Should record oracle price", async () => {
    const { prediction, oracle } = await loadFixture(deployPredictionFixture);

    // Epoch 1
    await prediction.genesisStartRound();
    expect((await prediction.rounds(1)).lockPrice).to.equal(0);
    expect((await prediction.rounds(1)).closePrice).to.equal(0);

    // Epoch 2
    await nextEpoch();
    const price120 = 12000000000; // $120
    await oracle.updateAnswer(price120);
    await prediction.genesisLockRound(); // For round 1
    expect((await prediction.rounds(1)).lockPrice).to.equal(BigNumber.from(price120));
    expect((await prediction.rounds(1)).closePrice).to.equal(0);
    expect((await prediction.rounds(2)).lockPrice).to.equal(0);
    expect((await prediction.rounds(2)).closePrice).to.equal(0);

    // Epoch 3
    await nextEpoch();
    const price130 = 13000000000; // $130
    await oracle.updateAnswer(price130);
    await prediction.executeRound();
    expect((await prediction.rounds(1)).lockPrice).to.equal(BigNumber.from(price120));
    expect((await prediction.rounds(1)).closePrice).to.equal(BigNumber.from(price130));
    expect((await prediction.rounds(2)).lockPrice).to.equal(BigNumber.from(price130));
    expect((await prediction.rounds(2)).closePrice).to.equal(0);
    expect((await prediction.rounds(3)).lockPrice).to.equal(0);
    expect((await prediction.rounds(3)).closePrice).to.equal(0);

    // Epoch 4
    await nextEpoch();
    const price140 = 14000000000; // $140
    await oracle.updateAnswer(price140);
    await prediction.executeRound();
    expect((await prediction.rounds(1)).lockPrice).to.equal(BigNumber.from(price120));
    expect((await prediction.rounds(1)).closePrice).to.equal(BigNumber.from(price130));
    expect((await prediction.rounds(2)).lockPrice).to.equal(BigNumber.from(price130));
    expect((await prediction.rounds(2)).closePrice).to.equal(BigNumber.from(price140));
    expect((await prediction.rounds(3)).lockPrice).to.equal(BigNumber.from(price140));
    expect((await prediction.rounds(3)).closePrice).to.equal(0);
    expect((await prediction.rounds(4)).lockPrice).to.equal(0);
    expect((await prediction.rounds(4)).closePrice).to.equal(0);
  });

  it("6.Should reject oracle data if data is stale", async () => {
    const { prediction, oracle } = await loadFixture(deployPredictionFixture);

    await prediction.genesisStartRound();
    await nextEpoch();
    await prediction.genesisLockRound();
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await prediction.executeRound();

    // Oracle not updated, so roundId is same as previously recorded
    await nextEpoch();
    await expect(prediction.executeRound()).to.be.revertedWith(
      "Oracle update roundId must be larger than oracleLatestRoundId"
    );
  });

  it("7.Should record data and user bets", async () => {
    const { prediction, bullUser1, bullUser2, bearUser1, oracle } = await loadFixture(deployPredictionFixture);
    // Epoch 1
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, {
      value: BigNumber.from(ether("1.1")),
    }); // Bull 1.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, {
      value: BigNumber.from(ether("1.2")),
    }); // Bull 1.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, {
      value: BigNumber.from(ether("1.4")),
    }); // Bear 1.4 ETH

    expect(await getBalance(prediction.address)).to.equal(ether("3.7"));
    expect((await prediction.rounds(1)).totalAmount).to.equal(ether("3.7"));
    expect((await prediction.rounds(1)).bullAmount).to.equal(ether("2.3"));
    expect((await prediction.rounds(1)).bearAmount).to.equal(ether("1.4"));
    expect((await prediction.ledger(1, bullUser1.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(1, bullUser1.address)).amount).to.equal(ether("1.1"));
    expect((await prediction.ledger(1, bullUser2.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(1, bullUser2.address)).amount).to.equal(ether("1.2"));
    expect((await prediction.ledger(1, bearUser1.address)).position).to.equal(Position.Bear);
    expect((await prediction.ledger(1, bearUser1.address)).amount).to.equal(ether("1.4"));
    expectBigNumberArray((await prediction.getUserRounds(bullUser1.address, 0, 1))[0], [1]);
    expectBigNumberArray((await prediction.getUserRounds(bullUser2.address, 0, 1))[0], [1]);
    expectBigNumberArray((await prediction.getUserRounds(bearUser1.address, 0, 1))[0], [1]);
    expect(await prediction.getUserRoundsLength(bullUser1.address)).to.equal(1);

    // Epoch 2
    await nextEpoch();
    await prediction.genesisLockRound(); // For round 1
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, {
      value: BigNumber.from(ether("2.1")),
    }); // Bull 2.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, {
      value: BigNumber.from(ether("2.2")),
    }); // Bull 2.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, {
      value: BigNumber.from(ether("2.4")),
    }); // Bear 2.4 ETH

    expect(await getBalance(prediction.address)).to.equal(ether("10.4"));
    expect((await prediction.rounds(2)).totalAmount).to.equal(ether("6.7"));
    expect((await prediction.rounds(2)).bullAmount).to.equal(ether("4.3"));
    expect((await prediction.rounds(2)).bearAmount).to.equal(ether("2.4"));
    expect((await prediction.ledger(2, bullUser1.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(2, bullUser1.address)).amount).to.equal(ether("2.1"));
    expect((await prediction.ledger(2, bullUser2.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(2, bullUser2.address)).amount).to.equal(ether("2.2"));
    expect((await prediction.ledger(2, bearUser1.address)).position).to.equal(Position.Bear);
    expect((await prediction.ledger(2, bearUser1.address)).amount).to.equal(ether("2.4"));
    expectBigNumberArray((await prediction.getUserRounds(bullUser1.address, 0, 2))[0], [1, 2]);
    expectBigNumberArray((await prediction.getUserRounds(bullUser2.address, 0, 2))[0], [1, 2]);
    expectBigNumberArray((await prediction.getUserRounds(bearUser1.address, 0, 2))[0], [1, 2]);
    expect(await prediction.getUserRoundsLength(bullUser1.address)).to.equal(2);

    // Epoch 3
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, {
      value: BigNumber.from(ether("3.1")),
    }); // Bull 3.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, {
      value: BigNumber.from(ether("3.2")),
    }); // Bull 3.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, {
      value: BigNumber.from(ether("3.4")),
    }); // Bear 3.4 ETH

    expect(await getBalance(prediction.address)).to.equal(ether("20.1"));
    expect((await prediction.rounds(3)).totalAmount).to.equal(ether("9.7"));
    expect((await prediction.rounds(3)).bullAmount).to.equal(ether("6.3"));
    expect((await prediction.rounds(3)).bearAmount).to.equal(ether("3.4"));
    expect((await prediction.ledger(3, bullUser1.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(3, bullUser1.address)).amount).to.equal(ether("3.1"));
    expect((await prediction.ledger(3, bullUser2.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(3, bullUser2.address)).amount).to.equal(ether("3.2"));
    expect((await prediction.ledger(3, bearUser1.address)).position).to.equal(Position.Bear);
    expect((await prediction.ledger(3, bearUser1.address)).amount).to.equal(ether("3.4"));
    expectBigNumberArray((await prediction.getUserRounds(bullUser1.address, 0, 3))[0], [1, 2, 3]);
    expectBigNumberArray((await prediction.getUserRounds(bullUser2.address, 0, 3))[0], [1, 2, 3]);
    expectBigNumberArray((await prediction.getUserRounds(bearUser1.address, 0, 3))[0], [1, 2, 3]);
    expect(await prediction.getUserRoundsLength(bullUser1.address)).to.equal(3);

    // Epoch 4
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, {
      value: BigNumber.from(ether("4.1")),
    }); // Bull 4.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, {
      value: BigNumber.from(ether("4.2")),
    }); // Bull 4.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, {
      value: BigNumber.from(ether("4.4")),
    }); // Bear 4.4 ETH

    expect(await getBalance(prediction.address)).to.equal(ether("32.8"));
    expect((await prediction.rounds(4)).totalAmount).to.equal(ether("12.7"));
    expect((await prediction.rounds(4)).bullAmount).to.equal(ether("8.3"));
    expect((await prediction.rounds(4)).bearAmount).to.equal(ether("4.4"));
    expect((await prediction.ledger(4, bullUser1.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(4, bullUser1.address)).amount).to.equal(ether("4.1"));
    expect((await prediction.ledger(4, bullUser2.address)).position).to.equal(Position.Bull);
    expect((await prediction.ledger(4, bullUser2.address)).amount).to.equal(ether("4.2"));
    expect((await prediction.ledger(4, bearUser1.address)).position).to.equal(Position.Bear);
    expect((await prediction.ledger(4, bearUser1.address)).amount).to.equal(ether("4.4"));
    expectBigNumberArray((await prediction.getUserRounds(bullUser1.address, 0, 4))[0], [1, 2, 3, 4]);
    expectBigNumberArray((await prediction.getUserRounds(bullUser2.address, 0, 4))[0], [1, 2, 3, 4]);
    expectBigNumberArray((await prediction.getUserRounds(bearUser1.address, 0, 4))[0], [1, 2, 3, 4]);
    expect(await prediction.getUserRoundsLength(bullUser1.address)).to.equal(4);
  });

  it("8.Should not allow multiple bets", async () => {
    const { prediction, bullUser1, bearUser1 } = await loadFixture(deployPredictionFixture);
    // Epoch 1
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) }); // Success
    await expect(
      prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");
    await expect(
      prediction.connect(bullUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");

    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) }); // Success
    await expect(
      prediction.connect(bearUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");
    await expect(
      prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");

    // Epoch 2
    await nextEpoch();
    await prediction.genesisLockRound(); // For round 1
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) }); // Success
    await expect(
      prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");
    await expect(
      prediction.connect(bullUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");

    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) }); // Success
    await expect(
      prediction.connect(bearUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");
    await expect(
      prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Can only bet once per round");
  });

  it("9.Should not allow bets lesser than minimum bet amount", async () => {
    const { prediction, bullUser1, oracle } = await loadFixture(deployPredictionFixture);
    // Epoch 1
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await expect(
      prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("0.5")) })
    ).to.be.revertedWith("Bet amount must be greater than minBetAmount");
    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) }); // Success

    // Epoch 2
    await nextEpoch();
    await prediction.genesisLockRound(); // For round 1
    currentEpoch = await prediction.currentEpoch();

    await expect(
      prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("0.5")) })
    ).to.be.revertedWith("Bet amount must be greater than minBetAmount");
    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) }); // Success

    // Epoch 3
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await expect(
      prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("0.5")) })
    ).to.be.revertedWith("Bet amount must be greater than minBetAmount");
    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) }); // Success
  });

  it("10.Should record rewards", async () => {
    const { prediction, bullUser1, bullUser2, bearUser1, oracle } = await loadFixture(deployPredictionFixture);

    // Epoch 1
    const price110 = 11000000000; // $110
    await oracle.updateAnswer(price110);
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1.1")) }); // 1.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("1.2")) }); // 1.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1.4")) }); // 1.4 ETH

    expect((await prediction.rounds(1)).rewardBaseCalAmount).to.equal(0);
    expect((await prediction.rounds(1)).rewardAmount).to.equal(0);
    expect(await prediction.treasuryAmount()).to.equal(0);
    expect(await getBalance(prediction.address)).to.equal(ether("3.7"));

    // Epoch 2
    await nextEpoch();
    const price120 = 12000000000; // $120
    await oracle.updateAnswer(price120);
    await prediction.genesisLockRound(); // For round 1
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("2.1")) }); // 2.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("2.2")) }); // 2.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("2.4")) }); // 2.4 ETH

    expect((await prediction.rounds(1)).rewardBaseCalAmount).to.equal(0);
    expect((await prediction.rounds(1)).rewardAmount).to.equal(0);
    expect((await prediction.rounds(2)).rewardBaseCalAmount).to.equal(0);
    expect((await prediction.rounds(2)).rewardAmount).to.equal(0);
    expect(await prediction.treasuryAmount()).to.equal(0);
    expect(await getBalance(prediction.address)).to.equal(
      BigNumber.from(ether("3.7")).add(BigNumber.from(ether("6.7")))
    );

    // Epoch 3, Round 1 is Bull (130 > 120)
    await nextEpoch();
    const price130 = 13000000000; // $130
    await oracle.updateAnswer(price130);
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("3.1")) }); // 3.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("3.2")) }); // 3.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("3.4")) }); // 3.4 ETH

    expect((await prediction.rounds(1)).rewardBaseCalAmount).to.equal(BigNumber.from(ether("2.3"))); // 2.3 ETH, Bull total
    expect((await prediction.rounds(1)).rewardAmount).to.equal(
      BigNumber.from(ether("3.7")).mul(utils.parseUnits(INITIAL_REWARD_RATE.toString())).div(utils.parseUnits("1"))
    ); // 3.33 ETH, Total * rewardRate
    expect((await prediction.rounds(2)).rewardBaseCalAmount).to.equal(0);
    expect((await prediction.rounds(2)).rewardAmount).to.equal(0);
    expect(await prediction.treasuryAmount()).to.equal(
      BigNumber.from(ether("3.7")).mul(utils.parseUnits(INITIAL_TREASURY_RATE.toString())).div(utils.parseUnits("1"))
    ); // 3.7 ETH, Total * treasuryRate
    expect(await getBalance(prediction.address)).to.equal(
      BigNumber.from(ether("3.7"))
        .add(BigNumber.from(ether("6.7")))
        .add(BigNumber.from(ether("9.7")))
    );

    // Epoch 4, Round 2 is Bear (100 < 130)
    await nextEpoch();
    const price100 = 10000000000; // $100
    await oracle.updateAnswer(price100);
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("4.1")) }); // 4.1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("4.2")) }); // 4.2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("4.4")) }); // 4.4 ETH

    expect((await prediction.rounds(1)).rewardBaseCalAmount).to.equal(BigNumber.from(ether("2.3"))); // 2.3 ETH, Bull total
    expect((await prediction.rounds(1)).rewardAmount).to.equal(
      BigNumber.from(ether("3.7")).mul(utils.parseUnits(INITIAL_REWARD_RATE.toString())).div(utils.parseUnits("1"))
    ); // 3.33 ETH, Total * rewardRate
    expect((await prediction.rounds(2)).rewardBaseCalAmount).to.equal(BigNumber.from(ether("2.4"))); // 2.4 ETH, Bear total
    expect((await prediction.rounds(2)).rewardAmount).to.equal(
      BigNumber.from(ether("6.7")).mul(utils.parseUnits(INITIAL_REWARD_RATE.toString())).div(utils.parseUnits("1"))
    ); // 6.7 ETH, Total * rewardRate
    expect(await prediction.treasuryAmount()).to.equal(
      BigNumber.from(ether("3.7"))
        .add(BigNumber.from(ether("6.7")))
        .mul(utils.parseUnits(INITIAL_TREASURY_RATE.toString()))
        .div(utils.parseUnits("1"))
    ); // 10.4 ETH, Accumulative treasury
    expect(await getBalance(prediction.address)).to.equal(
      BigNumber.from(ether("3.7"))
        .add(BigNumber.from(ether("6.7")))
        .add(BigNumber.from(ether("9.7")))
        .add(BigNumber.from(ether("12.7")))
    );
  });

  it("11.Should not lock round before lockTimestamp", async () => {
    const { prediction, oracle } = await loadFixture(deployPredictionFixture);

    await prediction.genesisStartRound();
    await nextEpoch();
    await prediction.genesisLockRound();
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await prediction.executeRound();

    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await expect(prediction.executeRound()).to.be.revertedWith("Can only lock round after lockTimestamp");
    await nextEpoch();
    await prediction.executeRound(); // Success
  });

  it("12.Should claim rewards", async () => {
    const { prediction, oracle, bullUser1, bullUser2, bearUser1 } = await loadFixture(deployPredictionFixture);

    // Epoch 1
    const price110 = 11000000000; // $110
    await oracle.updateAnswer(price110);
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("1") }); // 1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("2") }); // 2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("4") }); // 4 ETH

    expect(await prediction.claimable(1, bullUser1.address)).to.equal(false);
    expect(await prediction.claimable(1, bullUser2.address)).to.equal(false);
    expect(await prediction.claimable(1, bearUser1.address)).to.equal(false);

    await expect(prediction.connect(bullUser1).claim([1])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bullUser2).claim([1])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bearUser1).claim([1])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bullUser1).claim([2])).to.be.revertedWith("Round has not started");
    await expect(prediction.connect(bullUser2).claim([2])).to.be.revertedWith("Round has not started");
    await expect(prediction.connect(bearUser1).claim([2])).to.be.revertedWith("Round has not started");

    // Epoch 2
    await nextEpoch();
    const price120 = 12000000000; // $120
    await oracle.updateAnswer(price120);
    await prediction.genesisLockRound(); // For round 1
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("21") }); // 21 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("22") }); // 22 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("24") }); // 24 ETH
    expect(await prediction.claimable(1, bullUser1.address)).to.equal(false);
    expect(await prediction.claimable(1, bullUser2.address)).to.equal(false);
    expect(await prediction.claimable(1, bearUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser2.address)).to.equal(false);
    expect(await prediction.claimable(2, bearUser1.address)).to.equal(false);
    await expect(prediction.connect(bullUser1).claim([1])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bullUser2).claim([1])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bearUser1).claim([1])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bullUser1).claim([2])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bullUser2).claim([2])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bearUser1).claim([2])).to.be.revertedWith("Round has not ended");

    // Epoch 3, Round 1 is Bull (130 > 120)
    await nextEpoch();
    const price130 = 13000000000; // $130
    await oracle.updateAnswer(price130);
    await prediction.executeRound();

    expect(await prediction.claimable(1, bullUser1.address)).to.equal(true);
    expect(await prediction.claimable(1, bullUser2.address)).to.equal(true);
    expect(await prediction.claimable(1, bearUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser2.address)).to.equal(false);
    expect(await prediction.claimable(2, bearUser1.address)).to.equal(false);

    // Claim for Round 1: Total rewards = 3.7, Bull = 2.3, Bear = 1.4
    const bullUser1BalanceBefore = await getBalance(bullUser1.address);
    const bullUser1Claim = await prediction.connect(bullUser1).claim([1]); // Success
    await expect(bullUser1Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bullUser1.address, BigNumber.from(1), BigNumber.from(ether("2.1")));
    const bullUser1ClaimReceipt = await bullUser1Claim.wait();
    const bullUser1BalanceAfter = await getBalance(bullUser1.address);
    let gasUsed = bullUser1ClaimReceipt.cumulativeGasUsed.mul(bullUser1ClaimReceipt.effectiveGasPrice);
    expect(BigNumber.from(bullUser1BalanceAfter).sub(bullUser1BalanceBefore)).to.equal(
      BigNumber.from(ether("2.1")).sub(gasUsed)
    );

    const bullUser2BalanceBefore = await getBalance(bullUser2.address);
    const bullUser2Claim = await prediction.connect(bullUser2).claim([1]); // Success
    await expect(bullUser2Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bullUser2.address, BigNumber.from(1), BigNumber.from(ether("4.2"))); // 4.2 = 2/3 * (7*0.9)
    const bullUser2ClaimReceipt = await bullUser2Claim.wait();
    const bullUser2BalanceAfter = await getBalance(bullUser2.address);
    gasUsed = bullUser2ClaimReceipt.cumulativeGasUsed.mul(bullUser2ClaimReceipt.effectiveGasPrice);
    expect(BigNumber.from(bullUser2BalanceAfter).sub(bullUser2BalanceBefore)).to.equal(
      BigNumber.from(ether("4.2")).sub(gasUsed)
    );
    await expect(prediction.connect(bearUser1).claim([1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser1).claim([2])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bullUser2).claim([2])).to.be.revertedWith("Round has not ended");
    await expect(prediction.connect(bearUser1).claim([2])).to.be.revertedWith("Round has not ended");

    // Epoch 4, Round 2 is Bear (100 < 130)
    await nextEpoch();
    const price100 = 10000000000; // $100
    await oracle.updateAnswer(price100);
    await prediction.executeRound();

    expect(await prediction.claimable(1, bullUser1.address)).to.equal(false); // User has claimed
    expect(await prediction.claimable(1, bullUser2.address)).to.equal(false); // User has claimed
    expect(await prediction.claimable(1, bearUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser2.address)).to.equal(false);
    expect(await prediction.claimable(2, bearUser1.address)).to.equal(true);

    // Claim for Round 2: Total rewards = 67, Bull = 43, Bear = 24
    const bearUser1BalanceBefore = await getBalance(bearUser1.address);
    const bearUser1Claim = await prediction.connect(bearUser1).claim([2]); // Success
    await expect(bearUser1Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bearUser1.address, BigNumber.from(2), BigNumber.from(ether("60.3"))); // 24 = 24/24 * (67*0.9)
    const bearUser1ClaimReceipt = await bearUser1Claim.wait();
    const bearUser1BalanceAfter = await getBalance(bearUser1.address);
    gasUsed = bearUser1ClaimReceipt.cumulativeGasUsed.mul(bearUser1ClaimReceipt.effectiveGasPrice);
    expect(BigNumber.from(bearUser1BalanceAfter).sub(bearUser1BalanceBefore)).to.equal(
      BigNumber.from(ether("60.3")).sub(gasUsed)
    );

    await expect(prediction.connect(bullUser1).claim([1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser2).claim([1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bearUser1).claim([1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser1).claim([2])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser2).claim([2])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bearUser1).claim([2])).to.be.revertedWith("Not eligible for claim");
  });

  it("13.Should multi claim rewards", async () => {
    const { prediction, oracle, bullUser1, bullUser2, bearUser1 } = await loadFixture(deployPredictionFixture);

    // Epoch 1
    const price110 = 11000000000; // $110
    await oracle.updateAnswer(price110);
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("1") }); // 1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("2") }); // 2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("4") }); // 4 ETH

    expect(await prediction.claimable(1, bullUser1.address)).to.equal(false);
    expect(await prediction.claimable(1, bullUser2.address)).to.equal(false);
    expect(await prediction.claimable(1, bearUser1.address)).to.equal(false);

    // Epoch 2
    await nextEpoch();
    const price120 = 12000000000; // $120
    await oracle.updateAnswer(price120);
    await prediction.genesisLockRound(); // For round 1
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("21") }); // 21 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("22") }); // 22 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("24") }); // 24 ETH

    // Epoch 3, Round 1 is Bull (130 > 120)
    await nextEpoch();
    const price130 = 13000000000; // $130
    await oracle.updateAnswer(price130);
    await prediction.executeRound();

    expect(await prediction.claimable(1, bullUser1.address)).to.equal(true);
    expect(await prediction.claimable(1, bullUser2.address)).to.equal(true);
    expect(await prediction.claimable(1, bearUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser2.address)).to.equal(false);
    expect(await prediction.claimable(2, bearUser1.address)).to.equal(false);

    // Epoch 4, Round 2 is Bull (140 > 130)
    await nextEpoch();
    const price140 = 14000000000; // $140
    await oracle.updateAnswer(price140);
    await prediction.executeRound();

    expect(await prediction.claimable(1, bullUser1.address)).to.equal(true);
    expect(await prediction.claimable(1, bullUser2.address)).to.equal(true);
    expect(await prediction.claimable(1, bearUser1.address)).to.equal(false);
    expect(await prediction.claimable(2, bullUser1.address)).to.equal(true);
    expect(await prediction.claimable(2, bullUser2.address)).to.equal(true);
    expect(await prediction.claimable(2, bearUser1.address)).to.equal(false);

    await expect(prediction.connect(bullUser1).claim([2, 2])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser1).claim([1, 1])).to.be.revertedWith("Not eligible for claim");

    const bullUser1BalanceBefore = await getBalance(bullUser1.address);
    const bullUser1Claim = await prediction.connect(bullUser1).claim([1, 2]); // Success
    // 2.1 = 1/3 * (7*0.9) + // 29.4488372093 = 21 / 43 * (67 * 0.9) = 29.448837209302325581
    await expect(bullUser1Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bullUser1.address, BigNumber.from(1), BigNumber.from(ether("2.1")));
    const bullUser1ClaimReceipt = await bullUser1Claim.wait();

    // Manual event handling for second event with same name from the same contract
    expect(bullUser1ClaimReceipt.events?.[1].event).to.equal("Claim");
    expect(bullUser1ClaimReceipt.events?.[1].args?.sender).to.equal(bullUser1.address);
    expect(bullUser1ClaimReceipt.events?.[1].args?.epoch).to.equal(2);
    expect(bullUser1ClaimReceipt.events?.[1].args?.amount).to.equal(BigNumber.from(ether("29.448837209302325581")));

    const bullUser1BalanceAfter = await getBalance(bullUser1.address);
    expect(BigNumber.from(bullUser1BalanceAfter).sub(bullUser1BalanceBefore)).to.equal(
      BigNumber.from(ether("31.548837209302325581")).sub(
        bullUser1ClaimReceipt.cumulativeGasUsed.mul(bullUser1ClaimReceipt.effectiveGasPrice)
      )
    );

    const bullUser2BalanceBefore = await getBalance(bullUser2.address);
    const bullUser2Claim = await prediction.connect(bullUser2).claim([1, 2]); // Success
    // 4.2 = 2/3 * (7*0.9) + // 30.851162790697674418 = 22 / 43 * (67 * 0.9) = 35.051162790697674418
    await expect(bullUser2Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bullUser2.address, BigNumber.from(1), BigNumber.from(ether("4.2")));
    const bullUser2ClaimReceipt = await bullUser2Claim.wait();

    expect(bullUser2ClaimReceipt.events?.[1].event).to.equal("Claim");
    expect(bullUser2ClaimReceipt.events?.[1].args?.sender).to.equal(bullUser2.address);
    expect(bullUser2ClaimReceipt.events?.[1].args?.epoch).to.equal(2);
    expect(bullUser2ClaimReceipt.events?.[1].args?.amount).to.equal(BigNumber.from(ether("30.851162790697674418")));

    const bullUser2BalanceAfter = await getBalance(bullUser2.address);
    expect(BigNumber.from(bullUser2BalanceAfter).sub(bullUser2BalanceBefore)).to.equal(
      BigNumber.from(ether("35.051162790697674418")).sub(
        bullUser2ClaimReceipt.cumulativeGasUsed.mul(bullUser2ClaimReceipt.effectiveGasPrice)
      )
    );

    await expect(prediction.connect(bullUser1).claim([1, 2])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser1).claim([2, 1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser2).claim([1, 2])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser2).claim([2, 1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser1).claim([1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser1).claim([2])).to.be.revertedWith("Not eligible for claim");
  });

  it("14.Should record house wins", async () => {
    const { prediction, oracle, bullUser1, bullUser2, bearUser1 } = await loadFixture(deployPredictionFixture);

    // Epoch 1
    const price110 = 11000000000; // $110
    await oracle.updateAnswer(price110);
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("1") }); // 1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("2") }); // 2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("4") }); // 4 ETH

    // Epoch 2
    await nextEpoch();
    await oracle.updateAnswer(price110);
    await prediction.genesisLockRound(); // For round 1

    // Epoch 3, Round 1 is Same (110 == 110), House wins
    await nextEpoch();
    await oracle.updateAnswer(price110);
    await prediction.executeRound();

    await expect(prediction.connect(bullUser1).claim([1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bullUser2).claim([1])).to.be.revertedWith("Not eligible for claim");
    await expect(prediction.connect(bearUser1).claim([1])).to.be.revertedWith("Not eligible for claim");
    expect(await prediction.treasuryAmount()).to.equal(BigNumber.from(ether("7"))); // 7 = 1+2+4
  });

  it("15.Should claim treasury rewards", async () => {
    const { prediction, admin, oracle, bullUser1, bullUser2, bearUser1 } = await loadFixture(deployPredictionFixture);

    let predictionCurrentBalance = BigNumber.from(ether("0"));

    expect(await getBalance(prediction.address)).to.equal(predictionCurrentBalance);

    // Epoch 1
    const price110 = 11000000000; // $110
    await oracle.updateAnswer(price110);
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("1") }); // 1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("2") }); // 2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("4") }); // 4 ETH
    predictionCurrentBalance = predictionCurrentBalance.add(BigNumber.from(ether("7")));

    expect(await prediction.treasuryAmount()).to.equal(0);
    expect(await getBalance(prediction.address)).to.equal(predictionCurrentBalance);

    // Epoch 2
    await nextEpoch();
    const price120 = 12000000000; // $120
    await oracle.updateAnswer(price120);
    await prediction.genesisLockRound(); // For round 1
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("21") }); // 21 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("22") }); // 22 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("24") }); // 24 ETH
    predictionCurrentBalance = predictionCurrentBalance.add(BigNumber.from(ether("67")));

    expect(await prediction.treasuryAmount()).to.equal(0);
    expect(await getBalance(prediction.address)).to.equal(predictionCurrentBalance);

    // Epoch 3, Round 1 is Bull (130 > 120)
    await nextEpoch();
    const price130 = 13000000000; // $130
    await oracle.updateAnswer(price130);
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: ether("31") }); // 21 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: ether("32") }); // 22 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: ether("34") }); // 24 ETH
    predictionCurrentBalance = predictionCurrentBalance.add(BigNumber.from(ether("97")));

    // Admin claim for Round 1
    expect(await getBalance(prediction.address)).to.equal(predictionCurrentBalance);
    expect(await prediction.treasuryAmount()).to.equal(BigNumber.from(ether("0.7"))); // 0.7 = 7 * 0.1

    let adminBalanceBefore = await getBalance(admin.address);
    let adminClaimTreasury = await prediction.connect(admin).claimTreasury(); // Success
    await expect(adminClaimTreasury)
      .to.emit(prediction, "TreasuryClaim")
      .withArgs(BigNumber.from(ether("0.7")));
    let adminClaimTreasuryReceipt = await adminClaimTreasury.wait();
    let adminBalanceAfter = await getBalance(admin.address);
    let adminClaimTreasuryGasCost = adminClaimTreasuryReceipt.cumulativeGasUsed.mul(
      adminClaimTreasuryReceipt.effectiveGasPrice
    );
    expect(BigNumber.from(adminBalanceAfter).sub(adminBalanceBefore)).to.equal(
      BigNumber.from(ether("0.7")).sub(adminClaimTreasuryGasCost)
    );
    expect(await prediction.treasuryAmount()).to.equal(0); // Empty
    predictionCurrentBalance = predictionCurrentBalance.sub(BigNumber.from(ether("0.7")));
    expect(await getBalance(prediction.address)).to.equal(predictionCurrentBalance);

    // Epoch 4
    await nextEpoch();
    const price140 = 14000000000; // $140
    await oracle.updateAnswer(price140); // Prevent house from winning
    await prediction.executeRound();

    expect(await prediction.treasuryAmount()).to.equal(BigNumber.from(ether("6.7"))); // 6.7 = (21+22+24) * 0.1

    // Epoch 5
    await nextEpoch();
    const price150 = 15000000000; // $150
    await oracle.updateAnswer(price150); // Prevent house from winning
    await prediction.executeRound();

    // Admin claim for Round 1 and 2
    expect(await prediction.treasuryAmount()).to.equal(BigNumber.from(ether("6.7")).add(BigNumber.from(ether("9.7")))); // 9.7 = (31+32+34) * 0.1
    adminBalanceBefore = await getBalance(admin.address);
    adminClaimTreasury = await prediction.connect(admin).claimTreasury(); // Success
    await expect(adminClaimTreasury)
      .to.emit(prediction, "TreasuryClaim")
      .withArgs(BigNumber.from(ether("16.4"))); // 16.4 = 6.7 + 9.7
    adminClaimTreasuryReceipt = await adminClaimTreasury.wait();
    adminBalanceAfter = await getBalance(admin.address);
    adminClaimTreasuryGasCost = adminClaimTreasuryReceipt.cumulativeGasUsed.mul(
      adminClaimTreasuryReceipt.effectiveGasPrice
    );
    expect(BigNumber.from(adminBalanceAfter).sub(adminBalanceBefore)).to.equal(
      BigNumber.from(ether("16.4")).sub(adminClaimTreasuryGasCost)
    );
    expect(await prediction.treasuryAmount()).to.equal(0); // Empty
    predictionCurrentBalance = predictionCurrentBalance.sub(BigNumber.from(ether("16.4")));
    expect(await getBalance(prediction.address)).to.equal(predictionCurrentBalance);
  });

  it("16.Admin/Owner function work as expected", async () => {
    const { prediction, admin, oracle, owner } = await loadFixture(deployPredictionFixture);

    await prediction.connect(admin).pause();
    const setBufferAndIntervalSeconds = await prediction.connect(admin).setBufferAndIntervalSeconds(50, 100);
    await expect(setBufferAndIntervalSeconds)
      .to.emit(prediction, "NewBufferAndIntervalSeconds")
      .withArgs(BigNumber.from(50), BigNumber.from(100));

    await expect(prediction.connect(admin).setBufferAndIntervalSeconds(100, 99)).to.be.revertedWith(
      "bufferSeconds must be inferior to intervalSeconds"
    );

    await expect(prediction.connect(admin).setBufferAndIntervalSeconds(100, 100)).to.be.revertedWith(
      "bufferSeconds must be inferior to intervalSeconds"
    );

    const setMinBetAmount = await prediction.connect(admin).setMinBetAmount(50);
    await expect(setMinBetAmount).to.emit(prediction, "NewMinBetAmount").withArgs(0, BigNumber.from(50));
    await expect(prediction.connect(admin).setMinBetAmount(0)).to.be.revertedWith("Must be superior to 0");

    const setOperator = await prediction.connect(admin).setOperator(admin.address);
    await expect(setOperator).to.emit(prediction, "NewOperatorAddress").withArgs(admin.address);
    await expect(prediction.connect(admin).setOperator(constants.AddressZero)).to.be.revertedWith(
      "Cannot be zero address"
    );

    const setOracle = await prediction.connect(admin).setOracle(oracle.address);
    await expect(setOracle).to.emit(prediction, "NewOracle").withArgs(oracle.address);
    await expect(prediction.connect(admin).setOracle(constants.AddressZero)).to.be.revertedWith(
      "Cannot be zero address"
    );

    // Sanity checks for oracle interface implementation
    // EOA
    await expect(prediction.connect(admin).setOracle(admin.address)).to.be.rejectedWith(
      // why not? "function call to a non-contract account"
      "function returned an unexpected amount of data"
    );
    // Other contract
    await expect(prediction.connect(admin).setOracle(prediction.address)).to.be.rejectedWith(
      "function selector was not recognized and there's no fallback function"
    );

    const setOracleUpdateAllowance = await prediction.connect(admin).setOracleUpdateAllowance(30);
    await expect(setOracleUpdateAllowance).to.emit(prediction, "NewOracleUpdateAllowance").withArgs(BigNumber.from(30));

    const setTreasuryFee = await prediction.connect(admin).setTreasuryFee(300);
    await expect(setTreasuryFee).to.emit(prediction, "NewTreasuryFee").withArgs(0, BigNumber.from(300));
    await expect(prediction.connect(admin).setTreasuryFee(3000)).to.be.revertedWith("Treasury fee too high");

    const setAdmin = await prediction.connect(owner).setAdmin(owner.address);
    await expect(setAdmin).to.emit(prediction, "NewAdminAddress").withArgs(owner.address);
    await expect(prediction.connect(owner).setAdmin(constants.AddressZero)).to.be.revertedWith(
      "Cannot be zero address"
    );
  });

  it("17.Should reject operator functions when not operator", async () => {
    const { prediction, admin } = await loadFixture(deployPredictionFixture);
    await expect(prediction.connect(admin).genesisLockRound()).to.be.revertedWith("Not operator");
    await expect(prediction.connect(admin).genesisStartRound()).to.be.revertedWith("Not operator");
    await expect(prediction.connect(admin).executeRound()).to.be.revertedWith("Not operator");
  });

  it("18.Should reject admin/owner functions when not admin/owner", async () => {
    const { prediction, admin, bullUser1, bearUser1 } = await loadFixture(deployPredictionFixture);
    await expect(prediction.connect(bullUser1).claimTreasury()).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).pause()).to.be.revertedWith("Not operator/admin");
    await prediction.connect(admin).pause();
    await expect(prediction.connect(bullUser1).unpause()).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).setBufferAndIntervalSeconds(50, 100)).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).setMinBetAmount(0)).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).setOperator(bearUser1.address)).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).setOracle(bearUser1.address)).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).setOracleUpdateAllowance(0)).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).setTreasuryFee(100)).to.be.revertedWith("Not admin");
    await expect(prediction.connect(bullUser1).unpause()).to.be.revertedWith("Not admin");
    await prediction.connect(admin).unpause();
    await expect(prediction.connect(admin).setAdmin(admin.address), "Ownable: caller is not the owner1");
    await expect(prediction.connect(bullUser1).setAdmin(bullUser1.address), "Ownable: caller is not the owner");
  });

  it("19.Should reject admin/owner functions when not paused", async () => {
    const { prediction, admin, bearUser1 } = await loadFixture(deployPredictionFixture);
    await expect(prediction.connect(admin).setBufferAndIntervalSeconds(50, 100)).to.be.revertedWith(
      "Pausable: not paused"
    );
    await expect(prediction.connect(admin).setMinBetAmount(0)).to.be.revertedWith("Pausable: not paused");
    await expect(prediction.connect(admin).setOracle(bearUser1.address)).to.be.revertedWith("Pausable: not paused");
    await expect(prediction.connect(admin).setOracleUpdateAllowance(0)).to.be.revertedWith("Pausable: not paused");
    await expect(prediction.connect(admin).setTreasuryFee(100)).to.be.revertedWith("Pausable: not paused");
    await expect(prediction.connect(admin).unpause()).to.be.revertedWith("Pausable: not paused");
  });

  it("20.Should refund rewards", async () => {
    const { prediction, oracle, bullUser1, bullUser2, bearUser1 } = await loadFixture(deployPredictionFixture);

    // Epoch 1
    const price110 = 11000000000; // $110
    await oracle.updateAnswer(price110);
    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) }); // 1 ETH
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("2")) }); // 2 ETH
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("4")) }); // 4 ETH

    expect(await prediction.refundable(1, bullUser1.address)).to.equal(false);
    expect(await prediction.refundable(1, bullUser2.address)).to.equal(false);
    expect(await prediction.refundable(1, bearUser1.address)).to.equal(false);
    expect(await prediction.treasuryAmount()).to.equal(0);
    expect(await getBalance(prediction.address)).to.equal(BigNumber.from(ether("7")));

    // Epoch 2
    await nextEpoch();
    await prediction.genesisLockRound();
    currentEpoch = await prediction.currentEpoch();

    expect(await prediction.refundable(1, bullUser1.address)).to.equal(false);
    expect(await prediction.refundable(1, bullUser2.address)).to.equal(false);
    expect(await prediction.refundable(1, bearUser1.address)).to.equal(false);

    // Epoch 3 (missed)
    await nextEpoch();

    // Epoch 4
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await expect(prediction.executeRound()).to.be.revertedWith("Can only lock round within bufferSeconds");

    // Refund for Round 1
    expect(await prediction.refundable(1, bullUser1.address)).to.equal(true);
    expect(await prediction.refundable(1, bullUser2.address)).to.equal(true);
    expect(await prediction.refundable(1, bearUser1.address)).to.equal(true);

    const bullUser1BalanceBefore = await getBalance(bullUser1.address);
    const bullUser1Claim = await prediction.connect(bullUser1).claim([1]); // Success
    await expect(bullUser1Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bullUser1.address, 1, BigNumber.from(ether("1"))); // 1, 100% of bet amount
    const bullUser1ClaimReceipt = await bullUser1Claim.wait();
    const bullUser1BalanceAfter = await getBalance(bullUser1.address);
    let gasUsed = bullUser1ClaimReceipt.cumulativeGasUsed.mul(bullUser1ClaimReceipt.effectiveGasPrice);
    expect(BigNumber.from(bullUser1BalanceAfter).sub(bullUser1BalanceBefore)).to.equal(
      BigNumber.from(ether("1")).sub(gasUsed)
    );

    const bullUser2BalanceBefore = await getBalance(bullUser2.address);
    const bullUser2Claim = await prediction.connect(bullUser2).claim([1]); // Success
    await expect(bullUser2Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bullUser2.address, 1, BigNumber.from(ether("2"))); // 2, 100% of bet amount
    const bullUser2ClaimReceipt = await bullUser2Claim.wait();
    const bullUser2BalanceAfter = await getBalance(bullUser2.address);
    gasUsed = bullUser2ClaimReceipt.cumulativeGasUsed.mul(bullUser2ClaimReceipt.effectiveGasPrice);
    expect(BigNumber.from(bullUser2BalanceAfter).sub(bullUser2BalanceBefore)).to.equal(
      BigNumber.from(ether("2")).sub(gasUsed)
    );

    const bearUser1BalanceBefore = await getBalance(bearUser1.address);
    const bearUser1Claim = await prediction.connect(bearUser1).claim([1]); // Success
    await expect(bearUser1Claim)
      .to.emit(prediction, "Claim")
      .withArgs(bearUser1.address, 1, BigNumber.from(ether("4"))); // 4, 100% of bet amount
    const bearUser1ClaimReceipt = await bearUser1Claim.wait();
    const bearUser1BalanceAfter = await getBalance(bearUser1.address);
    gasUsed = bearUser1ClaimReceipt.cumulativeGasUsed.mul(bearUser1ClaimReceipt.effectiveGasPrice);
    expect(BigNumber.from(bearUser1BalanceAfter).sub(bearUser1BalanceBefore)).to.equal(
      BigNumber.from(ether("4")).sub(gasUsed)
    );

    await expect(prediction.connect(bullUser1).claim([1])).to.be.revertedWith("Not eligible for refund");
    await expect(prediction.connect(bullUser2).claim([1])).to.be.revertedWith("Not eligible for refund");
    await expect(prediction.connect(bearUser1).claim([1])).to.be.revertedWith("Not eligible for refund");

    // Treasury amount should be empty
    expect(await prediction.treasuryAmount()).to.equal(0);
    expect(await getBalance(prediction.address)).to.equal(0);
  });

  it("21.Rejections for bet bulls/bears work as expected", async () => {
    const { prediction, oracle, bullUser1 } = await loadFixture(deployPredictionFixture);
    // Epoch 0
    await expect(prediction.connect(bullUser1).betBull(0, { value: BigNumber.from(ether("1")) })).to.be.revertedWith(
      "Round not bettable"
    );
    await expect(prediction.connect(bullUser1).betBear(0, { value: BigNumber.from(ether("1")) })).to.be.revertedWith(
      "Round not bettable"
    );
    await expect(prediction.connect(bullUser1).betBull(1, { value: BigNumber.from(ether("1")) })).to.be.revertedWith(
      "Bet is too early/late"
    );
    await expect(prediction.connect(bullUser1).betBear(1, { value: BigNumber.from(ether("1")) })).to.be.revertedWith(
      "Bet is too early/late"
    );

    // Epoch 1
    const price110 = 11000000000; // $110
    await oracle.updateAnswer(price110);
    await prediction.genesisStartRound();
    await expect(prediction.connect(bullUser1).betBull(2, { value: BigNumber.from(ether("1")) })).to.be.revertedWith(
      "Bet is too early/late"
    );
    await expect(prediction.connect(bullUser1).betBear(2, { value: BigNumber.from(ether("1")) })).to.be.revertedWith(
      "Bet is too early/late"
    );

    // Bets must be higher (or equal) than minBetAmount
    await expect(
      prediction.connect(bullUser1).betBear(1, { value: BigNumber.from(ether("0.999999")) })
    ).to.be.revertedWith("Bet amount must be greater than minBetAmount");
    await expect(
      prediction.connect(bullUser1).betBull(1, { value: BigNumber.from(ether("0.999999")) })
    ).to.be.revertedWith("Bet amount must be greater than minBetAmount");
  });

  it("22.Rejections for genesis start and lock rounds work as expected", async () => {
    const { prediction, oracle, admin } = await loadFixture(deployPredictionFixture);

    await expect(prediction.executeRound()).to.be.revertedWith(
      "Can only run after genesisStartRound and genesisLockRound is triggered"
    );

    // Epoch 1
    await prediction.genesisStartRound();
    await expect(prediction.genesisStartRound()).to.be.revertedWith("Can only run genesisStartRound once");
    await expect(prediction.genesisLockRound()).to.be.revertedWith("Can only lock round after lockTimestamp");

    // Advance to next epoch
    await nextEpoch();
    await nextEpoch();

    await expect(prediction.genesisLockRound()).to.be.revertedWith("Can only lock round within bufferSeconds");

    await expect(prediction.executeRound()).to.be.revertedWith(
      "Can only run after genesisStartRound and genesisLockRound is triggered"
    );

    // Cannot restart genesis round
    await expect(prediction.genesisStartRound()).to.be.revertedWith("Can only run genesisStartRound once");

    // Admin needs to pause, then unpause
    await prediction.connect(admin).pause();
    await prediction.connect(admin).unpause();

    // Prediction restart
    await prediction.genesisStartRound();

    await nextEpoch();

    // Lock the round
    await prediction.genesisLockRound();
    await nextEpoch();
    await expect(prediction.genesisLockRound()).to.be.revertedWith("Can only run genesisLockRound once");

    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await expect(prediction.executeRound()).to.be.revertedWith("Can only lock round within bufferSeconds");
  });

  it("23.Should prevent betting when paused", async () => {
    const { prediction, oracle, admin, bullUser1, bearUser1 } = await loadFixture(deployPredictionFixture);

    await prediction.genesisStartRound();
    await nextEpoch();
    await prediction.genesisLockRound();
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE); // To update Oracle roundId
    await prediction.executeRound();
    let currentEpoch = await prediction.currentEpoch();

    const tx = await prediction.connect(admin).pause();
    await expect(tx).to.emit(prediction, "Pause").withArgs(BigNumber.from(3));

    await expect(
      prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Pausable: paused");
    await expect(
      prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) })
    ).to.be.revertedWith("Pausable: paused");
    await expect(prediction.connect(bullUser1).claim([1])).to.be.revertedWith("Not eligible for claim"); // Success
  });

  it("24.Should prevent round operations when paused", async () => {
    const { prediction, oracle, admin } = await loadFixture(deployPredictionFixture);

    await prediction.genesisStartRound();
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.genesisLockRound();
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.executeRound();

    let tx = await prediction.connect(admin).pause();
    await expect(tx).to.emit(prediction, "Pause").withArgs(BigNumber.from(3));
    await expect(prediction.executeRound()).to.be.revertedWith("Pausable: paused");
    await expect(prediction.genesisStartRound()).to.be.revertedWith("Pausable: paused");
    await expect(prediction.genesisLockRound()).to.be.revertedWith("Pausable: paused");

    // Unpause and resume
    await nextEpoch(); // Goes to next epoch block number, but doesn't increase currentEpoch
    tx = await prediction.connect(admin).unpause();
    await expect(tx).to.emit(prediction, "Unpause").withArgs(BigNumber.from(3)); // Although nextEpoch is called, currentEpoch doesn't change

    await prediction.genesisStartRound(); // Success
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.genesisLockRound(); // Success
    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.executeRound(); // Success
  });

  it("25.Should paginate user rounds", async () => {
    const { prediction, oracle, bullUser1, bullUser2, bearUser1 } = await loadFixture(deployPredictionFixture);

    await prediction.genesisStartRound();
    let currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) });

    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.genesisLockRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) });

    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });
    await prediction.connect(bearUser1).betBear(currentEpoch, { value: BigNumber.from(ether("1")) });

    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });
    await prediction.connect(bullUser2).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });

    await nextEpoch();
    await oracle.updateAnswer(INITIAL_PRICE);
    await prediction.executeRound();
    currentEpoch = await prediction.currentEpoch();

    await prediction.connect(bullUser1).betBull(currentEpoch, { value: BigNumber.from(ether("1")) });

    // Get by page size of 2
    const pageSize = 2;

    expectBigNumberArray((await prediction.getUserRounds(bullUser1.address, 0, 5))[0], [1, 2, 3, 4, 5]);

    let result = await prediction.getUserRounds(bullUser1.address, 0, pageSize);
    let epochData = result[0];
    let positionData = result[1];
    let cursor = result[2];
    expectBigNumberArray(epochData, [1, 2]);
    expect(positionData[0]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(positionData[1]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(cursor).to.equal(2);

    result = await prediction.getUserRounds(bullUser1.address, cursor, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, [3, 4]);
    expect(positionData[0]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(positionData[1]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(cursor).to.equal(4);

    result = await prediction.getUserRounds(bullUser1.address, cursor, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, [5]);
    expect(positionData[0]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(cursor).to.equal(5);

    result = await prediction.getUserRounds(bullUser1.address, cursor, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, []);
    expect(positionData).to.be.empty;
    expect(cursor).to.equal(5);

    expectBigNumberArray((await prediction.getUserRounds(bullUser2.address, 0, 4))[0], [1, 2, 3, 4]);
    result = await prediction.getUserRounds(bullUser2.address, 0, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, [1, 2]);
    expect(positionData[0]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(positionData[1]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(cursor).to.equal(2);

    result = await prediction.getUserRounds(bullUser2.address, cursor, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, [3, 4]);
    expect(positionData[0]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(positionData[1]).to.deep.include.ordered.members([0, BigNumber.from("1000000000000000000"), false]);
    expect(cursor).to.equal(4);

    result = await prediction.getUserRounds(bullUser2.address, cursor, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, []);
    expect(positionData).to.be.empty;
    expect(cursor).to.equal(4);

    expectBigNumberArray((await prediction.getUserRounds(bearUser1.address, 0, 3))[0], [1, 2, 3]);
    result = await prediction.getUserRounds(bearUser1.address, 0, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, [1, 2]);
    expect(positionData[0]).to.deep.include.ordered.members([1, BigNumber.from("1000000000000000000"), false]);
    expect(positionData[1]).to.deep.include.ordered.members([1, BigNumber.from("1000000000000000000"), false]);
    expect(cursor).to.equal(2);

    result = await prediction.getUserRounds(bearUser1.address, cursor, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, [3]);
    expect(positionData[0]).to.deep.include.ordered.members([1, BigNumber.from("1000000000000000000"), false]);
    expect(cursor).to.equal(3);

    result = await prediction.getUserRounds(bearUser1.address, cursor, pageSize);
    epochData = result[0];
    positionData = result[1];
    cursor = result[2];
    expectBigNumberArray(epochData, []);
    expect(positionData).to.be.empty;
    expect(cursor).to.equal(3);
  });
});
