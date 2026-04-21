import {
  Chain as V1Chain,
  ClobClient as V1ClobClient,
  SignatureType as V1SignatureType,
  type ApiKeyCreds as V1ApiKeyCreds,
} from "@polymarket/clob-client";
import {
  Chain as V2Chain,
  ClobClient as V2ClobClient,
  SignatureTypeV2,
  type ApiKeyCreds as V2ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon, polygonAmoy } from "viem/chains";
import type { AppEnv } from "../../config/schema.js";

export interface DerivedApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface DeriveApiKeyResult {
  adapterVersion: "v1" | "v2";
  host: string;
  signerAddress: string;
  signatureType: number;
  funder?: string;
  creds: DerivedApiCreds;
}

function toV1Chain(chainId: number): V1Chain {
  return chainId === 80002 ? V1Chain.AMOY : V1Chain.POLYGON;
}

function toV2Chain(chainId: number): V2Chain {
  return chainId === 80002 ? V2Chain.AMOY : V2Chain.POLYGON;
}

function createSigner(env: AppEnv): { signer: WalletClient; signerAddress: string } {
  if (!env.BOT_PRIVATE_KEY) {
    throw new Error("BOT_PRIVATE_KEY gerekli. Once signer private key ekle.");
  }

  const account = privateKeyToAccount(env.BOT_PRIVATE_KEY as Hex);
  const signer = createWalletClient({
    account,
    chain: env.POLY_CHAIN_ID === 80002 ? polygonAmoy : polygon,
    transport: http(env.POLY_RPC_URL),
  }) as WalletClient;

  return {
    signer,
    signerAddress: account.address,
  };
}

function normalizeCreds(creds: V1ApiKeyCreds | V2ApiKeyCreds): DerivedApiCreds {
  return {
    key: creds.key,
    secret: creds.secret,
    passphrase: creds.passphrase,
  };
}

export async function createOrDeriveActiveApiKey(env: AppEnv): Promise<DeriveApiKeyResult> {
  const { signer, signerAddress } = createSigner(env);

  if (env.USE_CLOB_V2) {
    const client = new V2ClobClient({
      host: env.POLY_CLOB_BASE_URL,
      chain: toV2Chain(env.POLY_CHAIN_ID),
      signer,
      signatureType: env.POLY_SIGNATURE_TYPE as SignatureTypeV2,
      ...(env.POLY_FUNDER ? { funderAddress: env.POLY_FUNDER } : {}),
      retryOnError: true,
      throwOnError: true,
    });
    let creds: V2ApiKeyCreds;
    try {
      creds = await client.createApiKey();
    } catch {
      creds = await client.deriveApiKey();
    }
    return {
      adapterVersion: "v2",
      host: env.POLY_CLOB_BASE_URL,
      signerAddress,
      signatureType: env.POLY_SIGNATURE_TYPE,
      ...(env.POLY_FUNDER ? { funder: env.POLY_FUNDER } : {}),
      creds: normalizeCreds(creds),
    };
  }

  const client = new V1ClobClient(
    env.POLY_CLOB_BASE_URL,
    toV1Chain(env.POLY_CHAIN_ID),
    signer,
    undefined,
    env.POLY_SIGNATURE_TYPE as V1SignatureType,
    env.POLY_FUNDER,
    undefined,
    true,
    undefined,
    undefined,
    true,
    undefined,
    true,
  );
  let creds: V1ApiKeyCreds;
  try {
    creds = await client.createApiKey();
  } catch {
    creds = await client.deriveApiKey();
  }
  return {
    adapterVersion: "v1",
    host: env.POLY_CLOB_BASE_URL,
    signerAddress,
    signatureType: env.POLY_SIGNATURE_TYPE,
    ...(env.POLY_FUNDER ? { funder: env.POLY_FUNDER } : {}),
    creds: normalizeCreds(creds),
  };
}
