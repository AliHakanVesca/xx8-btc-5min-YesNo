import type { AppEnv } from "../../config/schema.js";

export type FetchLike = typeof fetch;

export class GammaClient {
  constructor(
    private readonly env: AppEnv,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async findMarketBySlug(slug: string): Promise<unknown | null> {
    const url = new URL("/markets", this.env.POLY_GAMMA_BASE_URL);
    url.searchParams.set("slug", slug);
    const payload = await this.fetchJson(url.toString());

    if (Array.isArray(payload)) {
      return payload[0] ?? null;
    }
    if (Array.isArray((payload as any)?.data)) {
      return (payload as any).data[0] ?? null;
    }
    return payload ?? null;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Gamma request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
}
