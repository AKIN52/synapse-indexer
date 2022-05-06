import {ethers} from "ethers";
import {RedisConnection} from "../db/redis.js";
import {getTopicsHash} from "../config/topics.js";
import {processEvents} from "./processEvents.js";
import {getLogger} from "../utils/loggerUtils.js";
import {getEpochSeconds} from "../utils/timeUtils.js";
import {buildBridgeContract, getBridgeContractAbi, getW3Provider} from "../config/chainConfig.js";

export async function indexForward(chainConfig) {
    let logger = getLogger(`${chainConfig.name}_${indexForward.name}`)
    let chainName = chainConfig.name;
    let redisClient = await RedisConnection.getClient();

    // Only one invocation should be running per chain
    let isIndexing = await redisClient.get(
        `${chainName}_IS_INDEXING_FORWARD`
    )
    if (isIndexing === "true") {
        logger.debug(`already in progress, skipping interval call.`)
        return;
    }
    await redisClient.set(`${chainName}_IS_INDEXING_FORWARD`, "true")

    try {
        let w3Provider = getW3Provider(chainConfig.id, chainConfig.rpc);
        logger.log(`start indexing forward`)

        // Get block intervals to get events between
        let networkLatestBlock = await w3Provider.getBlockNumber();
        let indexedLatestBlock = await redisClient.get(
            `${chainName}_LATEST_BLOCK_INDEXED`
        )
        indexedLatestBlock = (indexedLatestBlock) ? parseInt(indexedLatestBlock) : networkLatestBlock;

        if (indexedLatestBlock === networkLatestBlock) {
            logger.log(`forward indexing is up to date with latest network block ${indexedLatestBlock}`);
            await redisClient.set(`${chainName}_IS_INDEXING_FORWARD`, "false")
            return;
        }

        // We forward upto 500 blocks ahead to account for service downtime and restart
        let maxBlockToIndexUntil = Math.min(
            networkLatestBlock,
            indexedLatestBlock + 500
        )

        logger.log(`network latest block: ${networkLatestBlock}`);
        logger.log(`indexed latest block: ${indexedLatestBlock}`);
        logger.log(`indexing until block: ${maxBlockToIndexUntil}`);

        // Initialize Bridge Contract
        let bridgeContractAddress = ethers.utils.getAddress(chainConfig.bridge);
        let bridgeContract = buildBridgeContract(
            bridgeContractAddress,
            getBridgeContractAbi(),
            w3Provider
        )

        // Get events between these blocks
        let filteredEvents = await bridgeContract.queryFilter(
            {
                address: bridgeContractAddress,
                topics: [
                    getTopicsHash()
                ]
            },
            indexedLatestBlock,
            maxBlockToIndexUntil
        )

        // Process received events
        let startTime = getEpochSeconds();
        await processEvents(bridgeContract, chainConfig, filteredEvents)
        let endTime = getEpochSeconds();
        logger.log(`processing took ${endTime - startTime} seconds`)

        // Update the latest block processed for chain
        await redisClient.set(`${chainName}_LATEST_BLOCK_INDEXED`, maxBlockToIndexUntil)
        await redisClient.set(`${chainName}_IS_INDEXING_FORWARD`, "false")

        await redisClient.disconnect()
    } catch (err) {
        logger.error(err);
        await redisClient.set(`${chainName}_IS_INDEXING_FORWARD`, "false")
    }
}