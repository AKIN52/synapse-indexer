import {Topics, getEventForTopic, getTopicsHash} from "../config/topics.js";
import {BridgeTransaction} from "../db/transaction.js";
import {BigNumber, ethers} from "ethers";
import {ChainId, Networks, Tokens} from "@synapseprotocol/sdk";
import {getBasePoolAbi, getTokenContract} from "../config/chainConfig.js";

/**
 * Get name of contract function that emits the event
 * https://github.com/synapsecns/synapse-contracts/blob/master/contracts/bridge/SynapseBridge.sol
 *
 * @param eventName
 * @return {string|null}
 */
function getFunctionForEvent(eventName) {
    switch (eventName) {
        case "TokenWithdrawAndRemove":
            return "withdrawAndRemove"
        case "TokenMintAndSwap":
            return "mintAndSwap"
    }
    return null;
}

/**
 * Receives array of logs and returns a dict with their args
 *
 * @param {Object} contractInterface
 * @param {Array<Object>} logs
 * @returns {Object}
 */
function getEventLogArgs(contractInterface, logs) {
    for (let topicHash of getTopicsHash()) {
        for (let log of logs) {
            if (log.topics.includes(topicHash)) {
                return contractInterface.parseLog(log).args;
            }
        }
    }
    return {};
}

/**
 * Receives array of logs and returns information pulled from the Transfer log
 *
 * @param {Array<Object>} logs
 * @param {Object} chainConfig
 * @returns {Object}
 */
function parseTransferLog(logs, chainConfig) {
    // Find log for the Transfer() event
    // Address is token contract address, e.i tokenSent
    let res = {};
    for (let log of logs) {
        if (Object.keys(chainConfig.tokens).includes(log.address)) {
            res.sentTokenAddress = log.address;
            res.sentTokenSymbol = chainConfig.tokens[log.address].symbol;

            let sentValue = log.data;
            if (res.sentTokenSymbol !== "WETH" && chainConfig.id === 1) {
                // Not an ERC-20 token, hence parsing value ?
                try {
                    sentValue = getTokenContract(chainConfig.id, res.sentTokenAddress).interface.parseLog(log).args.value;
                } catch (e) {
                    console.error(e)
                }
            }
            res.sentValue = BigNumber.from(sentValue).toString();

            return res;
        }
    }
    return res;
}

/**
 * Returns list of token addresses for coins that form the stableswap pool for a chain
 *
 * @param poolAddress
 * @param chainConfig
 * @param contract
 * @param chainId
 * @return {Promise<*[]>}
 */
async function getSwapPoolCoinAddresses(poolAddress, chainConfig, contract, chainId) {
    let poolContract = new ethers.Contract(
        poolAddress,
        getBasePoolAbi(),
        contract.provider
    )

    let res = [];

    for (let i = 0; i < (1 << 8); i++) {
        try {
            let tokenRes = await poolContract.functions.getToken(i);
            res.push(tokenRes[0]);
        } catch (e) {
            break;
        }
    }

    return res;
}

/**
 * Insert IN/OUT Bridge Txn or update it with the IN/OUT counterpart
 * Idempotent for transactions with identical kappa and params
 *
 * @param {String} kappa
 * @param {Object} args
 * @return {Promise<Query<any, any, {}, any>|*>}
 */
async function upsertBridgeTxnInDb(kappa, args) {
    let filter = {"kappa": kappa};
    let existingTxn = await BridgeTransaction.findOne(filter);

    // Insert new transaction
    if (!existingTxn) {
        console.log(`Transaction with kappa ${kappa} not found. Inserting...`)
        return await new BridgeTransaction(
            args
        ).save();
    }

    // Update existing bridge with args
    console.log(`Transaction with kappa ${kappa} found. Updating...`)
    return await BridgeTransaction.findOneAndUpdate(filter, args, {new: true});
}

export async function processEvents(contract, chainConfig, events) {
    for (let event of events) {

        const txnHash = event.transactionHash;
        const txn = await event.getTransaction();
        const block = await event.getBlock();
        const timestamp = block.timestamp;

        const topicHash = event.topics[0];
        const eventInfo = getEventForTopic(topicHash);
        const eventDirection = eventInfo.direction;
        const eventName = eventInfo.eventName;

        console.log(eventInfo)

        const txnReceipt = await event.getTransactionReceipt();
        let eventLogArgs = getEventLogArgs(
            contract.interface,
            txnReceipt.logs,
        );

        if (eventDirection === "OUT") {

            // Process transaction going out of a chain
            let toChainId = eventLogArgs.chainId.toString()
            let toAddress = eventLogArgs.to
            let {fromAddress} = txn.from;
            let {sentTokenAddress, sentTokenSymbol, sentValue} = parseTransferLog(
                txnReceipt.logs,
                chainConfig
            );
            const fromChainId = chainConfig.id;
            const kappa = ethers.utils.keccak256(
                ethers.utils.toUtf8Bytes(txnHash)
            );
            const pending = true;

            await upsertBridgeTxnInDb(kappa, {
                fromTxnHash: txnHash,
                fromAddress,
                toAddress,
                fromChainId,
                toChainId,
                sentValue,
                sentTokenAddress,
                sentTokenSymbol,
                kappa,
                sentTime: timestamp,
                pending
            })
            console.log(`OUT with kappa ${kappa} saved`)

        } else {
            let kappa = eventLogArgs.kappa;

            console.log("IN with kappa", kappa)

            let receivedValue = null;
            let receivedToken = null;
            let swapSuccess = null;
            let data = {}

            if (eventName === "TokenWithdrawAndRemove" || eventName ==="TokenMintAndSwap") {
                let input = txn.data
                let inputArgs = contract.interface.decodeFunctionData(getFunctionForEvent(eventName), input)

                // Get list of stable coin addresses
                let swapPoolAddresses = await getSwapPoolCoinAddresses(
                    inputArgs.pool,
                    chainConfig,
                    contract,
                    chainConfig.id
                )

                // Build out data from event log args
                data = {
                    to: eventLogArgs.to,
                    fee: eventLogArgs.fee,
                    tokenIndexTo: eventLogArgs.swapTokenIndex,
                    swapSuccess: eventLogArgs.swapSuccess,
                    token: eventLogArgs.token
                }

                // Determine received token
                if (data.swapSuccess) {
                    receivedToken = swapPoolAddresses[data.tokenIndexTo]
                } else if (chainConfig.id === ChainId.ETH) {
                    // nUSD (eth) - nexus assets are not in eth pools.
                    receivedToken = '0x1b84765de8b7566e4ceaf4d0fd3c5af52d3dde4f'
                } else {
                    receivedToken = swapPoolAddresses[0];
                }
                swapSuccess = data.swapSuccess;

            } else if (eventName === "TokenWithdraw" || eventName ==="TokenMint") {
                data = {
                    to: eventLogArgs.to,
                    fee: eventLogArgs.fee,
                    token: eventLogArgs.token,
                    amount: eventLogArgs.amount
                }

                receivedToken = data.token;

                if (eventName === "TokenWithdraw") {
                    receivedValue = data.amount - data.fee
                }
            } else {
                console.error("In Event not convered")
                continue;
            }

            // Avalanche GMX not ERC-20 compatible
            if (chainConfig.id === 43114 && receivedToken === "0x20A9DC684B4d0407EF8C9A302BEAaA18ee15F656") {
                receivedToken = "0x62edc0692BD897D2295872a9FFCac5425011c661";
            }

            // TODO: Move to searchLogs function
            if (!receivedValue) {
                console.log("Searching logs for received value...")
                let tokenContract = getTokenContract(chainConfig.id, receivedToken)
                for (let log of txnReceipt.logs) {
                    console.log(`Comparing ${log.address} and ${receivedToken}`)
                    if (log.address === receivedToken) {
                        receivedValue = tokenContract.interface.parseLog(log).args.value;
                        console.log(`Received value parsed is ${receivedValue}`)
                        break;
                    }
                }
                if (!receivedValue) {
                    console.error('Error! Unable to find received value for log')
                    continue;
                }
                console.log(`Received value is ${receivedValue}`);
            }

            if (eventName === "TokenMint") {
                if (receivedValue !== data.amount) {
                    console.log(`Event is TokenMint, received value is ${receivedValue} and amount is ${data.amount}`)
                    for (let log of txnReceipt.logs) {
                        receivedValue = BigNumber.from(log.data);
                        receivedToken =  log.address;
                        console.log(`Received value is ${receivedValue}, data.amount is ${data.amount}`);
                        if (data.amount.gt(receivedValue)) {
                            break;
                        }
                    }
                }
            }

            if (!swapSuccess) {
                receivedValue -= data.fee;
            }

            await upsertBridgeTxnInDb(kappa, {
                    toTxnHash: txnHash,
                    toAddress: data.to,
                    receivedValue,
                    receivedTokenAddress: receivedToken,
                    receivedTokenSymbol: chainConfig?.tokens[receivedToken]?.symbol,
                    swapSuccess,
                    kappa,
                    receivedTime: timestamp,
                    toChainId: chainConfig.id,
                    pending: false
                }
            )

            console.log(`IN with kappa ${kappa} saved, received token: ${receivedToken}`)

        }
    }

}