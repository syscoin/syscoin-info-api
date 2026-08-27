class CONFIGURATION {
  constructor() {
    // If set, pin this address and skip the Bridge V2 height switch.
    this.SyscoinVaultManager = process.env.SYSCOIN_VAULT_MANAGER || null;
    this.SyscoinVaultManagerLegacy = "0x7904299b3D3dC1b03d1DdEb45E9fDF3576aCBd5f";
    this.SyscoinVaultManagerV2 = "0x28bD37C0926575f2568ea8f297c0745EF16174Ab";
    this.BridgeV2StartBlock = 2292816;
  }
}

module.exports = new CONFIGURATION();
