require("dotenv").config({ path: `${__dirname}/config/env` });
const axios = require('axios');
const express = require("express");
const app = express();
const port = process.env.PORT || 3000;
const CONFIGURATION = require("./config");
const TOTAL_SUPPLY_URLS = [
  process.env.TOTAL_SUPPLY_URL ||
    "https://explorer1.syscoin.org/api?module=stats&action=coinsupply",
  process.env.TOTAL_SUPPLY_URL_BACKUP ||
    "https://explorer2.syscoin.org/api?module=stats&action=coinsupply",
];
const contractBalanceUrl = (address) =>
  `https://explorer.syscoin.org/api?module=account&action=balance&address=${address}`;

function vaultForHeight(height) {
  if (typeof height !== "number") {
    throw new Error(`gettxoutsetinfo did not return a numeric height: ${JSON.stringify(height)}`);
  }
  return height >= CONFIGURATION.BridgeV2StartBlock
    ? CONFIGURATION.SyscoinVaultManagerV2
    : CONFIGURATION.SyscoinVaultManagerLegacy;
}

let lastRecordedTotalSupply = {
  value: undefined,
  recordedAt: undefined,
};
let lastRecordedCirculatingSupply = {
  value: undefined,
  recordedAt: undefined,
};
// Store the *last error* encountered during fetching/recording for each metric
let lastAttemptError = {
  totalSupply: undefined, // String description of the last error, or undefined if last attempt was successful
  circulatingSupply: undefined, // String description of the last error, or undefined if last attempt was successful
};
const largeNumber = 1000000000000000000;

const getUnixtimestamp = () => {
  return Math.floor(Date.now() / 1000);
};

// Create an Axios instance pre-configured for UTXO RPC
const rpc = axios.create({
  baseURL: `http://${process.env.SYSCOIN_CORE_RPC_HOST}:${process.env.SYSCOIN_CORE_RPC_PORT}/`,
  auth: {
    username: process.env.SYSCOIN_CORE_RPC_USERNAME,
    password: process.env.SYSCOIN_CORE_RPC_PASSWORD
  },
  headers: { 'Content-Type': 'application/json' },
  timeout: 10000
});

const explorerApi = axios.create({
  timeout: 8000
});

/**
 * Parse NEVM coinsupply from explorer.
 * Supports:
 * - bare JSON number in SYS (Blockscout < v11 / Syscoin explorers today)
 * - Blockscout envelope { status, message, result } (v11.0.1+)
 *   where result is already in coin units (Wei.to(:ether) before render), not wei
 *   https://docs.blockscout.com/devs/apis/rpc/stats
 */
function parseNevmCoinSupply(data) {
  if (typeof data === "number") {
    if (!Number.isFinite(data) || data < 0) {
      throw new Error(`Invalid nevmSupply (bare number): ${data}`);
    }
    return data;
  }

  if (data && typeof data === "object") {
    if (data.status !== "1" || typeof data.result !== "string") {
      throw new Error(
        `Invalid nevmSupply response structure or status: ${JSON.stringify(data)}`
      );
    }
    const nevmSupply = parseFloat(data.result);
    if (isNaN(nevmSupply) || nevmSupply < 0 || !Number.isFinite(nevmSupply)) {
      throw new Error(`Could not parse nevmSupply result: ${data.result}`);
    }
    return nevmSupply;
  }

  throw new Error(`Unsupported nevmSupply response type: ${typeof data}`);
}

/**
 * Fetch NEVM coinsupply, trying primary then backup URL on HTTP/parse failure.
 */
async function fetchNevmCoinSupply(urls) {
  let lastError;
  for (const url of urls) {
    try {
      const response = await explorerApi.get(url);
      const value = parseNevmCoinSupply(response.data);
      return { value, url };
    } catch (error) {
      const status = error.response ? ` status=${error.response.status}` : "";
      lastError = new Error(
        `NEVM total supply remote=${url}${status} failed: ${error.message}`
      );
      console.warn(lastError.message);
    }
  }
  throw lastError || new Error("NEVM total supply: no URLs configured");
}

/**
 * Calls gettxoutsetinfo on UTXO JSON-RPC
 */
async function getTxOutSetInfo() {
  console.log("Fetching UTXO gettxoutsetinfo via RPC...");
  const rpcRemote = `http://${process.env.SYSCOIN_CORE_RPC_HOST}:${process.env.SYSCOIN_CORE_RPC_PORT}`;
  const rpcMethod = "gettxoutsetinfo";
  try {
    const requestData = { jsonrpc: '1.0', id: 'gettxoutsetinfo', method: rpcMethod, params: [] };
    const response = await rpc.post('', requestData);

    if (response.data.error) {
      throw new Error(`RPC error: ${response.data.error.message || JSON.stringify(response.data.error)}`);
    }
    if (!response.data.result || typeof response.data.result.total_amount !== 'number') {
      throw new Error(`Invalid data structure in gettxoutsetinfo response: ${JSON.stringify(response.data)}`);
    }
    console.log("UTXO set info fetched successfully.");
    return response.data.result;

  } catch (err) {
    let errorMessage = `UTXO RPC remote=${rpcRemote} method=${rpcMethod} failed: ${err.message}`;
    if (err.response) {
      errorMessage += ` (Status: ${err.response.status}, Data: ${JSON.stringify(err.response.data)})`;
    } else if (err.request) {
      errorMessage += ` (No response received, check RPC connection/URL)`;
    }
    console.error(errorMessage);
    throw new Error(errorMessage); // Re-throw for the recording function
  }
}

const getSupply = async () => {
  console.log("Fetching total supply components...");
  const [supplyInfo, nevmSupplyResult] = await Promise.all([
    getTxOutSetInfo(),
    fetchNevmCoinSupply(TOTAL_SUPPLY_URLS),
  ]);

  const vaultAddress =
    CONFIGURATION.SyscoinVaultManager || vaultForHeight(supplyInfo.height);
  const vaultBalanceUrl = contractBalanceUrl(vaultAddress);
  const nevmAddResponse = await explorerApi.get(vaultBalanceUrl).catch((error) => {
    const status = error.response ? ` status=${error.response.status}` : "";
    throw new Error(`NEVM contract balance remote=${vaultBalanceUrl}${status} failed: ${error.message}`);
  });

  // Extract data and validate
  const utxoSupply = supplyInfo.total_amount; // Already validated in getTxOutSetInfo
  const nevmSupply = nevmSupplyResult.value;
  const nevmAdd = nevmAddResponse.data;

  if (!nevmAdd || nevmAdd.status !== "1" || typeof nevmAdd.result !== 'string') {
    throw new Error(`Invalid nevmAdd response structure or status: ${JSON.stringify(nevmAdd)}`);
  }
  const nevmAddContractSupply = nevmAdd.result;

  const nevmContract = parseFloat(nevmAddContractSupply) / largeNumber;
  if (isNaN(nevmContract)) throw new Error(`Could not parse nevmAddContractSupply: ${nevmAddContractSupply}`);

  console.log({
    utxoSupply,
    utxoHeight: supplyInfo.height,
    nevmSupply,
    nevmSupplyUrl: nevmSupplyResult.url,
    vaultAddress,
    nevmContract,
  });
  const cmcSupply = nevmSupply - nevmContract + utxoSupply;
  if (isNaN(cmcSupply) || cmcSupply < 0) throw new Error(`Calculated cmcSupply is invalid: ${cmcSupply}`);

  console.log("Total supply components fetched and calculated successfully."); // Add logging
  return cmcSupply;
};

const recordTotalSupply = async () => {
  console.log("Attempting to record total supply...");
  try {
    const supply = await getSupply(); // Can throw errors

    // Success Case: Update value and clear specific error
    lastRecordedTotalSupply.value = supply;
    lastRecordedTotalSupply.recordedAt = getUnixtimestamp();
    lastAttemptError.totalSupply = undefined; // Clear error on success
    console.log(`Total supply recorded successfully: ${supply} at ${new Date(lastRecordedTotalSupply.recordedAt * 1000).toISOString()}`);

  } catch (error) {
    // Failure Case: Log, update error state, *keep existing value*
    const errorMessage = `Failed to record total supply: ${error.message || "Unknown error"}`;
    console.error(errorMessage);
    lastAttemptError.totalSupply = errorMessage; // Store the error message
    // DO NOT update lastRecordedTotalSupply.value or .recordedAt
  }
};

const recordCirculatingSupply = () => {
  console.log("Attempting to record circulating supply...");
  // Check dependency: Has total supply *ever* been recorded successfully?
  if (lastRecordedTotalSupply.value === undefined) {
    const errorMessage = "Skipped: Total supply has never been recorded.";
    console.warn(errorMessage);
    lastAttemptError.circulatingSupply = errorMessage;
    return; // Don't proceed
  }
  // Check dependency: Did the *last attempt* to get total supply fail?
  if (lastAttemptError.totalSupply !== undefined) {
    const errorMessage = "Skipped: Last total supply fetch failed.";
    console.warn(errorMessage);
    lastAttemptError.circulatingSupply = errorMessage;
    return; // Don't proceed
  }

  const supply = lastRecordedTotalSupply.value;
  lastRecordedCirculatingSupply.value = supply;
  lastRecordedCirculatingSupply.recordedAt = getUnixtimestamp();
  lastAttemptError.circulatingSupply = undefined;
  console.log(`Circulating supply recorded successfully: ${supply} at ${lastRecordedCirculatingSupply.recordedAt}`);
};

const runRecordingCycle = async () => {
  await recordTotalSupply();
  // recordCirculatingSupply internally checks dependencies
  await recordCirculatingSupply();
  console.log("Current State - Total:", lastRecordedTotalSupply.value, "Circ:", lastRecordedCirculatingSupply.value, "Errors:", lastAttemptError.totalSupply, lastAttemptError.circulatingSupply);
};

app.get("/totalsupply", (req, res) => {
  if (lastRecordedTotalSupply.value === undefined) {
    // Data not yet successfully recorded
    console.warn("Service Unavailable: Request to /totalsupply. Data not initialized.");
    res.status(503).set("Content-Type", "text/plain").send("Service Unavailable: Data initialization failed or pending.");
  } else {
    // Data is available, send it
    res.set("Content-Type", "text/html");
    res.status(200).send(`${lastRecordedTotalSupply.value}`);
  }
});

app.get("/circulatingsupply", (req, res) => {
  if (lastRecordedCirculatingSupply.value === undefined) {
    // Data not yet successfully recorded (or depends on total supply which failed)
    console.warn("Service Unavailable: Request to /circulatingsupply. Data not initialized.");
    res.status(503).set("Content-Type", "text/plain").send("Service Unavailable: Data initialization failed or pending.");
  } else {
    // Data is available, send it
    res.set("Content-Type", "text/html"); // Keep original Content-Type on success
    res.status(200).send(`${lastRecordedCirculatingSupply.value}`); // No '?? 0' needed here
  }
});

app.get("/triggerRecordSupply", async (req, res) => {
  console.log("Manual trigger received: Recording supply...");
  await runRecordingCycle();
  res.status(200).json({
    newRecordedSupply: lastRecordedTotalSupply,
    newCirculatingSupply: lastRecordedCirculatingSupply,
  });
});

app.get("/health", (req, res) => {
  console.log("Health check", new Date());
  res.status(200).send("OK");
});

app.get("/status", (req, res) => {
  if (undefined !== lastAttemptError.circulatingSupply || undefined !== lastAttemptError.totalSupply) {
    res.status(200).json({
      status: "ERROR",
      // Send the last *good* recorded state
      lastCirculatingSupply: lastRecordedCirculatingSupply,
      lastTotalSupply: lastRecordedTotalSupply,
      lastError: {
          // Can be undefined or error string
          circulatingSupply: lastAttemptError.circulatingSupply,
          totalSupply: lastAttemptError.totalSupply,
      },
    });
  } else {
    res.status(200).json({status: "OK"});
  }
});

const server = app.listen(port, async () => {
  console.log(`Syscoin Info app listening on port ${port}`);

  console.log("Performing initial supply recording on startup...");
  await runRecordingCycle(); // Run the first cycle immediately
  console.log("Initial supply recording attempt complete.");

  // --- Periodic Polling ---
  const POLLING_INTERVAL_SECONDS = process.env.POLLING_INTERVAL_SECONDS ? parseInt(process.env.POLLING_INTERVAL_SECONDS, 10) : 30; // Default 30 seconds
  const POLLING_INTERVAL_MS = POLLING_INTERVAL_SECONDS * 1000;
  let pollingInterval;
  if (POLLING_INTERVAL_MS > 0) { // Avoid interval of 0 or less
    console.log(`Starting supply polling every ${POLLING_INTERVAL_SECONDS} seconds.`);
    pollingInterval = setInterval(runRecordingCycle, POLLING_INTERVAL_MS);
  } else {
    console.log("Polling interval is set to 0 or less. Polling disabled after initial fetch.");
  }

  const shutdown = (signal) => {
    console.log(`${signal} signal received: Shutting down server...`);
    if (pollingInterval) {
      clearInterval(pollingInterval);
      console.log("Polling stopped.");
    }

    server.close((err) => { // Close the HTTP server
      if (err) {
        console.error("Error closing HTTP server:", err);
        process.exit(1);
      } else {
        console.log('HTTP server closed.');
        process.exit(0);
      }
    });
    setTimeout(() => {
      console.error('Could not close connections gracefully, forcefully shutting down');
      process.exit(1);
    }, 10*1000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
