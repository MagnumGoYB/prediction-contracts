import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, web3 } from "hardhat";
import { BigNumber, utils } from "ethers";

const ether = (val: string) => web3.utils.toWei(val, "ether");

const GAS_PRICE = 8000000000; // hardhat default
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

const expectBigNumberArray = (arr1: any[], arr2: any | any[]) => {
  expect(arr1.length).to.equal(arr2.length);
  arr1.forEach((n1, index) => {
    expect(n1.toString()).to.equal(BigNumber.from(arr2[index]).toString());
  });
};

describe("Prediction", function () {
  async function deployPredictionFixture() {
    const [operator, admin, owner, bullUser1, bullUser2, bearUser1, bearUser2] = await ethers.getSigners();

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
    expect(await ethers.provider.getBalance(prediction.address)).to.equal(0);
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
    expect(await prediction.genesisStartRound())
      .to.emit(prediction, "StartRound")
      .withArgs(BigNumber.from(1));
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
    expect(await prediction.genesisLockRound())
      .to.emit(prediction, "LockRound")
      .withArgs({
        epoch: BigNumber.from(1),
        roundId: BigNumber.from(1),
        price: BigNumber.from(INITIAL_PRICE),
      })
      .to.emit(prediction, "StartRound")
      .withArgs({ epoch: BigNumber.from(2) });
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

    expect(await prediction.executeRound()) // Oracle update and execute round
      .to.emit(prediction, "EndRound")
      .withArgs({
        epoch: BigNumber.from(1),
        roundId: BigNumber.from(2),
        price: BigNumber.from(INITIAL_PRICE),
      })
      .to.emit(prediction, "LockRound")
      .withArgs({
        epoch: BigNumber.from(2),
        roundId: BigNumber.from(2),
        price: BigNumber.from(INITIAL_PRICE),
      })
      .to.emit(prediction, "StartRound")
      .withArgs({ epoch: BigNumber.from(3) });

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

    expect(await ethers.provider.getBalance(prediction.address)).to.equal(ether("3.7"));
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

    expect(await ethers.provider.getBalance(prediction.address)).to.equal(ether("10.4"));
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

    expect(await ethers.provider.getBalance(prediction.address)).to.equal(ether("20.1"));
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

    expect(await ethers.provider.getBalance(prediction.address)).to.equal(ether("32.8"));
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
    expect(await ethers.provider.getBalance(prediction.address)).to.equal(ether("3.7"));

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
    expect(await ethers.provider.getBalance(prediction.address)).to.equal(
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
    expect(await ethers.provider.getBalance(prediction.address)).to.equal(
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
    expect(await ethers.provider.getBalance(prediction.address)).to.equal(
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
});
