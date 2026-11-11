// E3a (5): HttpTransport sends x-selfsync-e2ee: 1 on every vault-scoped request when the codec is encrypted,
// never on a plaintext vault, never on GET keyring. keyring() consumes 200 and 404 and throws a tagged
// ConnError for anything else. commit sends cid only when present. Plus the four E2EE kinds in connstate.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { HttpTransport } from "../../src/transport";
import { BlockReason, ConnError, Endpoint, FailureKind, RecoveryKind, SyntheticKind, classifyConnectError, recoveryFor, blockedTip, linkNext, LINK_OK, LinkEventKind, LinkKind } from "../../src/connstate";

const { req } = vi.hoisted(() => ({ req: vi.fn() }));
vi.mock("obsidian", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), requestUrl: req }));

function res(status: number, opts: { json?: unknown; text?: string; arrayBuffer?: ArrayBuffer } = {}) {
  return { status, json: opts.json ?? {}, text: opts.text ?? "", arrayBuffer: opts.arrayBuffer ?? new ArrayBuffer(0) };
}
const validMeta = { path: "a.md", hash: "h", size: 3, mtime: 1, version: 2, chunks: ["h"] };
const HTTPS = "https://ok.example";
beforeEach(() => req.mockReset());
const headersOf = (n = 0) => (req.mock.calls[n][0] as { headers?: Record<string, string> }).headers ?? {};

describe("E3a (5) the E2EE header", () => {
  it("an encrypted transport sends the header on every vault-scoped request; a plaintext one never does", async () => {
    req.mockResolvedValue(res(200, { json: { version: 0, upserts: [], deletes: [] } }));
    const enc = new HttpTransport(HTTPS, "tok", "vault", "", "", "", true);
    await enc.changes(0);
    expect(headersOf()["x-selfsync-e2ee"]).toBe("1");
    expect(headersOf().authorization).toBe("Bearer tok");
    req.mockReset(); req.mockResolvedValue(res(200, { json: { status: "ready", version: 0 } }));
    await enc.status();
    expect(headersOf()["x-selfsync-e2ee"]).toBe("1");
    req.mockReset(); req.mockResolvedValue(res(200));
    await enc.putChunk("h", new Uint8Array([1]));
    expect(headersOf()["x-selfsync-e2ee"]).toBe("1");
    const plain = new HttpTransport(HTTPS, "tok", "vault");
    req.mockReset(); req.mockResolvedValue(res(200, { json: { version: 0, upserts: [], deletes: [] } }));
    await plain.changes(0);
    expect(headersOf()["x-selfsync-e2ee"]).toBeUndefined();
    plain.setEncrypted(true);
    req.mockReset(); req.mockResolvedValue(res(200, { json: { version: 0, upserts: [], deletes: [] } }));
    await plain.changes(0);
    expect(headersOf()["x-selfsync-e2ee"]).toBe("1");
    expect(plain.isEncrypted()).toBe(true);
  });

  it("keyring(): 200 is the text verbatim, 404 is not found, no header, anything else throws tagged Keyring", async () => {
    const t = new HttpTransport(HTTPS, "tok", "vault", "", "", "", true);
    req.mockResolvedValue(res(200, { text: '{"version":1}' }));
    expect(await t.keyring()).toEqual({ found: true, text: '{"version":1}' });
    expect((req.mock.calls[0][0] as { url: string }).url).toBe(`${HTTPS}/api/v/vault/keyring`);
    expect(headersOf()["x-selfsync-e2ee"]).toBeUndefined();
    req.mockReset(); req.mockResolvedValue(res(404, { text: "not found" }));
    expect(await t.keyring()).toEqual({ found: false });
    req.mockReset(); req.mockResolvedValue(res(503, { text: "its .keyring.json is missing" }));
    await expect(t.keyring()).rejects.toMatchObject({ info: { status: 503, endpoint: Endpoint.Keyring }, message: "its .keyring.json is missing" });
    req.mockReset(); req.mockResolvedValue(res(401, { text: "unauthorized" }));
    await expect(t.keyring()).rejects.toBeInstanceOf(ConnError);
    const owned = new HttpTransport(HTTPS, "tok", "vault", "alice");
    req.mockReset(); req.mockResolvedValue(res(404));
    await owned.keyring();
    expect((req.mock.calls[0][0] as { url: string }).url).toBe(`${HTTPS}/api/u/alice/vault/keyring`);
  });

  it("commit sends cid only when present", async () => {
    const t = new HttpTransport(HTTPS, "tok", "vault");
    req.mockResolvedValue(res(200, { json: validMeta }));
    await t.commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"] });
    expect(JSON.parse((req.mock.calls[0][0] as { body: string }).body)).not.toHaveProperty("cid");
    req.mockReset(); req.mockResolvedValue(res(200, { json: { ...validMeta, cid: "ab".repeat(32) } }));
    const m = await t.commit({ path: "a.md", hash: "h", size: 3, mtime: 1, chunks: ["h"], cid: "ab".repeat(32) });
    expect(JSON.parse((req.mock.calls[0][0] as { body: string }).body).cid).toBe("ab".repeat(32));
    expect(m.cid).toBe("ab".repeat(32));
  });
});

describe("E3a (6) the four E2EE failure kinds", () => {
  const info = (synthetic: SyntheticKind) => ({ wasLogin: false, endpoint: Endpoint.Keyring, hasStoredPassword: false, synthetic });
  it("each synthetic kind classifies to its FailureKind, recovers by AwaitUser, blocks the link, and has a tip", () => {
    const table: [SyntheticKind, FailureKind][] = [
      [SyntheticKind.E2eeJoinRequired, FailureKind.E2eeJoinRequired],
      [SyntheticKind.E2eeKeyringChanged, FailureKind.E2eeKeyringChanged],
      [SyntheticKind.E2eeKeyringMissing, FailureKind.E2eeKeyringMissing],
      [SyntheticKind.E2eeUnsupportedBuild, FailureKind.E2eeUnsupportedBuild],
    ];
    for (const [s, k] of table) {
      const cls = classifyConnectError(info(s));
      expect(cls.kind).toBe(k);
      expect(recoveryFor(cls).kind).toBe(RecoveryKind.AwaitUser);
      const link = linkNext(LINK_OK, { kind: LinkEventKind.Failed, cls });
      expect(link.kind).toBe(LinkKind.Blocked);
      expect(blockedTip(k as BlockReason).length).toBeGreaterThan(20);
    }
    expect(blockedTip(FailureKind.E2eeJoinRequired)).toMatch(/Join/);
    expect(blockedTip(FailureKind.E2eeUnsupportedBuild)).toMatch(/update the plugin/);
  });
});

describe("E3b (1) freshSignatureEndpoints anchors the signature on the /health hash", () => {
  it("returns the endpoints when the hashes agree, null when they disagree or /health has no hash", async () => {
    const { EMBEDDED_SIGNATURE } = await import("../../src/wiresignature");
    req.mockResolvedValueOnce(res(200, { json: { schemaHash: "sha256:h" } })).mockResolvedValueOnce(res(200, { json: { hash: "sha256:h", signature: EMBEDDED_SIGNATURE } }));
    expect(await HttpTransport.freshSignatureEndpoints(HTTPS)).toEqual(EMBEDDED_SIGNATURE.endpoints);
    expect((req.mock.calls[0][0] as { url: string }).url).toBe(`${HTTPS}/health`);
    expect((req.mock.calls[1][0] as { url: string }).url).toBe(`${HTTPS}/schema`);
    req.mockReset();
    req.mockResolvedValueOnce(res(200, { json: { schemaHash: "sha256:other" } })).mockResolvedValueOnce(res(200, { json: { hash: "sha256:h", signature: EMBEDDED_SIGNATURE } }));
    expect(await HttpTransport.freshSignatureEndpoints(HTTPS)).toBeNull();
    req.mockReset();
    req.mockResolvedValueOnce(res(200, { json: {} })).mockResolvedValueOnce(res(200, { json: { hash: "sha256:h", signature: EMBEDDED_SIGNATURE } }));
    expect(await HttpTransport.freshSignatureEndpoints(HTTPS)).toBeNull();
    req.mockReset();
    req.mockRejectedValueOnce(new Error("down"));
    expect(await HttpTransport.freshSignatureEndpoints(HTTPS)).toBeNull();
  });
});
