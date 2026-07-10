// Client-side receive-path guard (R23 SEC, defense-in-depth). Every file we write or remove
// locally takes its path VERBATIM from the remote manifest. Content is hash-verified, but the
// PATH was fully trusted: `nodePath.join(base, normalizePath(path))` resolves `..` segments, so a
// malicious / compromised server (or a TLS MITM — we ship no E2EE) could return a manifest entry
// like `../../../.config/autostart/x.desktop` and make the desktop client write OUTSIDE the vault
// via unsandboxed Node fs (arbitrary write → RCE), or `plugins/allowed/../<self>/main.js` to
// overwrite SelfSync's own code and defeat the self-folder exclusion. The server already rejects
// such paths at commit (safe_rel_path), so this is unreachable via a well-behaved server — but a
// compromised server is a realistic threat, so the client must not trust the path either.
//
// This mirrors the server's safe_rel_path: reject empty/oversize, backslash, control chars,
// absolute paths (unix root, Windows drive letter, UNC), and any `.`/`..`/empty path segment.
// Legitimate vault keys (forward-slash, canonical, no traversal) always pass.
export function isSafeVaultPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (path.includes("\\")) return false;                 // backslash: Windows sep / traversal smuggling
  for (let i = 0; i < path.length; i++) {
    if (path.charCodeAt(i) < 0x20 || path.charCodeAt(i) === 0x7f) return false; // control chars (parity w/ server)
  }
  if (path.startsWith("/")) return false;                // absolute (POSIX)
  if (/^[a-zA-Z]:/.test(path)) return false;             // Windows drive letter (C:\...)
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false; // empty (//, lead/trail /), dot, traversal
    // Full parity with the server's safe_rel_path (R24): reject a segment Windows silently rewrites —
    // a trailing '.'/' ' (folds to a sibling) or a reserved DOS device name (CON/PRN/AUX/NUL/COMn/LPTn,
    // with or without extension). Not an escape, but it makes a hostile-server path fail-loud instead
    // of materializing as a surprise sibling / DOS-device write on a Windows client.
    if (seg.endsWith(".") || seg.endsWith(" ")) return false;
    if (isReservedWinName(seg)) return false;
  }
  return true;
}

function isReservedWinName(segment: string): boolean {
  const stem = segment.split(".")[0].toLowerCase();
  if (stem === "con" || stem === "prn" || stem === "aux" || stem === "nul") return true;
  return (stem.startsWith("com") || stem.startsWith("lpt"))
    && stem.length === 4 && stem[3] >= "1" && stem[3] <= "9";
}
