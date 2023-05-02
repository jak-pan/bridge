import { Storage } from "@acala-network/sdk/utils/storage";
import { AnyApi, FixedPointNumber as FN } from "@acala-network/sdk-core";
import { combineLatest, map, Observable } from "rxjs";

import { SubmittableExtrinsic } from "@polkadot/api/types";
import { DeriveBalancesAll } from "@polkadot/api-derive/balances/types";
import { ISubmittableResult } from "@polkadot/types/types";

import { BalanceAdapter, BalanceAdapterConfigs } from "../balance-adapter";
import { BaseCrossChainAdapter } from "../base-chain-adapter";
import { ChainName, chains } from "../configs";
import { ApiNotFound, CurrencyNotFound } from "../errors";
import {
  BalanceData,
  BasicToken,
  CrossChainRouterConfigs,
  CrossChainTransferParams,
} from "../types";
import {
  XCM_V3_GENERAL_KEY_DATA_BYTES,
  supportsV0V1Multilocation,
} from "../utils/xcm-versioned-multilocation-check";

export const astarRoutersConfig: Omit<CrossChainRouterConfigs, "from">[] = [
  {
    to: "interlay",
    token: "IBTC",
    xcm: {
      // from recent xcm transfer: fee = 71 - Add 10x margin
      fee: { token: "IBTC", amount: "710" },
      weightLimit: "Unlimited",
    },
  },
  {
    to: "interlay",
    token: "INTR",
    xcm: {
      // from recent xcm transfer: fee = 21660472 - Add 10x margin
      fee: { token: "INTR", amount: "216604720" },
      weightLimit: "Unlimited",
    },
  },
];

export const astarTokensConfig: Record<string, Record<string, BasicToken>> = {
  astar: {
    ASTR: { name: "ASTR", symbol: "ASTR", decimals: 18, ed: "1000000" },
    IBTC: { name: "IBTC", symbol: "IBTC", decimals: 8, ed: "1" },
    INTR: { name: "INTR", symbol: "INTR", decimals: 10, ed: "1" },
  },
};

const SUPPORTED_TOKENS: Record<string, string> = {
  // to interlay
  IBTC: "18446744073709551620",
  INTR: "18446744073709551621",
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const createBalanceStorages = (api: AnyApi) => {
  return {
    balances: (address: string) =>
      Storage.create<DeriveBalancesAll>({
        api,
        path: "derive.balances.all",
        params: [address],
      }),
    assets: (tokenId: string, address: string) =>
      Storage.create<any>({
        api,
        path: "query.assets.account",
        params: [tokenId, address],
      }),
  };
};

class AstarBalanceAdapter extends BalanceAdapter {
  private storages: ReturnType<typeof createBalanceStorages>;

  constructor({ api, chain, tokens }: BalanceAdapterConfigs) {
    super({ api, chain, tokens });
    this.storages = createBalanceStorages(api);
  }

  public subscribeBalance(
    token: string,
    address: string
  ): Observable<BalanceData> {
    const storage = this.storages.balances(address);

    if (token === this.nativeToken) {
      return storage.observable.pipe(
        map((data) => ({
          free: FN.fromInner(data.freeBalance.toString(), this.decimals),
          locked: FN.fromInner(data.lockedBalance.toString(), this.decimals),
          reserved: FN.fromInner(
            data.reservedBalance.toString(),
            this.decimals
          ),
          available: FN.fromInner(
            data.availableBalance.toString(),
            this.decimals
          ),
        }))
      );
    }

    const tokenId = SUPPORTED_TOKENS[token];

    if (tokenId === undefined) {
      throw new CurrencyNotFound(token);
    }

    return this.storages.assets(tokenId, address).observable.pipe(
      map((balance) => {
        const amount = FN.fromInner(
          balance.unwrapOrDefault()?.balance?.toString() || "0",
          this.getToken(token).decimals
        );

        return {
          free: amount,
          locked: new FN(0),
          reserved: new FN(0),
          available: amount,
        };
      })
    );
  }
}

class BaseAstarAdapter extends BaseCrossChainAdapter {
  private balanceAdapter?: AstarBalanceAdapter;

  public async setApi(api: AnyApi) {
    this.api = api;

    await api.isReady;

    const chain = this.chain.id as ChainName;

    this.balanceAdapter = new AstarBalanceAdapter({
      chain,
      api,
      tokens: astarTokensConfig[chain],
    });
  }

  public subscribeTokenBalance(
    token: string,
    address: string
  ): Observable<BalanceData> {
    if (!this.balanceAdapter) {
      throw new ApiNotFound(this.chain.id);
    }

    return this.balanceAdapter.subscribeBalance(token, address);
  }

  public subscribeMaxInput(
    token: string,
    address: string,
    to: ChainName
  ): Observable<FN> {
    if (!this.balanceAdapter) {
      throw new ApiNotFound(this.chain.id);
    }

    return combineLatest({
      txFee:
        token === this.balanceAdapter?.nativeToken
          ? this.estimateTxFee({
              amount: FN.ZERO,
              to,
              token,
              address,
              signer: address,
            })
          : "0",
      balance: this.balanceAdapter
        .subscribeBalance(token, address)
        .pipe(map((i) => i.available)),
    }).pipe(
      map(({ balance, txFee }) => {
        const tokenMeta = this.balanceAdapter?.getToken(token);
        const feeFactor = 1.2;
        const fee = FN.fromInner(txFee, tokenMeta?.decimals).mul(
          new FN(feeFactor)
        );

        // always minus ed
        return balance
          .minus(fee)
          .minus(FN.fromInner(tokenMeta?.ed || "0", tokenMeta?.decimals));
      })
    );
  }

  public createTx(
    params: CrossChainTransferParams
  ):
    | SubmittableExtrinsic<"promise", ISubmittableResult>
    | SubmittableExtrinsic<"rxjs", ISubmittableResult> {
    if (this.api === undefined) {
      throw new ApiNotFound(this.chain.id);
    }

    const { address, amount, to, token } = params;
    const toChain = chains[to];

    const accountId = this.api?.createType("AccountId32", address).toHex();

    const supportsV1 = supportsV0V1Multilocation(this.api);

    let [dst, acc, ass] = supportsV1
      ? [
          {
            V1: {
              parents: 1,
              interior: { X1: { Parachain: toChain.paraChainId } },
            },
          },
          {
            V1: {
              parents: 0,
              interior: {
                X1: { AccountId32: { id: accountId, network: "Any" } },
              },
            },
          },
          {
            V1: [
              {
                id: { Concrete: { parents: 0, interior: "Here" } },
                fun: { Fungible: amount.toChainData() },
              },
            ],
          },
        ]
      : [
          {
            V3: {
              parents: 1,
              interior: { X1: { Parachain: toChain.paraChainId } },
            },
          } as any,
          {
            V3: {
              parents: 0,
              interior: { X1: { AccountId32: { id: accountId } } },
            },
          } as any,
          {
            V3: [
              {
                id: { Concrete: { parents: 0, interior: "Here" } },
                fun: { Fungible: amount.toChainData() },
              },
            ],
          } as any,
        ];

    if (token === this.balanceAdapter?.nativeToken) {
      return this.api?.tx.polkadotXcm.reserveTransferAssets(dst, acc, ass, 0);
    }

    const tokenIds: Record<string, string> = {
      // ids taken from https://github.com/colorfulnotion/xcm-global-registry/blob/main/assets/polkadot/polkadot_2000_assets.json
      // to interlay
      IBTC: "0x0001",
      INTR: "0x0002",
    };

    const tokenId = tokenIds[token];

    if (tokenId === undefined) {
      throw new CurrencyNotFound(token);
    }

    // count bytes without the leading '0x'
    const tokenIdByteCount = tokenId.replace("0x", "").length / 2;
    const paddedTokenId = tokenId.padEnd(
      // pad for a total length of required bytes plus '0x'
      2 * XCM_V3_GENERAL_KEY_DATA_BYTES + 2,
      "00"
    );

    // not native token: reconstruct asset argument
    ass = supportsV1
      ? {
          V1: [
            {
              id: {
                Concrete: {
                  parents: 1,
                  interior: {
                    X2: [
                      { Parachain: toChain.paraChainId },
                      { GeneralKey: tokenId },
                    ],
                  },
                },
              },
              fun: { Fungible: amount.toChainData() },
            },
          ],
        }
      : {
          V3: [
            {
              id: {
                Concrete: {
                  parents: 1,
                  interior: {
                    X2: [
                      { Parachain: toChain.paraChainId },
                      {
                        GeneralKey: {
                          length: tokenIdByteCount,
                          data: paddedTokenId,
                        },
                      },
                    ],
                  },
                },
              },
              fun: { Fungible: amount.toChainData() },
            },
          ],
        };

    return this.api?.tx.polkadotXcm.reserveWithdrawAssets(dst, acc, ass, 0);
  }
}

export class AstarAdapter extends BaseAstarAdapter {
  constructor() {
    super(chains.astar, astarRoutersConfig, astarTokensConfig.astar);
  }
}
