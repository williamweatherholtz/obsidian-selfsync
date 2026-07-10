# SelfSync — CMMC Level 2 technical-controls posture

> **The 110 controls are now tracked in the model.** We adopt NIST SP 800-171 rev2 / CMMC L2 as our
> **cybersecurity framework** — a strong control set we hold ourselves to by choice (an internal
> engineering standard), not an externally-mandated regulatory obligation. All 110 controls are authored
> as security `SystemRequirement`s in `.tracking/compliance/nist-800-171.sysml`, each `satisfy`-linked to
> the framework `Need` `nSecurityFramework` (`source = internal`), so posture is **computed** — not just
> this hand-written table. Disposition: **35 met**, **21 partial**, **52 operator-attested** (the operator
> is the verifier — *pending* sign-off, deliberately not fabricated), **2 POA&M** (open `issueCmmc*`).
> Each met/partial control carries a `#Verify` Test; the load-bearing ones (auth-gating, throttle, session
> timeout, isolation, MFA, password policy + reuse + forced-change, hashing, plugin allowlist) point at **real
> automated tests** (`method=test`) that fail if the control regresses — the rest are `method=inspect`
> code-cited claims with a behavioral test as a tracked follow-up. Check it any time: `keel coverage` /
> `keel tier-satisfaction` (verified vs uncovered) and `keel open-issues` (the POA&M gaps).
>
> **Implemented since the initial modeling:** IA.3.5.3 (multifactor authentication — TOTP + recovery codes
> for privileged/admin accounts), IA.3.5.8 (password-reuse history — last 5 hashes) and IA.3.5.9
> (forced-change-on-reset — `must_change` enforced in the auth extractor), all real-tested; their POA&M
> Issues are now resolved. **FIPS (3.13.11) is DEFERRED** — this deployment stores no genuine CUI, so
> FIPS-validated crypto is not required. **Remaining POA&M:** CUI-at-rest (3.13.16, operator volume
> encryption / E2EE deferred) and FIPS (deferred). Both are deliberate decisions, not unfinished work.


> **Scope & honesty note.** CMMC 2.0 Level 2 = the 110 practices of NIST SP 800-171 rev2 across 14
> families. **Most are organizational** (policy, training, physical, personnel, incident-response plans,
> media handling) and are satisfied by the *operator's* System Security Plan (SSP), never by application
> code. This document scores only the **technical, code-addressable** families — AC, AU, IA, SC, SI, CM —
> against the SelfSync codebase, and lists a **POA&M** (Plan of Action & Milestones) for the items that
> are a deliberate design decision or a feature-sized effort. It is engineering evidence for an SSP, not
> a certification. Actual CUI handling requires a full SSP, an assessor, and the operator controls below.

**Threat model (unchanged):** trusted self-hosted server, TLS-in-transit via a reverse proxy, **no
end-to-end encryption** (the server sees note content in plaintext). This is the deliberate architecture
(brief §constraints); it drives the SC.3.13.16 / FIPS decisions below.

Legend: **MET** (in code) · **MET\*** (in code, operator must retain/route) · **OPERATOR** (SSP /
deployment, code supports it) · **POA&M** (planned; see bottom).

## Access Control (AC 3.1.x)
| Practice | Status | Evidence / note |
|---|---|---|
| 3.1.1 / 3.1.2 limit access to authorized users / functions | MET | `AuthToken` on every route; `scoped()` ACL re-authorizes per request (HTTP + WS); admin funcs behind `require_admin` |
| 3.1.3 control CUI flow | MET (in-boundary) | read vs read-write grants enforced server-side; cross-boundary is OPERATOR (proxy/segmentation) |
| 3.1.5 / 3.1.6 / 3.1.7 least privilege / privileged funcs | MET / OPERATOR | bootstrap + explicit admin set; admin surface split to localhost; privileged actions audited |
| 3.1.8 limit unsuccessful logon attempts | MET | per-account throttle (10/5min → 429), argon2 permit pool; per-IP flood = OPERATOR (proxy) |
| **3.1.9 system-use / consent banner** | **MET** | `SYNC_LOGIN_BANNER` shown pre-auth in the admin page + setup wizard (via `/health`) |
| 3.1.10 session lock (screen lock) | OPERATOR | endpoint OS / Obsidian, not a sync server |
| **3.1.11 terminate session after inactivity** | **PARTIAL** | token idle-expiry (30 min) terminates on app-close/network-loss + a 30-day absolute cap; a connected-but-idle app slides `last_used` via keepalives, so this is liveness-based, not user-inactivity (screen-lock is the OS, 3.1.10) |
| 3.1.12 monitor/control remote access | MET / OPERATOR | all remote access token-gated + audited + revocable; central monitoring = SIEM (SSP) |
| 3.1.20 control external connections | OPERATOR | firewall / proxy exposure; safe defaults (localhost admin split, no CORS) support it |

## Audit & Accountability (AU 3.3.x)
| Practice | Status | Evidence / note |
|---|---|---|
| **3.3.1 create/retain audit logs** | **MET\*** | structured `audit` JSON events at ~25 sites; operator routes `target=audit` to an append-only sink + sets retention |
| **3.3.2 traceable to individuals** | **MET** | each event carries WHO (actor) / WHAT (action+target) / WHEN (UTC ms) / OUTCOME / SOURCE (client IP) |
| **3.3.3 reviewable event catalog** | **MET** | closed `action` enum in `audit.rs` |
| 3.3.4 alert on audit failure | OPERATOR | log-pipeline health = runtime (journald/Docker) |
| **3.3.5 / 3.3.6 correlation / reduction** | **MET\*** | single-line JSON is SIEM-parseable; correlation/report is the operator's SIEM |
| **3.3.7 authoritative timestamps** | **MET** | in-app UTC RFC-3339 ms, not runtime-dependent |
| 3.3.8 protect audit info | MET / OPERATOR | log-injection hardening (control-char stripping) prevents forged lines; at-rest protection = sink perms (SSP) |
| 3.3.9 limit audit management | OPERATOR | no in-app log-management surface to abuse; host/container perms (SSP) |

## Identification & Authentication (IA 3.5.x)
| Practice | Status | Evidence / note |
|---|---|---|
| 3.5.1 / 3.5.2 identify & authenticate users / devices | MET / OPERATOR | account + argon2id; device auth (mTLS/VPN) = OPERATOR |
| **3.5.3 multifactor authentication** | **MET\*** | TOTP (RFC 6238) + single-use recovery codes; self-enrolled via `/admin`, **enforced at login** for enrolled accounts. **`REQUIRE_ADMIN_MFA=1`** makes MFA **mandatory for privileged accounts** (`require_admin` denies until TOTP-enrolled) — an operator-configured control like TLS. Crypto (`totp.rs`) pinned to RFC 4231/6238 vectors. Non-privileged (plugin) MFA = follow-up |
| **3.5.7 password complexity** | **MET** | `validate_password_policy`: length + ≥2 char classes, or ≥15-char passphrase, on every set path |
| **3.5.8 prohibit password reuse** | **MET** | `users.rs` retains last 5 argon2 hashes; `change_password` rejects the current or any recent password |
| **3.5.9 temporary password / forced change** | **MET** | admin create/reset flags `must_change`; the `AuthToken` extractor 403s every route but change-password/logout until a new password is set |
| 3.5.10 store/transmit only protected passwords | MET | argon2id at rest, tokens sha256-hashed, TLS-in-transit; **client now defaults to token-only** (no plaintext password on device) |
| 3.5.11 obscure authentication feedback | MET | de-oracled login/register (dummy-hash constant work, uniform 401/403) |

## System & Communications Protection (SC 3.13.x)
| Practice | Status | Evidence / note |
|---|---|---|
| 3.13.1 / 3.13.5 boundary protection / separation | MET | public/admin router split; admin localhost-only by default; 16 MiB body cap; large-commit permit pool + **global and per-user WS connection caps** (no single account can exhaust the notification budget) |
| 3.13.6 deny by default | MET | registration closed by default; ACL deny-by-default; no CORS |
| **3.13.8 encrypt CUI in transit** | MET (client) / OPERATOR (server TLS) | client refuses cleartext http:// to a remote host — **centralized in `httpReq`, so the WHOLE channel incl. every token-bearing account call** is covered (loopback http allowed); server TLS termination + HSTS = proxy (SSP) |
| 3.13.10 key management | MET | random UUID tokens hashed at rest; per-user OsRng salts; env-rotatable bootstrap key |
| **3.13.11 FIPS-validated crypto** | **POA&M** | argon2/sha2 crates + client SHA-256 are not FIPS-validated modules; decision below |
| 3.13.15 authenticity of sessions | MET | bearer token off-URL (WS subprotocol); live WS re-authorization every ping/message |
| **3.13.16 protect CUI at rest** | **POA&M / OPERATOR** | notes stored plaintext (no E2EE); operator volume encryption is the near-term control; decision below |

## System & Information Integrity (SI 3.14.x)
| Practice | Status | Evidence / note |
|---|---|---|
| **3.14.1 flaw remediation** | **MET\*** | CI runs `cargo test`, `cargo audit`, `npm audit`, client tests on push/PR/weekly; operator applies updates |
| 3.14.2/4/5 malicious-code protection | MET (plugin gate) / OPERATOR (AV) | community-plugin code off-by-default + allowlist; endpoint AV = SSP |
| 3.14.6/7 monitor for attacks / unauthorized use | MET\* / OPERATOR | audit trail + brute-force throttle; SIEM/IDS = operator |
| data integrity | MET | per-chunk sha256 verify on store + whole-file re-hash on commit; fsync-durable atomic writes |

## Configuration Management (CM 3.4.x)
| Practice | Status | Evidence / note |
|---|---|---|
| 3.4.1 / 3.4.2 baseline / enforce secure settings | MET | env config with safe defaults; refuses to boot on a weak/short bootstrap password (a known-weak set **or** <8 chars) unless `ALLOW_WEAK_ADMIN=1` |
| 3.4.6 / 3.4.7 least functionality | MET | single binary; non-root uid 10001; slim image; admin-split; only required ports |
| 3.4.9 control user-installed software | MET | community-plugin propagation off-by-default + per-plugin allowlist |

---

## POA&M (Plan of Action & Milestones)

The two remaining open items are **deliberate architecture decisions**, not unfinished features. The three
feature-sized IA gaps (MFA 3.5.3, forced-change 3.5.9, reuse history 3.5.8) are now **implemented and
real-tested** — see the IA table above; their `issueCmmc*` Issues are resolved.

1. **SC.3.13.16 — CUI at rest (HIGH, decision).** **Recommendation: operator volume encryption now**
   (LUKS/dm-crypt or a cloud-provider encrypted volume on `/data`) — a legitimate, assessor-accepted
   at-rest control needing zero code. Application-level E2EE is the only defense against a *compromised
   server* but is a major redesign against the current trusted-server model; keep deferred and record the
   residual "a server-side attacker/insider reads plaintext" risk in the SSP.
2. **SC.3.13.11 — FIPS-validated cryptography (DEFERRED, decision).** This deployment stores **no genuine
   CUI**, so FIPS-validated crypto is not required and the item is formally deferred. If genuine CUI is ever
   stored, revisit: move the server to a FIPS-validated provider (e.g. an OpenSSL 3 FIPS provider for the
   hashing path) and retire the client's hand-rolled streaming SHA-256 in favor of a validated primitive.
   **Do not represent current crypto as FIPS-validated.**

## Operator responsibilities (must be in the SSP regardless of code)
TLS termination + HSTS at the proxy; per-IP rate-limiting / fail2ban; log forwarding, retention, and
alerting (a SIEM); volume/disk encryption for at-rest (`/data` and the client device's `data.json`);
endpoint AV + screen-lock; network/DMZ topology; device authentication (mTLS/VPN); non-privileged
day-to-day accounts; backup/restore; and the organizational families (AT, IR, MA, MP, PE, PS, RA, CA).
