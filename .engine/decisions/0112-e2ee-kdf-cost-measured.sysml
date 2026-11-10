// D0112 (PROPOSED — NOT YET ACCEPTED) — E2EE KDF cost - owner-measured on real phones, Encrypt hidden until measured
// Recorded via `keel record decision` (engine D0105 RMWX axis; issue054). Acceptance is a separate explicit
// human gate (method=confirmation, engine D0106): flip status + add the d0112Accept event on sign-off.
package Decision0112 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;
    private import EngineRelationships::*;

    part d0112 : Decision {
        :>> id = "847ee279-ca53-48ab-a165-8f71f6ff51a3";
        :>> title = "E2EE KDF cost - owner-measured on real phones, Encrypt hidden until measured";
        :>> createdAt = "2026-11-10";
        :>> createdBy = "ai";
        :>> status = DecisionStatus::proposed;
        :>> context = "The Argon2id default of 64 MiB, three passes and one lane is measured only on the owner's desktop, 2.7 seconds in pure JS. The mobile WebViews have less memory and no measurement. The AI cannot run a real phone. Round-4 panel findings PESSIMIST-2 3 and SE 2 and 3 found two gaps. The fallback had no exit and no recording slot, and it sat inside the recovery Decision D0111.";
        :>> decision = "Two manual Indicators record the phone cost: e2eePhoneKdfWallTime in seconds and e2eePhoneKdfPeakMemory in MiB. The owner runs the real-device protocol on one iOS and one Android device. The owner records two Measurements under each Indicator, one per device, with keel record measurement, with source prefixed ios: or android:. The shipped default is then a separate Decision that depends on this one, cites the four Measurement ids and states m_kib, t and p. The AI may record it as proposed. Clause 7 of E4 passes only when that Decision has status accepted with its acceptance event and the keyring parameters equal its values. Until the default Decision is accepted, the E4 DoD cannot pass. Its result records fail with the reason 'awaiting the accepted KDF default Decision'. The default Decision states its values in the literal form m_kib=N, t=N, p=N. esbuild.config.mjs itself fails the build when the literal is true unless the model holds an accepted Decision that depends on this one with equal values, so release.yml and verify-released.yml both enforce it through npm run build, and a vitest test asserts the same rule. A release cut before that ships with the Encrypt option hidden behind the esbuild define SELFSYNC_E2EE, a committed literal in esbuild.config.mjs so a tag rebuilds byte-identical. The define gates every KDF entry: create, join and Re-enrol. With it off, an unpinned 200, an e2ee=1 link, the changed-keyring card and the missing-keyring dialog block with the reason 'this plugin build does not support encrypted vaults', with no codec decision and no plaintext enrolment. A pinned device is unaffected. The commit that follows the owner's acceptance of the default Decision flips the literal to true, so a tag never carries an accidental value. The release notes say so. The parameters live in the keyring. A later change needs e2eePasswordChange, because v1 has no re-wrap route.";
        :>> rationale = "An unmeasured 64 MiB default on a phone is a memory-kill risk. A blocked plugin release for unrelated fixes is a cost the fallback avoids. A fail result that names the missing Measurement is honest state and shows in orient. ALTERNATIVES: (i) block every release until the measurement - rejected, unrelated fixes wait. (ii) ship 64 MiB unmeasured - rejected, the panel found it. (iii) keep this policy inside D0111 - rejected, the owner would accept a release policy under a recovery title.";
        :>> consequences = ".tracking/indicators.sysml gains the two Indicators. The real-device perf protocol gains the KDF row and the fold fixture check. E4 stays red until the default Decision is accepted. The perf protocol KDF row, added by E3b, names the instrument per OS: adb shell dumpsys meminfo on Android, Xcode Instruments on a developer-signed Obsidian on iOS, or a recorded 'not measurable' with the reason. D0111 keeps only recovery, the floor, double entry and progress.";
    }
    #DerivedFrom dependency from d0112 to us013;
    #DependsOn dependency from d0112 to d0099;
    #DependsOn dependency from d0112 to d0111;
}
