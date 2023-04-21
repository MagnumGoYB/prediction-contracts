export default {
  Address: {
    Oracle: {
      mainnet: "0x0000000000000000000000000000000000000000",
      testnet: "0xD4a33860578De61DBAbDc8BFdb98FD742fA7028e",
    },
    Admin: {
      mainnet: "0x0000000000000000000000000000000000000000",
      testnet: "0x0000000000000000000000000000000000000000",
    },
    Operator: {
      mainnet: "0x0000000000000000000000000000000000000000",
      testnet: "0x0000000000000000000000000000000000000000",
    },
  },
  Block: {
    Interval: {
      mainnet: 300,
      testnet: 300,
    },
    Buffer: {
      mainnet: 15,
      testnet: 15,
    },
  },
  Treasury: {
    mainnet: 300, // 3%
    testnet: 1000, // 10%
  },
  BetAmount: {
    mainnet: 0.001,
    testnet: 0.001,
  },
  OracleUpdateAllowance: {
    mainnet: 300,
    testnet: 300,
  },
};
