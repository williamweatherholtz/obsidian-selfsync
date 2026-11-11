// D0115 (ACCEPTED 2026-11-11 by wweatherholtz, '115 accepted', st012) — E2EE KDF default - Argon2id m_kib=32768, t=3, p=1, on the Android Measurement with iOS assumed similar
// Recorded via `keel record decision` (D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, D0106): flip status + add the d0115Accept event on sign-off.
package Decision0115 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0115 : Decision {
        :>> id = "98ccc8d5-28e7-41a5-b65a-52952802cd48";
        :>> title = "E2EE KDF default - Argon2id m_kib=32768, t=3, p=1, on the Android Measurement with iOS assumed similar";
        :>> createdAt = "2026-11-11";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::accepted;
        :>> context = "D0112 made the shipped Argon2id cost an owner-measured value and asked for one iOS and one Android device, four Measurements, before a default Decision. On 2026-11-11 the owner timed the plugin's own derivation on an Android phone through the KDF Timer page in Firefox: 4.73, 4.80 and 4.77 seconds at 64 MiB, three passes, one lane, recorded as Measurement e2eePhoneKdfWallTimeM1. The owner then said, verbatim, Not gonna do ios. Proceed, and Assume similar (Statements st010 and st011). The page cannot read process memory, so no peak-memory Measurement exists. The protocol target is about two seconds at Join.";
        :>> decision = "The shipped default is m_kib=32768, t=3, p=1. KDF_DEFAULT in client/src/e2ee/kdf.ts equals it. The basis is one Android wall-time Measurement, e2eePhoneKdfWallTimeM1, and the owner's recorded direction that iOS is assumed similar and not measured. This amends the D0112 count: one Measurement and two Statements replace the four Measurements. Peak memory is taken as the parameter itself, 32 MiB of Argon2 blocks plus the JavaScript heap, not measured. The define flip in esbuild.config.mjs waits for the owner's acceptance of this Decision, as D0112 and the build check require. Each keyring stores its parameters, so a vault created at 64 MiB keeps working.";
        :>> rationale = "Argon2id in pure JS scales close to linearly in m_kib times t. Halving memory from 64 MiB to 32 MiB at three passes projects to about 2.4 seconds in Firefox and less in the Chrome WebView that Obsidian Android uses, near the two-second target. 32 MiB at three passes stays above the OWASP floor of 19 MiB at two passes and matches the Bitwarden Argon2id memory default. The 12-character floor of D0111 is the larger brake on guessing. ALTERNATIVES: (i) keep 64 MiB t=3 - rejected, 4.77 seconds measured, over target on the one real phone. (ii) 64 MiB t=2 - rejected, projects to 3.2 seconds, still over. (iii) 19 MiB t=2 - rejected, the OWASP floor with no margin and a fifth of the default guess cost. (iv) wait for an iOS Measurement - rejected by the owner, Statement st010.";
        :>> consequences = "KDF_DEFAULT changes to 32768, 3, 1 with its unit test. The perf protocol and the design spec name the new default and the Android-only basis. The KDF Timer page defaults to the same row. After acceptance the AI flips SELFSYNC_E2EE to true, bumps the plugin version and releases, and the E4 clause 7 result re-judges. Old keyrings at 64 MiB stay valid because the parameters travel with the keyring.";
    }
    #DerivedFrom dependency from d0115 to us015;
    #DependsOn dependency from d0115 to d0112;
    #DependsOn dependency from d0115 to d0111;
    // acceptance event (D0066/D0106 - human-judged, not fabricated): the owner's words in chat on 2026-11-11, recorded verbatim as st012
    verification d0115Accept : Test { :>> id = "c8417f3b-ca90-4db6-831c-90a5e4a25861"; :>> method = VerificationMethod::confirmation; :>> procedureText = "owner's words: '115 accepted' (chat, 2026-11-11, Statement st012) in answer to the AI's prompt to say accept D0115 for m_kib=32768, t=3, p=1. Read-back: the words name 115, the Decision number, and the prompt named the literal."; }
    part d0115AcceptR1 : TestResult { :>> id = "17e45217-45c3-4978-b5cf-ec1e0e2ded3e"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "1ee36b1"; :>> judgedAt = "2026-11-11"; :>> judgedBy = "wweatherholtz"; :>> createdBy = "wweatherholtz"; }
}
