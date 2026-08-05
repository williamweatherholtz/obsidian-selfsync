import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpTransport } from "../src/transport";
import { CommitConflictError } from "../src/protocol";

// transport.ts is the client's HTTP layer: error/status mapping, the
// 30 s timeout race, plain-text error surfacing, and login's mustChange gate. It was the biggest
// client test gap (343 LOC, ~21 LOC of tests). We drive the REAL transport over a controllable
// `requestUrl` (the only obsidian value it imports), asserting SPECIFIC outcomes — never a tautology.
const { req } = vi.hoisted(() => ({ req: vi.fn() }));
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestUrl: req,
}));

// Build a fake RequestUrlResponse. `json` is a plain value here (real obsidian's is a throwing getter,
// but transport reads it as a property and we control what it sees).
function res(status: number, opts: { json?: unknown; text?: string; arrayBuffer?: ArrayBuffer } = {}) {
  return { status, json: opts.json ?? {}, text: opts.text ?? "", arrayBuffer: opts.arrayBuffer ?? new ArrayBuffer(0) };
}
const validMeta = { path: "a.md", hash: "h", size: 3, mtime: 1, version: 2, chunks: ["h"] };

beforeEach(() => req.mockReset());

const HTTPS = "https://ok.example";
const t = () => new HttpTransport(HTTPS, "tok", "vault");

describe("cleartext-remote refusal (SC.3.13.8)", () => {
  it("refuses token-bearing calls to an http:// remote", async () => {
    await expect(HttpTransport.listVaults("http://remote.example", "tok")).rejects.toThrow(/unencrypted http/i);
    await expect(HttpTransport.createVault("http://remote.example", "tok", "v")).rejects.toThrow(/unencrypted http/i);
    await expect(HttpTransport.myVaults("http://remote.example", "tok")).rejects.toThrow(/unencrypted http/i);
    expect(req).not.toHaveBeenCalled(); // refused BEFORE any request went out
  });

  it("an https remote PROCEEDS to the request (not refused)", async () => {
    // The fixed version: assert the call actually reaches the request layer and succeeds — the old
    // test asserted only inside .catch(), so if the call resolved the assertion never ran.
    req.mockResolvedValue(res(200, { json: { vaults: ["default"] } }));
    await expect(HttpTransport.listVaults(HTTPS, "tok")).resolves.toEqual(["default"]);
    expect(req).toHaveBeenCalledOnce();
  });

  it("the constructor rejects a cleartext remote baseUrl", () => {
    expect(() => new HttpTransport("http://remote.example", "tok", "v")).toThrow(/unencrypted http/i);
    expect(() => new HttpTransport("http://127.0.0.1:8789", "tok", "v")).not.toThrow(); // loopback allowed
  });
});

describe("commit() status→error mapping", () => {
  it("maps 409 to CommitConflictError (version advanced, not a clobber)", async () => {
    req.mockResolvedValue(res(409, { text: "conflict" }));
    await expect(t().commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] }))
      .rejects.toBeInstanceOf(CommitConflictError);
  });
  it("maps 404 (missing chunk) to CommitConflictError (retryable, not OFFLINE)", async () => {
    req.mockResolvedValue(res(404));
    await expect(t().commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] }))
      .rejects.toBeInstanceOf(CommitConflictError);
  });
  it("maps other non-200 to a generic Error, NOT a CommitConflictError", async () => {
    req.mockResolvedValue(res(500));
    const err = await t().commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CommitConflictError);
  });
  it("200 returns the validated FileMeta", async () => {
    req.mockResolvedValue(res(200, { json: validMeta }));
    await expect(t().commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] })).resolves.toEqual(validMeta);
  });
  it("wires expectedVersion as snake_case expected_version, omitted when unset", async () => {
    req.mockResolvedValue(res(200, { json: validMeta }));
    await t().commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"], expectedVersion: 7 });
    expect(JSON.parse(req.mock.calls[0][0].body).expected_version).toBe(7);
    req.mockClear();
    await t().commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] });
    expect(JSON.parse(req.mock.calls[0][0].body)).not.toHaveProperty("expected_version");
  });
  it("stamps the transport's device provenance (snake_case) on every commit; omits it when unconfigured", async () => {
    req.mockResolvedValue(res(200, { json: validMeta }));
    // A transport carrying this device's identity stamps device_id/device_name on the commit body.
    const withDev = new HttpTransport(HTTPS, "tok", "vault", "", "dev-uuid-1", "Will's Desktop");
    await withDev.commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] });
    const body = JSON.parse(req.mock.calls[0][0].body);
    expect(body.device_id).toBe("dev-uuid-1");
    expect(body.device_name).toBe("Will's Desktop");
    // The default transport (no identity) omits both — the server records the change as unknown-device.
    req.mockClear();
    await t().commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] });
    const bare = JSON.parse(req.mock.calls[0][0].body);
    expect(bare).not.toHaveProperty("device_id");
    expect(bare).not.toHaveProperty("device_name");
  });
});

describe("fileMeta() / status() / missing() mapping", () => {
  it("fileMeta 404 → null; 200 → meta; 500 → throw", async () => {
    req.mockResolvedValueOnce(res(404));
    await expect(t().fileMeta("a.md")).resolves.toBeNull();
    req.mockResolvedValueOnce(res(200, { json: validMeta }));
    await expect(t().fileMeta("a.md")).resolves.toEqual(validMeta);
    req.mockResolvedValueOnce(res(500));
    await expect(t().fileMeta("a.md")).rejects.toThrow(/meta: HTTP 500/);
  });
  it("status() rejects non-200 and validates the 200 shape", async () => {
    req.mockResolvedValueOnce(res(503));
    await expect(t().status()).rejects.toThrow(/status: HTTP 503/);
    req.mockResolvedValueOnce(res(200, { json: { status: "ok", detail: "", version: 4, api_version: 1 } }));
    await expect(t().status()).resolves.toMatchObject({ status: "ok", version: 4, apiVersion: 1 });
  });
  it("missing() rejects a malformed (non-string[]) response", async () => {
    req.mockResolvedValueOnce(res(200, { json: { missing: [1, 2] } }));
    await expect(t().missing(["h"])).rejects.toThrow(/malformed/);
    req.mockResolvedValueOnce(res(200, { json: { missing: ["h1"] } }));
    await expect(t().missing(["h1"])).resolves.toEqual(["h1"]);
  });
});

describe("errText: surface the server's plain-text message", () => {
  it("surfaces a short text body, falls back to status for empty/huge bodies", async () => {
    req.mockResolvedValueOnce(res(400, { text: "invalid vault name" }));
    await expect(HttpTransport.createVault(HTTPS, "tok", "bad/name")).rejects.toThrow(/invalid vault name/);
    req.mockResolvedValueOnce(res(400, { text: "x".repeat(400) })); // >300 → fall back
    await expect(HttpTransport.createVault(HTTPS, "tok", "v")).rejects.toThrow(/create vault: HTTP 400/);
    req.mockResolvedValueOnce(res(400, { text: "" })); // empty → fall back
    await expect(HttpTransport.createVault(HTTPS, "tok", "v")).rejects.toThrow(/create vault: HTTP 400/);
  });
});

describe("login() mustChange gate + testConnection", () => {
  it("returns mustChange=true iff must_change_password, throws on non-200", async () => {
    req.mockResolvedValueOnce(res(200, { json: { token: "T", must_change_password: true } }));
    await expect(HttpTransport.login(HTTPS, "u", "p")).resolves.toEqual({ token: "T", mustChange: true });
    req.mockResolvedValueOnce(res(200, { json: { token: "T" } }));
    await expect(HttpTransport.login(HTTPS, "u", "p")).resolves.toEqual({ token: "T", mustChange: false });
    req.mockResolvedValueOnce(res(401));
    await expect(HttpTransport.login(HTTPS, "u", "bad")).rejects.toThrow(/HTTP 401/);
  });
  it("login refuses a cleartext remote before sending the password", async () => {
    await expect(HttpTransport.login("http://remote.example", "u", "p")).rejects.toThrow(/unencrypted http/i);
    expect(req).not.toHaveBeenCalled();
  });
  it("changePassword maps 401 to a clear message and 200 to the fresh token", async () => {
    req.mockResolvedValueOnce(res(401));
    await expect(HttpTransport.changePassword(HTTPS, "tok", "wrong", "new")).rejects.toThrow(/current password is incorrect/);
    req.mockResolvedValueOnce(res(200, { json: { token: "FRESH" } }));
    await expect(HttpTransport.changePassword(HTTPS, "tok", "old", "new")).resolves.toBe("FRESH");
  });
  it("testConnection is true on 200, false on non-200", async () => {
    req.mockResolvedValueOnce(res(200));
    await expect(HttpTransport.testConnection(HTTPS)).resolves.toBe(true);
    req.mockResolvedValueOnce(res(500));
    await expect(HttpTransport.testConnection(HTTPS)).resolves.toBe(false);
  });
});

describe("30 s request timeout (R11-HIGH): a stalled request becomes a rejection", () => {
  it("rejects with a timeout when requestUrl stalls past the deadline", async () => {
    vi.useFakeTimers();
    // Use a promise we can SETTLE in cleanup rather than one that never resolves — an orphaned
    // forever-pending promise leaves a dangling microtask that can block vitest's clean exit.
    let settle: (v: unknown) => void = () => {};
    try {
      req.mockReturnValue(new Promise((resolve) => { settle = resolve; }));
      const p = t().status();
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_000); // the 30 s timeout wins the race
      await assertion;
    } finally {
      settle(res(200, { json: { status: "ok", detail: "", version: 0 } })); // release the stalled request
      vi.useRealTimers();
    }
  });
});
