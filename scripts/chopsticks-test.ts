/* eslint @typescript-eslint/no-var-requires: "off" */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* tslint:disable:no-unused-variable */
import { firstValueFrom, lastValueFrom, takeWhile } from "rxjs";

import { ApiProvider } from "../src/api-provider";
import { BaseCrossChainAdapter } from "../src/base-chain-adapter";
import { ChainName } from "../src/configs";
import { Bridge } from "../src/index";
import { KintsugiAdapter } from "../src/adapters/interlay";
import { BifrostAdapter } from "../src/adapters/bifrost";
import { FN } from "../src/types";
import { KusamaAdapter } from "../src/adapters/polkadot";
import { StatemineAdapter } from "../src/adapters/statemint";
import { Keyring } from "@polkadot/api";
import { BalanceChangedStatus } from "../src/types";
import { KaruraAdapter } from "../src/adapters/acala";
import { HeikoAdapter } from "../src/adapters/parallel";
import { SubmittableExtrinsic } from "@polkadot/api/types";
import { ISubmittableResult } from "@polkadot/types/types";

main().catch((err) => {
    console.log("Error thrown by script:");
    console.log(err);
    process.exit(-1);
});

async function submitTx(tx: SubmittableExtrinsic<"rxjs", ISubmittableResult>) {
    const keyring = new Keyring({ type: "sr25519" });
    // alice
    const userKeyring = keyring.addFromUri('0xe5be9a5092b81bca64be81d212e7f2f9eba183bb7a90954f7b76361f6edb5c0a');
    let resultingEvents = await tx.signAndSend(userKeyring);
    resultingEvents.subscribe(); // required, or else signAndSend won't do anything
}

function getRandomAddress(ss58Prefix: number) {
    let hex = "0x" + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

    return new Keyring().encodeAddress(hex, ss58Prefix);
}

enum TestCase {
    "FeeEstimate",
    "ExistentialDeposit"
}
async function sendTx(fromChain: ChainName, toChain: ChainName, token: string, bridge: Bridge, sentAmount: FN, testCase: TestCase) {
    const originAdapter = bridge.findAdapter(fromChain);
    const destAdapter = bridge.findAdapter(toChain);

    // use a fresh address each time to test the worst-case scenario with the ED
    const destAddress = getRandomAddress(destAdapter.getSS58Prefix());

    let expectedDiff = FN.fromInner("1", sentAmount.getPrecision());

    const tx = originAdapter.createTx({
        to: toChain,
        token,
        amount: sentAmount,
        address: destAddress,
        signer: destAddress, // doesn't matter in chopsticks
    });

    let cfg = {
        token: token,
        address: destAddress,
        amount: expectedDiff,
        timeout: 60 * 1000, // 15 sec timeout
    };
    let changes = destAdapter.subscribeBalanceChanged(cfg);
    await submitTx(tx as SubmittableExtrinsic<"rxjs", ISubmittableResult>);
    let q = changes.pipe(takeWhile((x) => x == BalanceChangedStatus.CHECKING, true));

    let result = await lastValueFrom(q);
    let newBalance = (await firstValueFrom(destAdapter.subscribeTokenBalance(token, destAddress))).free;
    if (result != BalanceChangedStatus.SUCCESS || newBalance.isZero()) {
        let err = `Failed to transfer ${sentAmount} ${token} from ${fromChain} to ${toChain} @ ${destAddress} - likely the configured ${TestCase[testCase]} is too low`;
        throw new Error(err)
    }

    let actualFee = sentAmount.sub(newBalance);

    return actualFee;
}

enum ResultCode {
    "OK",
    "WARN",
    "FAIL"
}

function iconOf(code: ResultCode) {
    switch (code) {
        case ResultCode.OK:
            return '✅';
        case ResultCode.WARN:
            return '⚠️';
        case ResultCode.FAIL:
            return '❌';
    }
}

type IndividualTestResult = {
    message: string;
    result: ResultCode
};

async function checkTransfer(fromChain: ChainName, toChain: ChainName, token: string, bridge: Bridge): Promise<IndividualTestResult>{
    try {
        let ret = {
            message: "",
            result: ResultCode.OK,
        };

        const originAdapter = bridge.findAdapter(fromChain);
        let expectedMinAmount = await firstValueFrom(originAdapter.subscribeMinInput(token, toChain));
        let expectedEd = originAdapter.getDestED(token, toChain).balance;

        // check that the fee set in the config are set sufficiently large
        let actualFee = await sendTx(fromChain, toChain, token, bridge, expectedMinAmount.mul(new FN(10)), TestCase.FeeEstimate);
        let feeBudget = originAdapter.getCrossChainFee(token, toChain).balance;
        let feeOverestimationFactor = feeBudget.div(actualFee);
        let actualFeePlancks = actualFee._getInner();
        // console.log(`Fee budget: ${feeBudget}, actual fee: ${actualFee} (= ${actualFeePlancks} plank), marginFactor: ${feeOverestimationFactor}`);
        if (feeOverestimationFactor.toNumber() <= 2) {
            let message = `Fees need to be increased in config. The actual fees are ${actualFee} (= ${actualFeePlancks} plank). Fee overestimation factor was ${feeOverestimationFactor} - we want at least 2.0`;

            // if below 1, this is an error. 
            if (feeOverestimationFactor.toNumber() < 1) {
                return {
                    message: message,
                    result: ResultCode.FAIL
                };
            } else { 
                // not immediately failing, but dangerously close - we need to return
                // a warning, unless the code below will returns an error
                ret = {
                    message: message,
                    result: ResultCode.WARN
                };
            }
        }

        // check existential deposit by sending exactly `actualFee + ed + [1 planck]`. The function
        // will throw an error if the ed is set too low.
        let amountToSend = actualFee.add(expectedEd).add(FN.fromInner("1", actualFee.getPrecision()));
        await sendTx(fromChain, toChain, token, bridge, amountToSend, TestCase.ExistentialDeposit);
        
        return ret;
    } catch (error) {
        return {
            message: (error as any).message,
            result: ResultCode.FAIL
        };
    }
}

async function retryCheckTransfer(
    fromChain: ChainName, 
    toChain: ChainName, 
    token: string, 
    bridge: Bridge,
    maxAttempts: number,
    attemptCount: number = 1
  ): Promise<Awaited<ReturnType<typeof checkTransfer>>> {
    const result = await checkTransfer(fromChain, toChain, token, bridge);

    if (result.result === ResultCode.OK) {
        return result;
    }

    // try again if we have retries left
    process.stdout.write(` attempt ${attemptCount}/${maxAttempts} failed...`);
    if (attemptCount < maxAttempts) {
        return retryCheckTransfer(fromChain, toChain, token, bridge, maxAttempts, attemptCount + 1);
    }
    process.stdout.write(` giving up. `);
    return result;
}

/**
 * Run through all test cases passed through using the adapters and their endpoints provided.
 * 
 * Will print out results and end the process with an error code if it detects any errors, otherwise exit cleanly.
 * 
 * @param adapterEndpoints Records containing ChainName as key, an instantiated adapter and a list of ws(s) links as endpoints for each.
 * @param testCases An array of xcm test cases to run.
 */
export async function runTestCasesAndExit(
    // record key is chainname
    adapterEndpoints: Record<ChainName, { adapter: BaseCrossChainAdapter, endpoints: Array<string> }>,
    // testcases: array of chainname, token
    testCases: {from: ChainName, to: ChainName, token: string}[]
): Promise<void> {
    const adapters = Object.values(adapterEndpoints).map((value) => value.adapter);
    const bridge = new Bridge({adapters});

    const chains = Object.keys(adapterEndpoints) as ChainName[];
    const provider = new ApiProvider();

    let endpoints: Record<string, string[]> = {};
    for (let [key, value] of Object.entries(adapterEndpoints)) {
        endpoints[key as ChainName] = value.endpoints;
    }

    // connect all adapters
    await lastValueFrom(
        provider.connectFromChain(chains, endpoints)
    );
    // and set apiProvider for each adapter
    await Promise.all(
        chains.map((chain) =>
            adapterEndpoints[chain].adapter.setApi(provider.getApi(chain))
        )
    );

    let aggregateTestResult = ResultCode.OK;
    // collect failed/warning cases for logging at the end of the run, too
    const problematicTestCases: Array<{from: ChainName, to: ChainName, token: string, icon: string, message: string}> = [];

    for (const {from, to, token} of testCases) {
        // don't use console.log because I don't want newline here - I want the OK/FAIL to be added on the same line
        process.stdout.write(`Testing ${token} transfer from ${from} to ${to}... `);
        const result = await retryCheckTransfer(from, to, token, bridge, 3);
        console.log(ResultCode[result.result]);
        if (result.result != ResultCode.OK) {
            console.log(iconOf(result.result), result.message);
            problematicTestCases.push({from: from as ChainName, to: to as ChainName, token, icon: iconOf(result.result), message: result.message});
            if (aggregateTestResult == ResultCode.OK || (aggregateTestResult == ResultCode.WARN && result.result == ResultCode.FAIL)) {
                // only 'increase' the aggregate error
                aggregateTestResult = result.result;
            }
        } 
    }

    // prepare for logging
    const problematicTestStrings = problematicTestCases.map(({to, from, token, icon, message}) => `${token} from ${from} to ${to}: ${icon} ${message}`);

    let icon = iconOf(aggregateTestResult);
    switch (aggregateTestResult) {
        case ResultCode.OK:
            console.log(icon, 'all channels OK');
            process.exit(0);
        case ResultCode.WARN:
            console.log(icon, 'action required');
            problematicTestStrings.forEach((logMessage) => console.log(logMessage));
            process.exit(-1);
        case ResultCode.FAIL:
            console.log(icon, 'some channels FAILED');
            problematicTestStrings.forEach((logMessage) => console.log(logMessage));
            process.exit(-2);
    }
}

async function main(): Promise<void> {
    const adaptersEndpoints : Record<string, { adapter: BaseCrossChainAdapter, endpoints: Array<string> }> = {
        // make sure endpoints are aligned with the ports spun up by chopsticks config in
        // .github/workflows/xcm-tests.yml
        // reminder: parachains get ports in oder of arguments, starting with 8000 and incremented for each following one; 
        //           relaychain gets its port last after all parachains.
        kintsugi:   { adapter: new KintsugiAdapter(),   endpoints: ['ws://127.0.0.1:8000'] },
        statemine:  { adapter: new StatemineAdapter(),  endpoints: ['ws://127.0.0.1:8001'] },
        karura:     { adapter: new KaruraAdapter(),     endpoints: ['ws://127.0.0.1:8002'] },
        heiko:      { adapter: new HeikoAdapter(),      endpoints: ['ws://127.0.0.1:8003'] },
        bifrost:    { adapter: new BifrostAdapter(),    endpoints: ['ws://127.0.0.1:8004'] },
        kusama:     { adapter: new KusamaAdapter(),     endpoints: ['ws://127.0.0.1:8005'] },
    };

    const testcases = [
        ["bifrost", "VKSM"],
        ["kusama", "KSM"], 
        ["karura", "KBTC"],
        ["karura", "KINT"],
        ["karura", "LKSM"],
        ["statemine", "USDT"],
        ["heiko", "KINT"],
        ["heiko", "KBTC"],
    ].flatMap(([targetChain, token]) => [
        {from: "kintsugi" as ChainName, to: targetChain as ChainName, token}, 
        {from: targetChain as ChainName, to: "kintsugi" as ChainName, token}
    ]); // bidirectional testing

    await runTestCasesAndExit(adaptersEndpoints, testcases);
}