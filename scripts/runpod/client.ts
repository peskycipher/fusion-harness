export class ApiError extends Error {
  status: number;
  constructor(status: number, operation: string) {
    // Do not echo response bodies: templates can contain credentials.
    super(`${operation}: HTTP ${status}${status === 401 || status === 403 ? " (check credentials and permissions)" : ""}`);
    this.status = status;
  }
}
export type Request = (method: string, path: string, body?: unknown) => Promise<any>;
export function client(key: string, fetcher: typeof fetch = fetch): Request {
  if (!key) throw new Error("RUNPOD_API_KEY is required");
  return async (method, path, body) => {
    const response = await fetcher(`https://rest.runpod.io/v1${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000), redirect: "error",
    });
    if (!response.ok) throw new ApiError(response.status, `${method} ${path}`);
    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  };
}
