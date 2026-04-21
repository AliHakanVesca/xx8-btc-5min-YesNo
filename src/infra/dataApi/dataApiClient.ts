import type { AppEnv } from "../../config/schema.js";

export class DataApiClient {
  constructor(
    private readonly env: AppEnv,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getTrades(params: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request("/trades", params);
  }

  async getActivity(params: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request("/activity", params);
  }

  async getPositions(params: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request("/positions", params);
  }

  private async request(
    pathname: string,
    params: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown> {
    const url = new URL(pathname, this.env.POLY_DATA_API_BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Data API request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
}
