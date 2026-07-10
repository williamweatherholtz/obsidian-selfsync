import { describe, it, expect } from "vitest";
import { HttpTransport } from "../src/transport";

// crit-round SC.3.13.8: the cleartext-http refusal is now CENTRALIZED in httpReq, so every token-
// bearing account-management call (not just login/register/sync) refuses to transmit to a cleartext
// remote. These previously issued requests with the bearer token in the clear.
describe("SC.3.13.8: cleartext-remote refusal covers the account-management calls", () => {
  it("token-bearing static calls to an http:// remote are refused", async () => {
    await expect(HttpTransport.listVaults("http://remote.example", "tok")).rejects.toThrow(/unencrypted http/i);
    await expect(HttpTransport.createVault("http://remote.example", "tok", "v")).rejects.toThrow(/unencrypted http/i);
    await expect(HttpTransport.myVaults("http://remote.example", "tok")).rejects.toThrow(/unencrypted http/i);
  });

  it("an https remote is NOT refused for the cleartext reason", async () => {
    // https passes the cleartext guard; it then proceeds to the (stubbed) request layer — so it must
    // not reject with the cleartext message.
    await HttpTransport.listVaults("https://ok.example", "tok").catch((e: any) => {
      expect(String(e?.message ?? e)).not.toMatch(/unencrypted http/i);
    });
  });
});
