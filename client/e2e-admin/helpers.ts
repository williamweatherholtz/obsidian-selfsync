// Self-contained helpers for the admin-page Playwright suite: spawn the real server binary on an
// ephemeral port, and compute a TOTP code (to drive the MFA enable flow) with node crypto — matching
// the server's totp.rs (RFC 6238, SHA-1, 30s step, 6 digits). No coupling to the vitest e2e helpers.
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createHmac } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

// Playwright runs from the config dir (client/), transpiling to CJS — so resolve the server binary
// from process.cwd() rather than import.meta.url (which isn't available under the CJS loader).
export const serverBin = path.resolve(
  process.cwd(),
  "../server/target/debug/new-livesync-server" + (process.platform === "win32" ? ".exe" : ""),
);
export const canRun = existsSync(serverBin);

export interface RunningServer { base: string; stop: () => Promise<void>; }

// Spawn a throwaway server: admin/admin (ALLOW_WEAK_ADMIN opts past the default-credential boot guard),
// merged admin surface on one ephemeral port. Resolves once it logs its listening address.
export async function startServer(): Promise<RunningServer> {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "nls-admin-pw-"));
  const srv: ChildProcess = spawn(serverBin, [], {
    env: {
      ...process.env,
      DATA_ROOT: dataDir, BIND_ADDR: "127.0.0.1:0",
      SYNC_USER: "admin", SYNC_PASSWORD: "admin", ALLOW_WEAK_ADMIN: "1",
      ADMIN_BIND_ADDR: "merge", LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not report a listening address in time")), 30000);
    const onData = (b: Buffer) => { const m = b.toString().match(/listening on (\S+)/); if (m) { clearTimeout(timer); resolve(`http://${m[1]}`); } };
    srv.stderr!.on("data", onData); srv.stdout!.on("data", onData);
  });
  return {
    base,
    stop: async () => {
      srv.kill();
      await new Promise((r) => setTimeout(r, 100));
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

function base32Decode(s: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0; const out: number[] = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const idx = A.indexOf(c); if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

// The current 6-digit TOTP code for a base32 secret — what an authenticator app would show right now.
export function totp(secretB32: string, nowMs: number = Date.now()): string {
  const key = base32Decode(secretB32);
  const counter = Math.floor(nowMs / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(buf).digest();
  const off = mac[19] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}
