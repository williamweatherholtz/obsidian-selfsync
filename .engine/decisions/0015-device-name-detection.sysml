// =====================================================================
// D0015 — canonical mobile device-name detection. Auto-detection had shown the CPU architecture
// ("Linux aarch64") on Android; researched the canonical ways to get a device name on Android/iOS
// in a webview. Refines srDeviceIdentity's mechanism. Accepted 2026-07-05 by wweatherholtz ("sure").
// No schema/process edit → plain ADR. Shipped in 0.10.9 (a504d0c).
// =====================================================================
package ProjectDecision0015 {
    private import EngineElement::*;
    private import EngineWork::*;
    private import EngineVerification::*;

    part d0015 : Decision {
        :>> id = "c0f1a5cc-f101-4a10-9b20-a1b2c3d40f11";
        :>> title = "D0015: device-name detection — Android UA Client Hints, iOS iPhone/iPad ceiling, user override authoritative";
        :>> createdAt = "2026-07-05";
        :>> createdBy = "wweatherholtz";
        :>> status = DecisionStatus::accepted;
        :>> context = "Auto device-name detection had surfaced the CPU architecture on Android (navigator.platform = 'Linux aarch64') when model extraction failed, and modern Android Chrome freezes the UA model to 'K'. Research into canonical webview approaches found: (a) navigator.userAgentData.getHighEntropyValues(['model']) returns the real Android model even under UA reduction, but is Chromium-only; (b) iOS/WebKit implements no userAgentData and exposes nothing beyond 'iPhone'/'iPad' in the UA (deliberate anti-fingerprinting) — screen-size mapping is fragile and not canonical; (c) the only true cross-platform native source is Capacitor Device.getInfo() (model/name), but Obsidian does not expose it to community plugins in any documented/stable way (window.Capacitor.Plugins.Device is undocumented + fragile).";
        :>> decision = "Auto-detect best-effort with a clear precedence and never surface an architecture: Android uses UA Client Hints (getHighEntropyValues['model'], resolved once async at startup + cached, feature-detected) first, then the UA-string model regex (Android WebView is NOT UA-reduced so the model is usually present), then a platform label; iOS uses 'iPhone'/'iPad' and accepts that as the ceiling (no web API exposes the model or a user-assigned name); the platform fallback strips architecture tokens so an arch can never become the name. Do NOT depend on window.Capacitor.Plugins.Device (undocumented/fragile). The user-editable Device-name field is the authoritative override; auto-detection only fills the placeholder.";
        :>> rationale = "UA Client Hints is the canonical, standards-track web way to recover the Android model post-UA-reduction, and it directly fixes the frozen-'K'/arch failure; the UA-string regex is a free additional path because WebView is exempt from reduction. iOS simply cannot do better than iPhone/iPad from web APIs, so accepting that ceiling (plus the manual override) is honest rather than shipping a fragile screen-size heuristic. Reaching into Capacitor's native Device plugin was rejected: it is undocumented in Obsidian, version-fragile, and couples us to an internal we do not control, for a name the user can just type. ALTERNATIVES: screen-dimension->model mapping (REJECTED, imperfect/fragile); depend on window.Capacitor.Plugins.Device (REJECTED, unsupported); UA-string only (REJECTED, misses frozen-'K'). CRITERIA: canonical (standards API) x honest (accept the iOS limit) x robust (never show an arch) x low-coupling (no undocumented internals) x user-authoritative (manual field wins).";
        :>> consequences = "Client 0.10.9 (a504d0c): devicename.ts gains usableModel() (shared UA-CH + UA-string gate); main.ts resolves the UA-CH model async at startup, caches it, refreshes the settings placeholder on land, and autoDeviceName prefers UA-CH -> UA regex -> Platform label -> arch-stripped platform. srDeviceIdentity restated to describe the precedence + the iOS ceiling; its acceptance test covers usableModel + the arch guard. Practical limit recorded: on a frozen-UA Android without UA-CH support the name falls back to 'Android', and on iOS to 'iPhone'/'iPad' — the manual field is how a user gets an exact name. doc-sync: none (no command/type/skill surface). Refines srDeviceIdentity (D0014); complements the 0.10.8 arch-strip fix.";
    }

    verification d0015Accept : Test {
        :>> id = "c0f1a5cc-f102-4a10-9b20-a1b2c3d40f12";
        :>> method = VerificationMethod::confirmation;
        :>> procedureText = "wweatherholtz asked for research into canonical mobile device-name detection and approved implementing the UA-Client-Hints Android upgrade ('sure') on 2026-07-05, having been shown the findings (Android UA-CH survives reduction; iOS/WebKit exposes nothing beyond iPhone/iPad; Capacitor native is out of reach for a community plugin).";
    }
    part d0015AcceptR1 : TestResult { :>> id = "c0f1a5cc-f103-4a10-9b20-a1b2c3d40f13"; :>> outcome = VerdictKind::pass; :>> judgedAgainst = "a504d0c"; :>> judgedAt = "2026-07-05"; :>> judgedBy = "wweatherholtz"; }
}
