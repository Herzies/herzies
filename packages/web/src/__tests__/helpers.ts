import { vi } from "vitest";

/**
 * Create a chainable Supabase mock client.
 *
 * Usage: configure responses per table, then call createMockAdmin() to get the client.
 *
 * const admin = createMockAdmin({
 *   trades: { data: { id: "t1", state: "pending" }, error: null },
 *   herzies: { data: { user_id: "u1", name: "Test" }, error: null },
 * });
 */

interface MockResponse {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

interface RpcResponse {
  data?: unknown;
  error?: unknown;
}

export function createMockAdmin(
  tableResponses: Record<string, MockResponse> = {},
  rpcResponses: Record<string, RpcResponse> = {},
) {
  const updateFn = vi.fn();
  const insertFn = vi.fn();

  function makeChain(response: MockResponse) {
    const result = {
      data: response.data ?? null,
      error: response.error ?? null,
      count: response.count ?? null,
    };

    const chain: Record<string, unknown> = {};

    const methods = [
      "select",
      "insert",
      "update",
      "delete",
      "upsert",
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "in",
      "not",
      "is",
      "or",
      "ilike",
      "like",
      "order",
      "limit",
      "single",
      "maybeSingle",
      "head",
    ];

    for (const method of methods) {
      if (method === "update") {
        chain[method] = (...args: unknown[]) => {
          updateFn(...args);
          return chain;
        };
      } else if (method === "insert") {
        chain[method] = (...args: unknown[]) => {
          insertFn(...args);
          return chain;
        };
      } else {
        chain[method] = vi.fn().mockReturnValue(chain);
      }
    }

    // Make the chain thenable so await resolves to the result
    chain.then = (resolve: (v: unknown) => void) => resolve(result);

    return chain;
  }

  return {
    from: vi.fn((table: string) => {
      const response = tableResponses[table] ?? { data: null, error: null };
      return makeChain(response);
    }),
    rpc: vi.fn((fn: string, _params?: unknown) => {
      const response = rpcResponses[fn] ?? { data: null, error: null };
      return Promise.resolve(response);
    }),
    _updateFn: updateFn,
    _insertFn: insertFn,
  };
}

/** Build a fake Request object for testing route handlers */
export function fakeRequest(
  body: unknown,
  options: { method?: string; token?: string } = {},
): Request {
  const { method = "POST", token = "valid-token" } = options;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return new Request("http://localhost/api/test", {
    method,
    headers,
    body: method !== "GET" ? JSON.stringify(body) : undefined,
  });
}

/** Parse JSON from a NextResponse/Response */
export async function responseJson(res: Response): Promise<unknown> {
  return res.json();
}
