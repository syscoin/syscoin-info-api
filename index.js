require("dotenv").config();
const SyscoinRpcClient = require("@syscoin/syscoin-js").SyscoinRpcClient;
const rpcServices = require("@syscoin/syscoin-js").rpcServices;
const WebsocketClient = require("websocket").client;
const wsClient = new WebsocketClient({});

const client = new SyscoinRpcClient({
  host: process.env.SYSCOIN_CORE_RPC_HOST,
  rpcPort: process.env.SYSCOIN_CORE_RPC_PORT,
  password: process.env.SYSCOIN_CORE_RPC_PASSWORD,
  username: process.env.SYSCOIN_CORE_RPC_USERNAME,
});

const fetch = require("node-fetch");
const express = require("express");
const app = express();
const port = 3000;

const SUBSCRIBE_BLOCK_MESSAGE_ID = "2";

let lastRecordedTotalSupply = {
  value: undefined,
  recordedAt: undefined,
};
let lastRecordedCirculatingSupply = {
  value: undefined,
  recordedAt: undefined,
};
let lastRecordedError = {
  circulatingSupply: undefined,
  totalSupply: undefined,
};
const largeNumber = 1000000000000000000;

const getUnixtimestamp = () => {
  return Math.floor(Date.now() / 1000);
}

const getSupply = async () => {
  const [supplyInfo, explorerData, nevmAdd] = await Promise.all([
    rpcServices(client.callRpc).getTxOutSetInfo().call(),
     fetch(
      "https://explorer-v5.syscoin.org/api?module=stats&action=coinsupply"
     ).then((resp) => resp.json()),
    fetch(
      "https://explorer.syscoin.org/api?module=account&action=balance&address=0xA738a563F9ecb55e0b2245D1e9E380f0fE455ea1"
    ).then((resp) => resp.json()),
  ]);
  const utxoSupply = supplyInfo.total_amount;
  const nevmSupply = explorerData;
  const nevmAddContractSupply = nevmAdd.result;

  const nevmContract = nevmAddContractSupply / largeNumber;

  console.log({ utxoSupply, nevmSupply, nevmContract });
  const cmcSupply = nevmSupply - nevmContract + utxoSupply;
  return cmcSupply;
};

const getCirculatingSupply = async () => {
  if (lastRecordedTotalSupply.recordedAt === undefined) {
    return 0;
  }
  const treasuryBalance = await fetch(
    "https://explorer.syscoin.org/api?module=account&action=balance&address=0x94EBc5528bE5Ec6914B0d7366aF68aA4b6cB2696"
  ).then((resp) => resp.json());
  const balanceInEther = treasuryBalance.result / largeNumber;
  return lastRecordedTotalSupply.value - balanceInEther;
};

const recordTotalSupply = () => {
  return getSupply().then((supply) => {
    if (supply > 0) {
      lastRecordedTotalSupply.value = supply;
      lastRecordedTotalSupply.recordedAt = getUnixtimestamp();
      lastRecordedError.totalSupply = undefined;
    } else {
      lastRecordedError.totalSupply = supply;
    }
    return lastRecordedTotalSupply;
  });
};

const recordCirculatingSupply = () => {
  return getCirculatingSupply().then((supply) => {
    if (supply > 0) {
      lastRecordedCirculatingSupply.value = supply;
      lastRecordedCirculatingSupply.recordedAt = getUnixtimestamp();
      lastRecordedError.circulatingSupply = undefined;
    } else {
      lastRecordedError.circulatingSupply = supply;
    }
    return lastRecordedCirculatingSupply;
  });
};

const handleSocketMessage = (message) => {
  switch (message.id) {
    case SUBSCRIBE_BLOCK_MESSAGE_ID:
      {
        console.log("Websocket Message", { message });
        recordTotalSupply()
          .then((newTotalSupply) => {
            console.log({ newTotalSupply, ...message.data });
            return recordCirculatingSupply();
          })
          .then((newCirculatingSupply) => {
            console.log({ newCirculatingSupply, ...message.data });
          });
      }
      break;
  }
};

const runNewBlockSubscription = () => {
  wsClient.on("connectFailed", () => {
    console.log("Websocket connection failed");
  });

  wsClient.on("connect", (connection) => {
    console.log("Websocket connection established");

    connection.on("message", (message) => {
      if (message.type === "utf8") {
        const messageJson = JSON.parse(message.utf8Data);
        handleSocketMessage(messageJson);
      }
      return false;
    });
    connection.on("close", (close) => {
      console.log("Websocket connection closed", close);
    });

    connection.on("error", (error) => {
      console.log("Websocket connection error", { error });
    });

    setTimeout(() => {
      connection.send(
        JSON.stringify({ id: "1", method: "getInfo", params: {} })
      );

      connection.send(
        JSON.stringify({ id: "2", method: "subscribeNewBlock", params: {} })
      );
      let pingCount = 0;
      setInterval(() => {
        connection.send(
          JSON.stringify({
            id: `${3 + pingCount++}`,
            method: "ping",
            params: {},
          })
        );
      }, 1000);
    }, 3000);
  });
  wsClient.connect("wss://blockbook.syscoin.org/websocket");
};

app.get("/totalsupply", (req, res) => {
  res.set("Content-Type", "text/html");
  res.status(200).send(`${lastRecordedTotalSupply.value ?? 0}`);
});

app.get("/circulatingsupply", (req, res) => {
  res.set("Content-Type", "text/html");
  res.status(200).send(`${lastRecordedCirculatingSupply.value ?? 0}`);
});

app.get("/triggerRecordSupply", async (req, res) => {
  const newRecordedSupply = await recordTotalSupply();
  const newCirculatingSupply = await recordCirculatingSupply();
  res
    .status(200)
    .send(JSON.stringify({ newRecordedSupply, newCirculatingSupply }));
});

app.get("/health", async (req, res) => {
  console.log("Health check", new Date());
  if (undefined !== lastRecordedError.circulatingSupply || undefined !== lastRecordedError.totalSupply) {
    res.json({
      status: "ERROR",
      lastCirculatingSupply: lastRecordedCirculatingSupply,
      lastTotalSupply: lastRecordedTotalSupply,
      lastError: lastRecordedError,
    })
  } else {
    res.json({status: "OK"});
  }
});

app.listen(port, () => {
  console.log(`Syscoin Info app listening on port ${port}`);
  runNewBlockSubscription();
  recordTotalSupply().then(() => recordCirculatingSupply());
});

process.on("SIGTERM", () => {
  rpcServices(client.callRpc)
    .stop()
    .then(() => {
      console.log("Syscoin Server Stopped");
    });
});
