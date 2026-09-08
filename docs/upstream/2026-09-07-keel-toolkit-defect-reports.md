# Upstream defect reports for the keel toolkit (sysmlv2-ai-toolkit), found from obsidian-selfsync on 2026-09-07 with keel 0.3.1

## 1. keel-parser skips a `dependency` statement nested inside an `action def` body — silently

**Observed.** `.tracking/delivery/delivery.sysml` had 74 `#Covers dependency from <sittingReview> to <task>;`
statements at indent 8, inside `action def SelfSyncDelivery { ... }`. `keel show marker-census` reported
`Covers` edges = 0 (proseMentions 86); `keel show sitting-coverage` reported 0 covered sprints; the
parser-coverage guard reported 81 skipped statements = 7 successions + 74 dependency. Package-level
`#Verify dependency` statements in the same project (114) were all counted.

**Reproduction.** Four probe files run through `keel check`: (a) package-level marker dependency,
(b) two marker dependencies on one line, (c) a marker dependency with a trailing `//` comment,
(d) a dependency nested inside a `part`/`action` body. ALL four report `1 file(s) checked clean`.
Only (d) is skipped by the census. Hoisting the 74 statements to package level: Covers edges 74,
skipped count 7, sitting-coverage counts covering reviews.

**Why it matters.** The sitting review is the single human gate in the sprint discipline (D0049); the
lens that reports its coverage read a false zero for the life of the record, and `keel check` gave no
signal. A construct the parser does not read should be a parse error (or the nested form should be
parsed), never a clean check. The parser-coverage ratchet catches the COUNT but not the location —
listing the skipped statements' file:line in the warning would have made this a two-minute fix.

**Local mitigation.** Edges hoisted (obsidian-selfsync commit 4a991a54, `coversEdgesHoisted`);
baseline kept at the stock 7; issue `issueNestedCoversEdgesSkipped` (#ProcessDefect) records it.

## 2. `keel migrate --dry-run` reports 0 blockers for a change that deletes a project's schema additions

**Observed.** On a July-2026-vintage tree with 25 `metadata def` declarations in
`.engine/schema/core/relationships.sysml` (18 engine + 7 project markers added by an accepted project
Decision D0045), `keel migrate . --dry-run` reported "481 files / 481 edits / 0 blockers". The live
`keel migrate .` overwrote the file with the stock copy: 25 -> 18 declarations, and the project's
instance data then failed `keel validate` (marker-vocabulary 0 -> 228 violations, attribute-vocabulary
0 -> 1216). Rolled back at the time (project D0048), later redone under a committed transform that
re-adds the project's declarations by name (project D0050).

**Expected.** A dry-run that would overwrite an engine-shipped file the project has EXTENDED (its
current content is not byte-equal to any stock vintage) should list that file as a blocker — or at
least as "project-modified, will be overwritten" — rather than 0 blockers. The same applies to the
shared skills registry (8 project-only AISkill registrations were dropped) and to project-only
process files whose shape the new schema rejects (`part X : Process` vs `action def Process`,
`:>> order` no longer declared).

## 3. `open-issues` treats a finding with a `#Dispositions` edge as closed even when the disposition Test has NO TestResult

**Observed.** A `method=confirmation` Test carrying `disposition = DispositionKind::acceptRisk`,
deliberately WITHOUT a TestResult (the owner had not yet attested), linked to a finding with
`#Dispositions dependency from <test> to <issue>;`. `keel show open-issues` then dropped the issue
from BOTH the open and resolved lists; `keel show dispositions` did not list it as a finding.
Deleting the single edge line made the issue reappear as open; restoring it hid it again.

**Expected.** Per D0092 a disposition is a typed RECORDED JUDGMENT — the judgment is the TestResult
(who/when/against what), not the edge. An unattested disposition should leave the finding OPEN,
exactly as an unstamped DoD leaves a task open. As it stands, an item awaiting the owner's word is
invisible to the owner.

**Local mitigation.** The edge is withheld until the attestation is recorded (comment in
`.tracking/verification/acceptance.sysml` carries the exact edge to author at that moment); issue
`issueUnattestedDispositionClosesFinding`, resolver `keelDispositionLensReport`.

## 4. `keel add-task --def X` appends the task OUTSIDE the action def when the def is not the last block in the package

**Observed.** `.tracking/delivery/delivery.sysml` is `package ProjectDelivery { action def SelfSyncDelivery {...}  <#Capability stories, edges...> }`.
`keel add-task --file ... --def SelfSyncDelivery --task coversEdgesHoisted --method inspect --dod-from F` (and a
second call) appended `action coversEdgesHoisted; verification ...DoD ...` immediately before the PACKAGE's closing
brace — after package-level `#Covers` edges and `#Capability` stories — i.e. outside the def it was told to
extend. `keel validate` accepted it and `keel guard` was green (the task still resolved its issue), so nothing
signalled the mis-placement; `sprint-closure` then judged the open task by its position after every shipped
sprint ("work has moved on to a later sprint"). The stock template happens to end the file with the def, which
is presumably why the anchor works there.

**Expected.** Insert before the named def's own closing brace (or refuse with "def close not found"), never at
the package tail. Also: `keel record issue` numbers a new record as `issueNNN` by counting existing `issueNNN`
names in the per-actor file, so after a rename (issue001 -> a semantic name) the next record is `issue001` again;
minting from a counter or the id would avoid the collision-by-rename.

## 5. `sprint-closure` exempts an unstamped task by the TEXT of its action-line comment

**Observed.** `action dodBackfillStamp;` (open, unstamped, in the OPEN section of the def) failed
`sprint-closure` ("work has moved on to a later sprint"). Changing ONLY the trailing comment to
`action dodBackfillStamp;  // resolver for issueHistoricalDoDsUnstamped` made the guard PASS; moving the
task elsewhere in the def did not. So the exemption is decided by comment text (presumably "resolver for" /
"OPEN"), which a `.sysml` comment is not a typed fact. A task that is genuinely open should be exempt by a
typed signal (e.g. it is the `#Resolves` source of an open Issue, or it sits in the highest-numbered
sprint as D0260 states) — not by whether the author wrote a particular phrase after `//`.

## 6 (minor, doc). Stale engine-shipped docs after D0222 / per-actor issue files

`.engine/docs/usage.md` still says "Register an AI skill | Add an AISkill/Agent to skills-registry.sysml"
(now per-skill `registry.sysml`, D0222) and "Track an issue | Author a part in .tracking/issues.sysml"
(now `keel record issue` -> `.tracking/issues-<actor>.sysml`). Engine-owned, so not fixed downstream.
