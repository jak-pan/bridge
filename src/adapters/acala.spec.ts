

import { FixedPointNumber } from '@acala-network/sdk-core';
import { firstValueFrom } from 'rxjs';

import { ApiProvider } from '../api-provider';
import { chains, ChainName } from '../configs';
import { Bridge } from '..';
import { KaruraAdapter } from './acala';
import { KintsugiAdapter } from './interlay';

describe.skip('acala-adapter should work', () => {
  jest.setTimeout(30000);

  const testAccount = '5GREeQcGHt7na341Py6Y6Grr38KUYRvVoiFSiDB52Gt7VZiN';
  const provider = new ApiProvider("mainnet");

  async function connect (chains: ChainName[]) {
    // return firstValueFrom(provider.connectFromChain([chain], { karura: ["wss://crosschain-dev.polkawallet.io:9907"] }));
    return firstValueFrom(provider.connectFromChain(chains, undefined));
  }

  test('connect karura to do xcm', async () => {
    const fromChains = ['karura', 'kintsugi'] as ChainName[];

    await connect(fromChains);

    const karura = new KaruraAdapter();
    const kintsugi = new KintsugiAdapter();

    await karura.setApi(provider.getApi(fromChains[0]));
    await kintsugi.setApi(provider.getApi(fromChains[1]));

    const bridge = new Bridge({
      adapters: [karura, kintsugi]
    });

    expect(bridge.router.getDestinationChains({ from: chains.karura, token: 'KINT' }).length).toEqual(1);

    const adapter = bridge.findAdapter(fromChains[0]);

    async function runMyTestSuit (to: ChainName, token: string) {
      if (adapter) {
        const balance = await firstValueFrom(adapter.subscribeTokenBalance(token, testAccount));

        console.log(
          `balance ${token}: free-${balance.free.toNumber()} locked-${balance.locked.toNumber()} available-${balance.available.toNumber()}`
        );
        expect(balance.available.toNumber()).toBeGreaterThanOrEqual(0);
        expect(balance.free.toNumber()).toBeGreaterThanOrEqual(balance.available.toNumber());
        expect(balance.free.toNumber()).toEqual(balance.locked.add(balance.available).toNumber());

        const inputConfig = await firstValueFrom(adapter.subscribeInputConfigs({ to, token, address: testAccount, signer: testAccount }));

        console.log(
          `inputConfig: min-${inputConfig.minInput.toNumber()} max-${inputConfig.maxInput.toNumber()} ss58-${inputConfig.ss58Prefix}`
        );
        expect(inputConfig.minInput.toNumber()).toBeGreaterThan(0);
        expect(inputConfig.maxInput.toNumber()).toBeLessThanOrEqual(balance.available.toNumber());

        const destFee = adapter.getCrossChainFee(token, to);

        console.log(`destFee: fee-${destFee.balance.toNumber()} ${destFee.token}`);
        expect(destFee.balance.toNumber()).toBeGreaterThan(0);

        const tx = adapter.createTx({
          amount: FixedPointNumber.fromInner('10000000000', 10),
          to,
          token,
          address: testAccount,
          signer: testAccount
        });

        expect(tx.method.section).toEqual('xTokens');
        expect(tx.method.method).toEqual('transfer');
        expect(tx.args.length).toEqual(4);
      }
    }

    await runMyTestSuit("kintsugi", "KINT");
    await runMyTestSuit("kintsugi", "KBTC");
  });
});