// E3b (1) (2) (3) (7): the pure flow rules behind the dialogs. The password floor and the not-equal-to-login
// rule (D0111), the 409 decision table of spec section 6, the post-create keyring check (D0102), the join
// outcome wording (D0106), and the e2ee=1&vid= link flags (D0106). RED first; the modals render over these.
import { describe, it, expect } from "vitest";
import { passwordProblem, createConflictDecision, postCreateCheck, joinOutcomeText, MIN_E2EE_SERVER_VERSION, PASSWORD_FLOOR, LOST_PASSWORD_WARNING } from "../../src/e2ee/flows";
import { encodeSetupLink, parseSetupLink } from "../../src/connstr";
import { encodeShareLink, parseShareLink } from "../../src/sharelink";
import { EMBEDDED_SIGNATURE } from "../../src/wiresignature";
import { createKeyring } from "../../src/e2ee/keyring";

describe("E3b (1) the encryption password rules", () => {
  it("refuses fewer than 12 characters, a mismatch, and the login password", () => {
    expect(PASSWORD_FLOOR).toBe(12);
    expect(passwordProblem("short-pw", "short-pw", "login-pw")).toMatch(/at least 12/);
    expect(passwordProblem("twelve-chars!", "twelve-chars?", "login-pw")).toMatch(/do not match/);
    expect(passwordProblem("the-login-password", "the-login-password", "the-login-password")).toMatch(/login password/);
    expect(passwordProblem("correct horse battery staple", "correct horse battery staple", "other")).toBeNull();
    expect(LOST_PASSWORD_WARNING).toMatch(/lost/i);
  });
});

describe("E3b (1) the 409 decision table of spec section 6", () => {
  it("200 offers join only; 404 with the keyring route offers delete; 404 without it names the minimum server version", () => {
    expect(createConflictDecision({ found: true, text: "{}" }, true)).toEqual({ kind: "join" });
    expect(createConflictDecision({ found: false }, true)).toEqual({ kind: "delete" });
    expect(createConflictDecision({ found: false }, false)).toEqual({ kind: "upgradeServer", minVersion: MIN_E2EE_SERVER_VERSION });
    expect(createConflictDecision({ found: true, text: "{}" }, false)).toEqual({ kind: "join" });
    expect(MIN_E2EE_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    // the embedded signature lists the keyring route, so a server that serves THIS signature holds the route
    expect(EMBEDDED_SIGNATURE.endpoints).toContain("GET /api/v/:vault/keyring");
  });
});

describe("E3b (2) the post-create keyring check", () => {
  it("pins only when the returned vault_id is the one sent; 404 is an old server; another id fails closed", async () => {
    const { keyring } = await createKeyring("correct horse battery staple!", { kdf: { m_kib: 64, t: 1, p: 1 } });
    const sent = keyring.vault_id;
    expect(postCreateCheck(sent, { found: true, text: JSON.stringify(keyring) })).toEqual({ kind: "ok" });
    expect(postCreateCheck(sent, { found: false })).toEqual({ kind: "oldServer", minVersion: MIN_E2EE_SERVER_VERSION });
    expect(postCreateCheck(sent, { found: true, text: JSON.stringify({ ...keyring, vault_id: "AAAAAAAAAAAAAAAAAAAAAA==" }) })).toEqual({ kind: "mismatch" });
    expect(postCreateCheck(sent, { found: true, text: "{not json" })).toEqual({ kind: "mismatch" });
  });
});

describe("E3b (3) the join outcome wording", () => {
  it("tells apart corrupt, unsupported and wrong password, and names none of them for the others", () => {
    expect(joinOutcomeText("wrongPassword")).toMatch(/wrong password/i);
    expect(joinOutcomeText("unsupported")).toMatch(/KDF|update the plugin/i);
    expect(joinOutcomeText("corrupt")).toMatch(/corrupt/i);
    expect(joinOutcomeText("wrongPassword")).not.toMatch(/corrupt|unsupported/i);
  });
});

describe("E3b (7) the link flags", () => {
  it("the setup link and the share link carry e2ee=1 and vid, never VK or a password, and parse back", () => {
    const vid = "EBESExQVFhcYGRobHB0eHw==";
    const setup = encodeSetupLink({ server: "https://s.example", user: "alice", vault: "notes", e2ee: true, vid });
    expect(setup).toContain("e2ee=1");
    expect(setup).toContain("vid=");
    expect(parseSetupLink(setup)).toEqual({ server: "https://s.example", user: "alice", vault: "notes", e2ee: true, vid });
    const plain = encodeSetupLink({ server: "https://s.example", user: "alice", vault: "notes" });
    expect(plain).not.toContain("e2ee");
    expect(parseSetupLink(plain).e2ee).toBeUndefined();
    const share = encodeShareLink({ server: "https://s.example", token: "tok", e2ee: true, vid });
    expect(share).toContain("e2ee=1");
    expect(parseShareLink(share)).toEqual({ server: "https://s.example", token: "tok", e2ee: true, vid });
    expect(parseShareLink(encodeShareLink({ server: "https://s.example", token: "tok" })).e2ee).toBeUndefined();
    // a link never carries a key: the encoders have no such field, and a stray param is dropped on parse
    expect(parseSetupLink(setup + "&vk=deadbeef")).not.toHaveProperty("vk");
  });
});
