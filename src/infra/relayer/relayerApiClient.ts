import { createAbstractSigner } from "@polymarket/builder-abstract-signer";
import {
  buildProxyTransactionRequest,
} from "@polymarket/builder-relayer-client/dist/builder/proxy.js";
import { buildSafeCreateTransactionRequest } from "@polymarket/builder-relayer-client/dist/builder/create.js";
import { buildSafeTransactionRequest } from "@polymarket/builder-relayer-client/dist/builder/safe.js";
import { encodeProxyTransactionData } from "@polymarket/builder-relayer-client/dist/encode/proxy.js";
import {
  getContractConfig,
  isProxyContractConfigValid,
  isSafeContractConfigValid,
} from "@polymarket/builder-relayer-client/dist/config/index.js";
import {
  GET_DEPLOYED,
  GET_NONCE,
  GET_RELAY_PAYLOAD,
  GET_TRANSACTION,
  GET_TRANSACTIONS,
  SUBMIT_TRANSACTION,
} from "@polymarket/builder-relayer-client/dist/endpoints.js";
import {
  CallType,
  RelayerTransactionState,
  TransactionType,
  type ProxyTransactionArgs,
  type RelayerTransaction,
  type SafeCreateTransactionArgs,
  type SafeTransactionArgs,
  type Transaction,
  type TransactionRequest,
} from "@polymarket/builder-relayer-client";
import { createWalletClient, type Hex, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";
import { deriveExpectedFunderAddress, resolveRelayerExecutionMode, type RelayerExecutionMode } from "./txType.js";

export interface RelayerSubmission {
  transactionID: string;
  state: string;
  transactionHash: string;
}

export interface RelayerTxResult {
  transactionId: string;
  transactionHash?: string;
  state: string;
  confirmed: boolean;
  proxyAddress?: string;
}

function assertJsonRpcAddress(value: string | undefined, name: string): `0x${string}` {
  if (!value || !value.startsWith("0x")) {
    throw new Error(`${name} gecersiz veya eksik.`);
  }
  return value as `0x${string}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RelayerApiClient {
  private readonly walletClient: WalletClient;
  private readonly signerAddress: `0x${string}`;
  private readonly configuredFunder: `0x${string}`;
  private readonly expectedFunder: `0x${string}` | undefined;
  private readonly executionMode: RelayerExecutionMode;

  constructor(private readonly env: AppEnv) {
    if (!env.BOT_PRIVATE_KEY) {
      throw new Error("BOT_PRIVATE_KEY gerekli.");
    }
    if (!env.POLY_RELAYER_API_KEY || !env.POLY_RELAYER_API_KEY_ADDRESS) {
      throw new Error("POLY_RELAYER_API_KEY ve POLY_RELAYER_API_KEY_ADDRESS gerekli.");
    }

    const account = privateKeyToAccount(env.BOT_PRIVATE_KEY as Hex);
    this.signerAddress = account.address;
    this.walletClient = createWalletClient({
      account,
      chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
      transport: http(env.POLY_RPC_URL),
    });
    this.executionMode = resolveRelayerExecutionMode(env.POLY_SIGNATURE_TYPE);
    this.configuredFunder = assertJsonRpcAddress(env.POLY_FUNDER ?? env.BOT_WALLET_ADDRESS, "POLY_FUNDER");
    this.expectedFunder = deriveExpectedFunderAddress(this.signerAddress, env.POLY_CHAIN_ID, env.POLY_SIGNATURE_TYPE);
  }

  get mode(): RelayerExecutionMode {
    return this.executionMode;
  }

  get signer(): `0x${string}` {
    return this.signerAddress;
  }

  get funder(): `0x${string}` {
    return this.configuredFunder;
  }

  get expectedProxyWallet(): `0x${string}` | undefined {
    return this.expectedFunder;
  }

  ensureTopology(): void {
    if (this.executionMode === "direct") {
      throw new Error("Signature type 0 icin relayer degil dogrudan onchain path kullanilmalı.");
    }

    if (this.expectedFunder && this.expectedFunder.toLowerCase() !== this.configuredFunder.toLowerCase()) {
      throw new Error(
        `Configured funder ${this.configuredFunder} beklenen ${this.expectedFunder} ile eslesmiyor.`,
      );
    }

    if (this.env.POLY_RELAYER_API_KEY_ADDRESS?.toLowerCase() !== this.signerAddress.toLowerCase()) {
      throw new Error("POLY_RELAYER_API_KEY_ADDRESS signer adresiyle eslesmiyor.");
    }
  }

  async listTransactions(): Promise<RelayerTransaction[]> {
    return this.send(GET_TRANSACTIONS, "GET");
  }

  async getTransaction(transactionId: string): Promise<RelayerTransaction[]> {
    return this.send(GET_TRANSACTION, "GET", undefined, { id: transactionId });
  }

  async getNonce(): Promise<string> {
    const type = this.executionMode === "safe" ? TransactionType.SAFE : TransactionType.PROXY;
    const payload = await this.send<{ nonce: string }>(GET_NONCE, "GET", undefined, {
      address: this.signerAddress,
      type,
    });
    return payload.nonce;
  }

  async getRelayPayload(): Promise<{ address: string; nonce: string }> {
    const payload = await this.send<{ address: string; nonce: string }>(GET_RELAY_PAYLOAD, "GET", undefined, {
      address: this.signerAddress,
      type: TransactionType.PROXY,
    });
    return payload;
  }

  async isSafeDeployed(): Promise<boolean> {
    const address = this.configuredFunder;
    const response = await this.send<{ deployed: boolean }>(GET_DEPLOYED, "GET", undefined, { address });
    return response.deployed;
  }

  async deploySafe(): Promise<RelayerTxResult> {
    this.ensureTopology();
    if (this.executionMode !== "safe") {
      throw new Error("deploySafe sadece SAFE modda kullanilir.");
    }

    const config = getContractConfig(this.env.POLY_CHAIN_ID);
    if (!isSafeContractConfigValid(config.SafeContracts)) {
      throw new Error("Bu chain icin safe config gecersiz.");
    }

    const abstractSigner = createAbstractSigner(this.env.POLY_CHAIN_ID, this.walletClient);
    const request = await buildSafeCreateTransactionRequest(abstractSigner, config.SafeContracts, {
      from: this.signerAddress,
      chainId: this.env.POLY_CHAIN_ID,
      paymentToken: "0x0000000000000000000000000000000000000000",
      payment: "0",
      paymentReceiver: "0x0000000000000000000000000000000000000000",
    } satisfies SafeCreateTransactionArgs);

    const submitted = await this.submit(request);
    const finalTx = await this.wait(submitted.transactionID);
    return {
      transactionId: submitted.transactionID,
      transactionHash: finalTx.transactionHash ?? submitted.transactionHash,
      state: finalTx.state,
      confirmed: finalTx.state === RelayerTransactionState.STATE_CONFIRMED,
      ...(finalTx.proxyAddress || this.configuredFunder
        ? { proxyAddress: finalTx.proxyAddress ?? this.configuredFunder }
        : {}),
    };
  }

  async ensureWalletDeployed(): Promise<void> {
    if (this.executionMode !== "safe") {
      return;
    }
    if (!(await this.isSafeDeployed())) {
      await this.deploySafe();
    }
  }

  async executeTransactions(transactions: Transaction[], metadata = ""): Promise<RelayerTxResult> {
    this.ensureTopology();

    const config = getContractConfig(this.env.POLY_CHAIN_ID);
    const abstractSigner = createAbstractSigner(this.env.POLY_CHAIN_ID, this.walletClient);
    let request: TransactionRequest;

    if (this.executionMode === "safe") {
      await this.ensureWalletDeployed();
      if (!isSafeContractConfigValid(config.SafeContracts)) {
        throw new Error("Bu chain icin safe config gecersiz.");
      }

      request = await buildSafeTransactionRequest(abstractSigner, {
        from: this.signerAddress,
        nonce: await this.getNonce(),
        chainId: this.env.POLY_CHAIN_ID,
        transactions: transactions.map((transaction) => ({
          to: transaction.to,
          operation: 0,
          data: transaction.data,
          value: transaction.value,
        })),
      } satisfies SafeTransactionArgs, config.SafeContracts, metadata);
    } else {
      if (!isProxyContractConfigValid(config.ProxyContracts)) {
        throw new Error("Bu chain icin proxy config gecersiz.");
      }

      const relayPayload = await this.getRelayPayload();
      const proxyBatch = transactions.map((transaction) => ({
        to: transaction.to,
        typeCode: CallType.Call,
        data: transaction.data,
        value: transaction.value,
      }));
      request = await buildProxyTransactionRequest(abstractSigner, {
        from: this.signerAddress,
        nonce: relayPayload.nonce,
        gasPrice: "0",
        data: encodeProxyTransactionData(proxyBatch),
        relay: relayPayload.address,
      } satisfies ProxyTransactionArgs, config.ProxyContracts, metadata);
    }

    const submitted = await this.submit(request);
    const finalTx = await this.wait(submitted.transactionID);
    return {
      transactionId: submitted.transactionID,
      transactionHash: finalTx.transactionHash ?? submitted.transactionHash,
      state: finalTx.state,
      confirmed: finalTx.state === RelayerTransactionState.STATE_CONFIRMED,
      ...(finalTx.proxyAddress ? { proxyAddress: finalTx.proxyAddress } : {}),
    };
  }

  private async submit(request: TransactionRequest): Promise<RelayerSubmission> {
    return this.send(SUBMIT_TRANSACTION, "POST", request);
  }

  async wait(
    transactionId: string,
    maxPolls = 30,
    pollFrequencyMs = 2000,
  ): Promise<RelayerTransaction> {
    let lastState: string | undefined;
    for (let index = 0; index < maxPolls; index += 1) {
      const transactions = await this.getTransaction(transactionId);
      const transaction = transactions[0];
      if (!transaction) {
        await sleep(pollFrequencyMs);
        continue;
      }
      lastState = transaction.state;
      if (transaction.state === RelayerTransactionState.STATE_CONFIRMED) {
        return transaction;
      }
      if (
        transaction.state === RelayerTransactionState.STATE_FAILED ||
        transaction.state === RelayerTransactionState.STATE_INVALID
      ) {
        const errorMsg = (transaction as RelayerTransaction & { errorMsg?: string }).errorMsg;
        throw new Error(errorMsg ?? `Relayer tx ${transactionId} ${transaction.state}`);
      }
      await sleep(pollFrequencyMs);
    }
    throw new Error(`Relayer tx ${transactionId} did not confirm before timeout${lastState ? ` (lastState=${lastState})` : ""}`);
  }

  private async send<T>(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.env.POLY_RELAYER_BASE_URL);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        RELAYER_API_KEY: this.env.POLY_RELAYER_API_KEY!,
        RELAYER_API_KEY_ADDRESS: this.env.POLY_RELAYER_API_KEY_ADDRESS!,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Relayer ${method} ${path} failed: ${response.status} ${text}`);
    }

    return response.json() as Promise<T>;
  }
}
