// Portable, opt-in COMPOSITION RECIPE codec + import planner (nComposeRecipe). A recipe is a copyable string
// that carries a set of mount SPECS — {source owner/vaultId/sourcePath, mountPoint, direction} — and NOTHING
// else: never a token, password, or server credential. It is the answer to "can I share the way I composed a
// vault?" WITHOUT a sharer pushing config: the reader REVIEWS and applies it with their OWN grants, own local
// folders, and fail-closed direction (see planRecipeImport). Mirrors the share-link codec's shape so a pasted
// recipe routes the same way; kept pure (no Obsidian API) so the codec + the access/writability/duplicate
// decisions are exhaustively unit-testable and can never drift from the modal that consumes them.
import { normalizeServer } from "./connstr";
import { Mount, MountDirection, MountSource, normMountFolder, canonFolder } from "./mounts";

const SCHEME = "selfsync-recipe://";
const MAX_MOUNTS = 200; // a sane ceiling — a real composition is a handful of mounts; refuse a pathological blob

// Accounts are compared CASE-INSENSITIVELY: the server lowercases usernames (auth.rs) while the client persists
// them as-typed, so a grant's owner comes back lowercase but a recipe's owner is built from the sharer's as-typed
// `settings.username`. A raw === would reject a genuine grant / fail an own-vault round-trip across devices whose
// usernames differ only in case. This mirrors main.ts isOwnAccount — the single canonicalization for identity.
const canonAccount = (s: string): string => s.trim().toLowerCase();

// A mount's `source.owner === ""` means "one of MY OWN vaults" — a reader-RELATIVE convention. Left verbatim in
// a recipe, "" would resolve to the READER's own same-named vault (a DIFFERENT vault), so encode ABSOLUTIZES an
// own-vault source to the exporter's account; a source already shared BY someone keeps its absolute owner. The
// payload is mount specs only — no credentials — and `server` rides along solely for a cross-server sanity check.
export function encodeCompositionRecipe(mounts: readonly Mount[], server: string, selfAccount: string): string {
  const payload = mounts.map((m) => ({
    owner: canonAccount(m.source.owner || selfAccount), // canonical (lowercase) so a reader's === matches the server's grant owner
    vaultId: m.source.vaultId,
    sourcePath: m.source.sourcePath,
    mountPoint: m.mountPoint,
    direction: m.direction,
  }));
  if (!payload.length) throw new Error("There are no active mounts to put in a recipe.");
  if (!selfAccount) throw new Error("Sign in first — a recipe needs your account to name the vaults you own.");
  const p = new URLSearchParams({ server: normalizeServer(server), mounts: JSON.stringify(payload) });
  return `${SCHEME}import?${p.toString()}`;
}

export function isCompositionRecipe(str: string): boolean {
  return str.trim().startsWith(SCHEME);
}

export interface ParsedRecipe { server: string; mounts: Mount[] }

// Parse a pasted recipe string. Reads the query params DIRECTLY (no `new URL` on a scheme-swapped string — the
// same Android-WebView pitfall parseShareLink documents). Throws a human-readable error on a non-recipe /
// malformed / empty payload so the modal can surface it.
export function parseCompositionRecipe(str: string): ParsedRecipe {
  const trimmed = str.trim();
  if (!trimmed.startsWith(SCHEME)) throw new Error("That doesn't look like a SelfSync composition recipe.");
  const qi = trimmed.indexOf("?");
  const params = new URLSearchParams(qi >= 0 ? trimmed.slice(qi + 1) : "");
  const server = params.get("server") ?? "";
  let raw: unknown;
  try { raw = JSON.parse(params.get("mounts") ?? ""); } catch { throw new Error("This composition recipe is malformed and can't be read."); }
  const mounts = recipeMountsFrom(raw);
  if (!mounts.length) throw new Error("This composition recipe contains no valid mounts.");
  if (mounts.length > MAX_MOUNTS) throw new Error(`This composition recipe is unexpectedly large (over ${MAX_MOUNTS} mounts) — it may be corrupt.`);
  return { server: server ? normalizeServer(server) : "", mounts };
}

// Parse-don't-validate at the boundary (mirrors parseMounts): drop malformed entries, normalize both folders,
// default an unknown direction to the safe "pull". An entry with an EMPTY owner is DROPPED — encode always
// absolutizes, so a blank owner is an ambiguous/hand-mangled recipe that must NOT silently resolve to the
// reader's own same-named vault (fail closed, don't guess).
export function recipeMountsFrom(raw: unknown): Mount[] {
  if (!Array.isArray(raw)) return [];
  const out: Mount[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const m = e as Record<string, unknown>;
    const owner = typeof m.owner === "string" ? m.owner : "";
    const vaultId = typeof m.vaultId === "string" ? m.vaultId : "";
    const mountPoint = normMountFolder(typeof m.mountPoint === "string" ? m.mountPoint : "");
    if (!owner || !vaultId || !mountPoint) continue; // needs an absolute owner + a source vault + a non-root local folder
    out.push({
      source: { owner, vaultId, sourcePath: normMountFolder(typeof m.sourcePath === "string" ? m.sourcePath : "") },
      mountPoint,
      direction: m.direction === "sync" ? "sync" : "pull",
    });
  }
  return out;
}

// ---- import planner (pure) ----------------------------------------------------------------------------------
// The reader-side decision for each recipe entry: can I use it, may I sync it, is it already here? The modal
// renders this and lets the reader edit the local folder / direction, but the SAFETY posture lives here.
export type RecipeItemStatus =
  | "ready"        // accessible + not already mounted + not my own primary — appliable
  | "noAccess"     // a source shared by someone else that I hold no grant for — ask them to share it
  | "selfPrimary"  // the source resolves to my CURRENT primary vault (can't mount a vault into itself)
  | "duplicate";   // an identical mount (same source + local folder) already exists here

export interface RecipePlanItem {
  recipe: Mount;               // as authored in the recipe (absolute owner, sharer's direction)
  localSource: MountSource;    // owner mapped to the READER's convention ("" when it's my own account)
  status: RecipeItemStatus;
  writable: boolean;           // do I hold write access to this source? (gates whether `sync` is offerable)
  suggestedDirection: MountDirection; // fail-closed: `sync` only if the recipe asked for it AND I may write
}

export interface RecipeReaderContext {
  myAccount: string;                                              // settings.username (my absolute owner)
  primary: { owner: string; vaultId: string };                   // my current primary (owner "" = self-owned)
  grants: readonly { owner: string; vault: string; perm: string }[]; // vaults shared TO me (listSharedVaults)
  existingMounts: readonly Mount[];                              // mounts already configured here
}

export function planRecipeImport(mounts: readonly Mount[], ctx: RecipeReaderContext): RecipePlanItem[] {
  const myAccount = canonAccount(ctx.myAccount);
  const primaryOwner = canonAccount(ctx.primary.owner);
  return mounts.map((m) => {
    // Map the recipe's absolute owner into the reader's convention (case-insensitively): MY OWN account collapses
    // to "", a foreign owner stays but is canonicalized to lowercase so it matches the server's grant + mount owner.
    const recipeOwner = canonAccount(m.source.owner);
    const isOwn = !!myAccount && recipeOwner === myAccount;
    const localOwner = isOwn ? "" : recipeOwner;
    const localSource: MountSource = { owner: localOwner, vaultId: m.source.vaultId, sourcePath: m.source.sourcePath };

    // Access + writability. An own-account vault is fully mine; a foreign source needs a matching grant, and
    // `sync` is gated on the grant being read-WRITE. Fail CLOSED — an unknown/renamed perm never confers write.
    let accessible: boolean, writable: boolean;
    if (isOwn) { accessible = true; writable = true; }
    else {
      const g = ctx.grants.find((x) => canonAccount(x.owner) === recipeOwner && x.vault === m.source.vaultId);
      accessible = !!g;
      writable = g?.perm === "readWrite";
    }
    // Default a FOREIGN source to read-only Pull regardless of what the sharer asked — writing into someone
    // else's shared vault is a decision the READER opts into per row, never a sharer-smuggled default (critique
    // S2/H1). Own vaults keep the recipe's direction (it's your own data, no third-party visibility).
    const suggestedDirection: MountDirection = isOwn && m.direction === "sync" ? "sync" : "pull";

    let status: RecipeItemStatus;
    if (!accessible) status = "noAccess";
    else if (localOwner === primaryOwner && m.source.vaultId === ctx.primary.vaultId) status = "selfPrimary";
    else if (ctx.existingMounts.some((o) =>
      canonAccount(o.source.owner) === localOwner && o.source.vaultId === localSource.vaultId &&
      canonFolder(o.source.sourcePath) === canonFolder(localSource.sourcePath) &&
      canonFolder(o.mountPoint) === canonFolder(m.mountPoint))) status = "duplicate";
    else status = "ready";

    return { recipe: m, localSource, status, writable, suggestedDirection };
  });
}

// Build the Mount a `ready` plan item applies, given the reader's (possibly edited) local folder + direction.
// Re-clamps direction fail-closed (never `sync` on a non-writable source) as belt-and-suspenders over the UI.
export function mountFromPlanItem(item: RecipePlanItem, mountPoint: string, direction: MountDirection): Mount {
  return {
    source: { ...item.localSource, sourcePath: normMountFolder(item.localSource.sourcePath) },
    mountPoint: normMountFolder(mountPoint),
    direction: direction === "sync" && item.writable ? "sync" : "pull",
  };
}
