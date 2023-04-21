import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { ethers, web3 } from "hardhat";
import { BigNumber } from "ethers";

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
    const { prediction, bullUser1, bullUser2, bearUser1, bearUser2 } = await loadFixture(deployPredictionFixture);
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

    // assert.equal((await balance.current(prediction.address)).toString(), ether("3.7").toString()); // 3.7 BNB
    // assert.equal((await prediction.rounds(1)).totalAmount, ether("3.7").toString()); // 3.7 BNB
    // assert.equal((await prediction.rounds(1)).bullAmount, ether("2.3").toString()); // 2.3 BNB
    // assert.equal((await prediction.rounds(1)).bearAmount, ether("1.4").toString()); // 1.4 BNB
    // assert.equal((await prediction.ledger(1, bullUser1)).position, Position.Bull);
    // assert.equal((await prediction.ledger(1, bullUser1)).amount, ether("1.1").toString());
    // assert.equal((await prediction.ledger(1, bullUser2)).position, Position.Bull);
    // assert.equal((await prediction.ledger(1, bullUser2)).amount, ether("1.2").toString());
    // assert.equal((await prediction.ledger(1, bearUser1)).position, Position.Bear);
    // assert.equal((await prediction.ledger(1, bearUser1)).amount, ether("1.4").toString());
    // assertBNArray((await prediction.getUserRounds(bullUser1, 0, 1))[0], [1]);
    // assertBNArray((await prediction.getUserRounds(bullUser2, 0, 1))[0], [1]);
    // assertBNArray((await prediction.getUserRounds(bearUser1, 0, 1))[0], [1]);
    // assert.equal(await prediction.getUserRoundsLength(bullUser1), 1);
  });
});
