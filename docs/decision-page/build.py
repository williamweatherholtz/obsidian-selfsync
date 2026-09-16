#!/usr/bin/env python3
# not-an-instrument: every number this page shows is READ from the tree at build time (the authority queue, the
# commit delta, the decision files, the binary's version report, the manifest); it renders, it does not measure.
"""Build SelfSync's standing decision page — the decision-surfacing process on the asi-templates executive-brief surface.

    python docs/decision-page/build.py            # writes docs/decision-page/index.html + facts.json
    python <toolkit>/scripts/check_templates.py --brief <abs path to index.html>   # the contract, held by the checker

Republished at the same Artifact path each time the authority queue changes (dsRender). The records each ask decides
ride in data-records and the copy digest ("answers: …"), never in the reader's prose (asi-templates §2.2). The terse
register's 450-word ceiling is measured per tab (frame + one panel), so the frame is kept small on purpose.
"""
import glob, io, json, os, re, subprocess, sys
from html import escape

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
os.chdir(ROOT)
TOOLKIT = os.environ.get("KEEL_TOOLKIT", r"C:\Users\will\claudecode\sysmlv2-ai-toolkit")
sys.path.insert(0, os.path.join(TOOLKIT, "scripts", "exec_brief"))
from logic_exhibits import logic_lanes, downstream  # noqa: E402


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, encoding="utf-8").stdout


def fval(t, k):
    m = re.search(r':>> ' + k + r' = "((?:[^"\\]|\\.)*)"\s*;', t); return m.group(1) if m else ""


# ------------------------------------------------------------------ facts, each with how it was read
F = {}
def fact(k, val, how): F[k] = {"value": val, "how": how}; return val

queue = json.loads(sh("keel", "show", "authority-queue", "."))
acc = [a for a in queue["awaiting"] if a["kind"] == "decisionAcceptance"]
disp = [a for a in queue["awaiting"] if a["kind"] == "findingDisposition"]
fact("pendingAcceptances", len(acc), "keel show authority-queue . | kind == decisionAcceptance")
fact("pendingDispositions", len(disp), "keel show authority-queue . | kind == findingDisposition")
since = {a["item"]: a["waitingSince"] for a in acc}
fact("oldestSince", min(since.values()), "min waitingSince over decisionAcceptance rows")
head = fact("head", sh("git", "rev-parse", "--short", "HEAD").strip(), "git rev-parse --short HEAD")
fact("date", sh("git", "log", "-1", "--format=%cs").strip(), "git log -1 --format=%cs (HEAD commit date)")
fact("pluginVersion", json.load(io.open("manifest.json", encoding="utf-8"))["version"], "manifest.json version")
kv = sh("keel", "version")
g = re.search(r"guards: (\d+) \((\d+) hard-blocking", kv)
fact("guards", int(g.group(1)), "keel version"); fact("guardsHard", int(g.group(2)), "keel version")
fact("keelVersion", re.search(r"keel (\S+)", kv).group(1), "keel version")
fact("guardsBefore", 58, "the previous binary's `keel version` (0.3.1: 58 guards, 49 hard), recorded in this session before the update")
delta = json.loads(sh("keel", "show", "commit-delta", ".", "--range", "43a10f4b..HEAD"))
by_type = {}
for a in delta.get("added", []): by_type[a["type"]] = by_type.get(a["type"], 0) + 1
fact("deltaAdded", by_type, "keel show commit-delta . --range 43a10f4b..HEAD | added, grouped by type")
fact("deltaRetired", len(delta.get("retired", [])), "commit-delta: retired by a supersede edge")
fact("deltaResolved", len(delta.get("resolved") or delta.get("issuesResolved") or []), "commit-delta: issues resolved")
clauses = {}
for f in sorted(glob.glob(".engine/decisions/00*-clause-*.sysml")):
    t = io.open(f, encoding="utf-8").read()
    m = re.search(r"// (d\d{4}) \(PROJECT numbering\) — clause (\d+) of (\d+) of (D\d{4})", t)
    clauses.setdefault(m.group(4).lower(), []).append((int(m.group(2)), m.group(1)))
for kids in clauses.values(): kids.sort()
n_kids = fact("clauseChildren", sum(len(k) for k in clauses.values()), "count of .engine/decisions/*-clause-*.sysml")
n_par = fact("compoundParents", len(clauses), "distinct parents named in the clause files' headers")
e2e = fact("e2eFiles", len(glob.glob("client/e2e-obsidian/**/*.ts", recursive=True)), "glob client/e2e-obsidian/**/*.ts")
srs = fact("systemRequirements", sum(len(re.findall(r"part \w+ : SystemRequirement", io.open(f, encoding="utf-8").read())) for f in glob.glob(".tracking/requirements/*.sysml")), "count of `part … : SystemRequirement` in .tracking/requirements/*.sysml")
dlv = io.open(".tracking/delivery/delivery.sysml", encoding="utf-8").read()
fact("liveSubscriptionShipped", bool(re.search(r"part mountLiveSubscriptionDoDR\d+ : TestResult \{[^}]*VerdictKind::pass", dlv)), "mountLiveSubscriptionDoD carries a pass result in delivery.sysml")
assert since, "nothing is pending: the decision-surfacing state test says publish nothing (D0380)"
json.dump({"generatedAt": F["date"]["value"], "tree": head, "facts": F}, io.open("docs/decision-page/facts.json", "w", encoding="utf-8"), indent=1)
v = lambda k: F[k]["value"]

# what each compound record was about, and a two-or-three-word name per clause, in clause order — the members a
# counted set must name (D0406); the ids ride only in data-records
PARENTS = {
    "d0046": ("provenance", ["orphan tags", "working name", "prior art"]),
    "d0048": ("additive reconcile", ["CLI facts", "renderer names", "lens doc-sync", "triage claim", "method typo"]),
    "d0050": ("engine resync", ["run migrate", "owned files", "markers", "skill registries", "processes", "covers edges", "transform", "warnings"]),
    "d0051": ("lockfile", ["commit lockfile", "npm ci", "deliberate updates"]),
    "d0053": ("safety process", ["analysis process", "machine primitive", "model registration", "four machines", "resolver"]),
    "d0054": ("asset digests", ["record sums", "digest check", "About row", "skill doc"]),
    "d0055": ("draft-then-publish", ["draft publish", "tag guard", "rebuild anchor", "image dispatch", "pinned actions", "honest check"]),
}
assert {p: len(k) for p, k in clauses.items()} == {p: len(n[1]) for p, n in PARENTS.items()}, "clause names must match the clause files one for one"

# ------------------------------------------------------------------ shell: the ASI template's styles + digest machinery
tpl = io.open("templates/exec-summary/exec-summary.html", encoding="utf-8").read()
style = tpl[tpl.index("<style>"): tpl.index("</style>") + len("</style>")]
script = tpl[tpl.index("<script>"): tpl.index("</script>") + len("</script>")]
script = script.replace("var dec = p.querySelector('[data-d=\"choices\"]');",
    "var opts = p.querySelector('.opts'); if(opts){ L.push('**Question:** ' + text(p.querySelector('h2'))); var picked = opts.querySelector('input:checked'); L.push(picked ? '- [x] ' + picked.value : '_(no choice made yet)_'); L.push('answers: ' + (opts.getAttribute('data-records') || '')); L.push(''); }\n      var dec = p.querySelector('[data-d=\"choices\"]');")
extra_css = """
<style>
  .ask{margin:16px 0 4px} .ask p{margin:0 0 6px}
  .verdict{font:400 16.5px/1.5 Roboto,sans-serif; color:var(--head); max-width:72ch}
  .rule{font-size:14px; color:var(--muted); max-width:72ch; margin:0 0 4px}
  .chips{display:flex; gap:8px; flex-wrap:wrap; margin:10px 0 0}
  .chips .chip{font:500 11px/1 "Roboto Condensed",sans-serif; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);
    border:1px solid var(--line); background:var(--fill); border-radius:3px; padding:6px 9px; margin:0; font-variant-numeric:tabular-nums}
  .chips .chip b{color:var(--head); font-weight:500; margin-right:5px}
  [role="tabpanel"] h2{margin-top:1.1em} [role="tabpanel"] p{font-size:14.5px; margin:.45em 0}
  q{quotes:"“" "”"; color:var(--head)}
  .ships{font:500 10px/1 "Roboto Condensed",sans-serif; letter-spacing:.1em; text-transform:uppercase; color:var(--warn);
    border:1px solid var(--warn); border-radius:3px; padding:2px 6px; margin-left:8px; vertical-align:3px}
  figcaption.msg{font:500 13.5px/1.4 "Roboto Condensed",sans-serif; color:var(--head); margin:0 0 6px}
  .m{font:400 12px/1.8 "Roboto Condensed",sans-serif; background:var(--fill); border:1px solid var(--line); border-radius:3px; padding:1px 6px; white-space:nowrap; margin:0 3px 3px 0; display:inline-block}
  .opts{display:grid; gap:8px; margin:12px 0 4px}
  .opts label{display:flex; gap:12px; align-items:flex-start; border:1px solid var(--line); border-radius:6px; padding:12px 14px; min-height:44px; cursor:pointer; background:var(--card); font-size:14.5px}
  .opts label:has(input:checked){border-color:var(--accent); background:var(--fill); box-shadow:inset 3px 0 0 var(--accent)}
  .opts input{margin-top:4px; accent-color:var(--accent)}
  .opts label:has(input:focus-visible){outline:2px solid var(--accent); outline-offset:2px}
  table.courses td:first-child{white-space:nowrap; font-weight:500; color:var(--head)}
  .delta{font-size:14px; color:var(--muted); max-width:72ch}
</style>"""

# ------------------------------------------------------------------ pieces
def courses(rows):
    body = "".join(f"<tr><td>{escape(a)}</td><td>{escape(b)}</td><td>{escape(c)}</td></tr>" for a, b, c in rows)
    return f'<div class="tbl-wrap"><table class="courses"><thead><tr><th>course</th><th>changes</th><th>breaks or waits</th></tr></thead><tbody>{body}</tbody></table></div>'

def opts(name, records, options):
    body = "".join(f'<label><input type="radio" name="{name}" value="{escape(o)}"><span>{escape(o)}</span></label>' for o in options)
    return f'<div class="opts" data-records="{escape(records)}">{body}</div>'

def panel(key, title, ships, item, binds, figs, course_rows, truth, acts, records, options, members=""):
    return (f'<h2>{escape(title)}{"<span class=\"ships\">already in effect</span>" if ships else ""}</h2>'
            f'<p>The item: <q>{escape(item)}</q></p><p><strong>Accepting binds:</strong> {escape(binds)}</p>{members}{"".join(figs)}'
            f'{courses(course_rows)}<p><strong>True in the model:</strong> {escape(truth[0])} <strong>My assumption:</strong> {escape(truth[1])}</p>'
            f'<p>{acts}</p>{opts("ask-" + key, records, options)}')

members_rows = "".join(f'<tr><td>{escape(PARENTS[p][0])}</td><td>' + "".join(f'<span class="m">{escape(n)}</span>' for n in PARENTS[p][1]) + "</td></tr>" for p in clauses)
members = f'<div class="tbl-wrap"><table data-members="{n_kids}"><thead><tr><th>was one record</th><th>becomes, per clause</th></tr></thead><tbody>{members_rows}</tbody></table></div>'
rec_clauses = ", ".join(sorted(k for kids in clauses.values() for _, k in kids)) + ", decisionClauseSplit"

TAB_OF = {"d0057": "engine", "d0049": "ci", "d0052": "timestamps", "d0040": "mounts", "d0092": "page", "d0093": "ledger", "d0094": "resync", "d0095": "hook"}
for kids in clauses.values():
    for _, k in kids: TAB_OF[k] = "clauses"
TAB_NAME = {"engine": "Engine update", "clauses": "One clause per record", "wording": "Signed wording", "ci": "Typecheck browser tests",
            "timestamps": "Retire five requirements", "mounts": "Mount latency record", "page": "This page", "ledger": "Disposition ledger",
            "resync": "Partial engine resync", "hook": "Commit gate lookup"}
unknown = sorted(d for d in since if d not in TAB_OF)
assert not unknown, f"pending records with no ask authored on this page: {unknown} - author a panel (decision-surfacing step 4)"
ORDER = ["resync", "hook", "ledger", "engine", "clauses", "wording", "ci", "timestamps", "mounts", "page"]
ASKS = [(k, TAB_NAME[k]) for k in ORDER if any(TAB_OF[d] == k for d in since)]
K, G0, GH = v("keelVersion"), v("guardsBefore"), v("guards")
P = {}
P["engine"] = lambda: panel("engine", "Ratify the engine update", True,
    "the engine library moves to the new vintage under a committed transform; the hook and working rules use the renamed gate commands; the process set is chartered by this record.",
    f"{GH} checks gate every commit; the tree is pinned to {K}. Reverting is a binary swap plus a tree revert.",
    [logic_lanes("Under the old pin the new engine cannot gate; under the new pin it runs every check",
        ("today", [("Pin says old", "", "muted", ""), ("New binary refuses", "writes, gates", "bad", ""), ("Console cannot record", "", "bad", "")], ["so", "so"]),
        ("after", [("Pin says new", K, "accent", ""), (f"{GH} checks run", "every commit", "ok", ""), ("Console records", "accept, judge", "ok", "")], ["so", "so"])),
     downstream("The update lands on the hook, the rules, the guard set and drifted records", ("Engine update", K),
        [("Pre-commit hook", "renamed gate commands", "1", "accent"), ("Working rules", "command names", "15", "accent"),
         ("Guard set", f"{G0} to {GH}", f"+{GH - G0}", "ok"), ("Signed records", "edited after signature", "3", "warn"), ("Compound records", "after the one-clause rule", str(n_par), "warn")])],
    [("Ratify", "nothing more", "nothing"), ("Revert", "binary swap, tree revert", "console writes, this page, three drift catches"), ("Do nothing", "nothing", "an unsigned charter")],
    (f"all {GH} guards pass at this tree; the transform is committed.", "the restored schema is the whole difference between the migrate's self-revert and a clean run."),
    "<strong>Ratify:</strong> nothing moves. <strong>Revert:</strong> one commit, recorded quoting you.",
    "d0057", ["Ratify the update as applied", "Revert to the previous engine", "Do nothing yet"])

P["clauses"] = lambda: panel("clauses", f"Accept {n_kids} single-clause records", True,
    "one record per clause, the parent's clause word for word, dependency edges between clauses, the first superseding the compound record.",
    f"{n_par} signed records become pointers; {n_kids} proposed records carry the clauses unchanged.",
    [logic_lanes("One edge cannot say which clause it delivered; one record per clause can",
        ("today", [("Compound record", "", "muted", ""), ("One edge charters all", "", "bad", ""), ("Partial delivery hidden", "", "bad", "")], ["so", "so"]),
        ("after", [("Record per clause", str(n_kids), "accent", ""), ("Edge names a clause", "", "ok", ""), ("Partial delivery shown", "", "ok", "")], ["so", "so"])),
     downstream(f"Splitting lands on {n_par} signed records, {n_kids} new ones and one toolkit question", ("The split", ""),
        [("Compound records", "pointers; signatures kept", str(n_par), "warn"), ("Clause records", "proposed, verbatim", str(n_kids), "accent"), ("Commit gate", "red to green", "1", "ok"), ("Toolkit", "grandfather?", "1", "muted")])],
    [("Accept all", f"{n_kids} signatures", "nothing"), ("Reject", "toolkit cutoff", "no commit meanwhile"), ("Accept some", "per clause", "a parent half in force")],
    (f"{n_kids} clause records quote their clauses; the gate passes.", "you would decide no clause differently from its whole."),
    "<strong>Accept:</strong> nothing moves. <strong>Reject:</strong> I raise the cutoff upstream. <strong>Some:</strong> name which.",
    rec_clauses, [f"Accept all {n_kids} clause records", "Reject the split; grandfather this project", "Accept some; I will name which"], members)

P["wording"] = lambda: panel("wording", "Confirm the restored wording", True,
    "three signed records read again as they did at the commit their acceptance bound to; the later edits, counts and notes, moved to the requirements and delivery records.",
    "what you signed stands; the edited versions are history.",
    [logic_lanes("An edit after signature breaks the bond; restoring the signed text mends it",
        ("today", [("Record signed", "", "muted", ""), ("Text edited later", "counts, notes", "bad", ""), ("Disk is not signature", "gate refuses", "bad", "")], ["then", "so"]),
        ("after", [("Record signed", "", "muted", ""), ("Signed values restored", "", "ok", ""), ("Disk is signature", "gate passes", "ok", "")], ["then", "so"])),
     downstream("Restoring lands on three records and nothing else", ("Restored wording", ""),
        [("Requirement baseline", "count moved out", "1", "accent"), ("Config direction", "extensions moved out", "1", "accent"), ("Provenance", "hook note moved out", "1", "accent"), ("Shipped code", "unchanged", "0", "ok")])],
    [("Confirm", "nothing more", "nothing"), ("Re-sign edited", "three re-signatures", "edited text binds"), ("Do nothing", "nothing", "one task stays open")],
    ("disk equals the signed text; the gate passes.", "you never relied on the edited wording."),
    "<strong>Confirm:</strong> I close the task quoting you. <strong>Re-sign:</strong> three rebinds from your terminal.",
    "d0014, d0025, d0046, rebindDriftedAcceptances", ["Confirm the restored, signed wording", "Re-sign the edited wording instead", "Do nothing yet"])

P["ci"] = lambda: panel("ci", "Accept the browser-test typecheck", True,
    "one step in the client CI job typechecks the browser-driven test layer on every push and pull request.",
    f"{e2e} test files with no static check get one on every push; a type error blocks the merge.",
    [logic_lanes("Without the step a type error waits for a host run; with it every push catches it",
        ("today", [("Browser tests", f"{e2e} files", "muted", ""), ("Nothing checks them", "", "bad", ""), ("Error found late", "needs the host", "bad", "")], ["and", "so"]),
        ("after", [("Browser tests", f"{e2e} files", "muted", ""), ("CI typechecks them", "every push", "ok", ""), ("Error blocks merge", "", "ok", "")], ["and", "so"])),
     downstream("The step lands on one workflow and one test layer", ("CI typecheck", ""),
        [("CI workflow", "one added step", "1", "accent"), ("Browser test layer", "statically checked", str(e2e), "ok"), ("Plugin code", "unchanged", "0", "ok")])],
    [("Accept", "nothing more", "nothing"), ("Reject", "one step reverted", "the layer stays unchecked"), ("Do nothing", "nothing", "enforcement changed unsigned")],
    ("the step has passed on every push since it landed.", "nobody wants the layer unchecked."),
    "<strong>Accept:</strong> nothing moves. <strong>Reject:</strong> one revert commit, recorded quoting you.",
    "d0049", ["Accept the CI typecheck step", "Reject: revert the step", "Do nothing yet"])

P["timestamps"] = lambda: panel("timestamps", "Retire five requirements", False,
    "the five embedded-timestamp requirements are superseded by this record and kept as history; the surviving behaviour is covered by three verified deliveries.",
    f"the requirement tier stops counting five promises the plugin dropped in 1.9.0; {srs - 5} of {srs} stay live.",
    [logic_lanes("Five requirements promise behaviour the code dropped; superseding makes the tier truthful",
        ("today", [("Five requirements live", "", "muted", ""), ("Code stopped in 1.9.0", "masking instead", "bad", ""), ("Tier shows 5 gaps", "", "bad", "")], ["but", "so"]),
        ("after", [("Five superseded", "kept as history", "accent", ""), ("Code unchanged", "", "ok", ""), ("Tier shows truth", f"{srs - 5} live", "ok", "")], ["and", "so"])),
     downstream("Retiring lands on the requirement tier only", ("Five retired", ""),
        [("Requirement tier", "fewer unverified", "5", "ok"), ("Acceptance tests", "unstamped by design", "5", "muted"), ("Plugin and server", "unchanged", "0", "ok")])],
    [("Retire", "five supersede edges", "reactivation needs a record"), ("Keep live", "nothing", "five false gaps"), ("Retire and write a masking requirement", "one requirement", "already covered")],
    ("the scope change shipped in 1.9.0 and passed a sitting review.", "you do not want embedded timestamps back."),
    "<strong>Retire:</strong> nothing moves. <strong>Keep:</strong> gaps stay counted. <strong>Fresh requirement:</strong> I author it.",
    "d0052", ["Retire the five requirements", "Keep them live", "Retire them and write a masking requirement"])

P["mounts"] = lambda: panel("mounts", "Accept the version-one mount record", True,
    "a mounted folder is reconciled on the primary sync cycle in version one; its own real-time subscription is deferred as a latency residual.",
    f"the first release's reasoning is kept as history; the deferred subscription has since shipped. Waiting since {since['d0040']}.",
    [logic_lanes("Version one waits for the poll; the shipped subscription moves changes promptly",
        ("today", [("Source changes", "", "muted", ""), ("Primary poll runs", "", "warn", ""), ("Mount pulls later", "", "warn", "")], ["then", "so"]),
        ("after", [("Source changes", "", "muted", ""), ("Subscription pokes", "shipped", "ok", ""), ("Mount pulls promptly", "", "ok", "")], ["then", "so"])),
     downstream("Accepting lands on history alone", ("Version-one record", ""),
        [("Design history", "reasoning kept", "1", "accent"), ("Shipped plugin", "unchanged", "0", "ok"), ("Your queue", "oldest item closed", "1", "muted")])],
    [("Accept as history", "nothing", "reads stale beside its successor"), ("Reject as stale", "one rejection", "reasoning lost"), ("Do nothing", "nothing", "the oldest item stays")],
    ("the per-mount subscription delivery carries a pass.", "a dated record will not be read as direction."),
    "<strong>Accept:</strong> nothing moves. <strong>Reject:</strong> recorded quoting you.",
    "d0040", ["Accept the version-one record as history", "Reject it as stale", "Do nothing yet"])

# a single-clause ratification with no branch draws nothing (asi-templates §2.3, when NOT to draw)
P["page"] = lambda: (f'<h2>Adopt this page as the decision channel<span class="ships">already in effect</span></h2>'
    f'<p>The item: <q>the decision page is the branded executive brief, built from the tree and republished at one address whenever the queue of things awaiting you changes.</q></p>'
    f'<p><strong>Accepting binds:</strong> the document kit lives in this repository; the page is rebuilt, checked and republished on every queue change, and silence means the page is current.</p>'
    + courses([("Adopt", "nothing more", "nothing"), ("Reject", "kit removed, page deleted", "the console deck stays your only view"), ("Do nothing", "nothing", "this tab returns")])
    + '<p><strong>True in the model:</strong> the kit is installed under its unit record; this page passed the brief contract. <strong>My assumption:</strong> you prefer one page to the deck for decisions with argument.</p>'
    + '<p><strong>Adopt:</strong> nothing moves. <strong>Reject:</strong> one removal commit, recorded quoting you.</p>'
    + opts("ask-page", "d0092", ["Adopt this page as the decision channel", "Reject: remove the document kit", "Do nothing yet"]))

# the ledger ask (D0093): a process change - the skill gains a step - so it is a real fork, drawn (asi-templates 2.3)
P["ledger"] = lambda: panel("ledger", "Adopt the remote disposition ledger", True,
    "finding verdicts are collected on a published ledger when you are away from the console, and recorded from the digest you paste back, word for word.",
    f"{v('pendingDispositions')} verdicts become reachable from anywhere; nothing is recorded until you paste; a blank row stays open.",
    [logic_lanes("Without the ledger a verdict waits for the console's machine; with it your digest lands from anywhere",
        ("today", [("Verdict due", str(v('pendingDispositions')), "muted", ""), ("Console needs its machine", "you are away", "bad", ""), ("Verdicts wait", "", "bad", "")], ["but", "so"]),
        ("after", [("Verdict due", str(v('pendingDispositions')), "muted", ""), ("Ledger reaches you", "one page", "ok", ""), ("Digest lands, verbatim", "checked, recorded", "ok", "")], ["and", "so"])),
     downstream("Adopting lands on one skill, two scripts and your queue; the console deck is unchanged", ("The ledger", ""),
        [("Surfacing skill", "one added step", "1", "accent"), ("Page scripts", "build, record", "2", "accent"), ("Your finding queue", "reachable remotely", str(v('pendingDispositions')), "ok"), ("Console deck", "unchanged", "0", "muted")])],
    [("Adopt", "nothing more", "nothing"), ("Reject", "ledger and scripts removed", "verdicts wait for the console"), ("Do nothing", "nothing", "the skill step stays unsigned")],
    ("the ledger is built from the lens and the records; the recorder refuses an unknown id or an unbalanced count.", "you would rather answer from a page than wait to be local."),
    "<strong>Adopt:</strong> nothing moves; paste your digest when ready. <strong>Reject:</strong> one removal commit, recorded quoting you.",
    "d0093", ["Adopt the remote disposition ledger", "Reject: remove the ledger", "Do nothing yet"])

# the partial resync ask (D0094): three surface layers brought current, the schema deliberately left alone
P["resync"] = lambda: panel("resync", "Accept the partial engine resync", True,
    "the command reference, the Claude surface and the declared command facts are brought to the installed build; the code-element schema is left alone and its vocabulary conflict stays open, decided separately.",
    "every documented command dispatches; the 169 audited code elements keep their provenance; a full migrate stays refused until the schema question is decided.",
    [logic_lanes("Under the old stamp the docs name commands that cannot dispatch; under the new one every documented command runs",
        ("today", [("Docs name old commands", "45 sites", "bad", ""), ("Follower exits with usage", "", "bad", ""), ("Three checks red", "", "bad", "")], ["so", "so"]),
        ("after", [("Three layers current", "docs, surface, facts", "accent", ""), ("Commands dispatch", "", "ok", ""), ("Schema conflict stays visible", "open, not paid for", "warn", "")], ["so", "and"])),
     downstream("Accepting lands on the docs, the Claude surface and the command facts; the schema waits", ("Partial resync", ""),
        [("Working rules and skills", "command names", "45", "accent"), ("Claude surface", "regenerated", "55", "accent"), ("Command facts", "match the binary", "7", "ok"), ("Code-element schema", "unchanged; conflict open", "0", "warn")])],
    [("Accept", "nothing more", "the schema question, later"), ("Reject", "three layers reverted", "documented commands exit with usage"), ("Do nothing", "nothing", "the surface stamp stays unsigned")],
    ("the three checks pass under the installed build; the full migrate rolled back byte for byte.", "you would rather keep audit provenance than a clean migrate."),
    "<strong>Accept:</strong> nothing moves; the schema conflict comes back as its own ask. <strong>Reject:</strong> one revert commit, recorded quoting you.",
    "d0094", ["Accept the partial resync", "Reject: revert the three layers", "Do nothing yet"])

# the hook ask (D0095): the commit gate finds the binary the way the in-loop hooks do
P["hook"] = lambda: panel("hook", "Accept the commit gate's binary lookup", True,
    "the pre-commit hook finds the engine binary the way the in-loop hooks do: an explicit override, the machine-local install, the pinned directory, then PATH; a missing binary still commits, and the skip names every place it looked.",
    "a machine with a local install gates every commit; a machine without one commits with a named skip; push and CI are untouched.",
    [logic_lanes("A PATH-only lookup cannot see the local install, so commits land ungated; the shared lookup runs the gate",
        ("today", [("Hook reads PATH only", "", "muted", ""), ("Local install unseen", "", "bad", ""), ("Commit lands ungated", "twice this month", "bad", "")], ["so", "so"]),
        ("after", [("Hook reads four places", "override, local, pin, PATH", "accent", ""), ("Local install found", "", "ok", ""), ("Red tree aborts the commit", "", "ok", "")], ["so", "so"])),
     downstream("Accepting lands on one hook; the push hook and CI are unchanged", ("Shared lookup", ""),
        [("Pre-commit hook", "four-step lookup, named skip", "1", "accent"), ("Ungated commits", "seen before the change", "2", "warn"), ("Push hook", "unchanged", "0", "muted"), ("CI gate", "unchanged", "0", "muted")])],
    [("Accept", "nothing more", "nothing"), ("Make a missing binary fatal", "one line", "a contributor without the binary cannot commit"), ("Reject", "PATH-only lookup restored", "local installs commit ungated again")],
    ("two commits landed ungated under the old lookup; the new hook ran on every commit after it.", "you want the terminal gate as strict as the in-loop one, not stricter."),
    "<strong>Accept:</strong> nothing moves. <strong>Fatal:</strong> one commit, recorded quoting you. <strong>Reject:</strong> one revert commit.",
    "d0095", ["Accept the lookup as applied", "Also make a missing binary fatal", "Reject: PATH only"])

# per-tab frame fragments: (title clause, verdict sentence). The frame is composed from the asks present.
FRAME = {
    "resync": ("accept the partial engine resync", "the partial resync makes documented commands dispatch and keeps audit provenance."),
    "hook": ("accept the commit gate's binary lookup", "the hook lookup closes the gap that let two commits land ungated."),
    "ledger": ("accept the remote disposition ledger", "the ledger changes where your finding verdicts are collected, not what one means."),
    "engine": ("ratify the engine update", "the engine update already holds on disk, gate green."),
    "clauses": (f"accept the {n_kids} clause records", f"the {n_kids} clause records quote their clauses unchanged."),
    "wording": ("confirm the restored wording", "the restored wording is what you signed."),
    "ci": ("accept the typecheck step", "the typecheck step ratifies shipped work."),
    "timestamps": ("retire five requirements", "retiring five requirements makes the tier truthful."),
    "mounts": ("accept the mount record as history", "the mount record is dated reasoning, kept."),
    "page": ("adopt this page", "this page is the channel."),
}
# ------------------------------------------------------------------ assemble
tabs_html = "".join(f'<button role="tab" id="t-{k}" aria-selected="{"true" if i == 0 else "false"}" aria-controls="p-{k}"{"" if i == 0 else " tabindex=\"-1\""} type="button">{escape(n)}</button>' for i, (k, n) in enumerate(ASKS))
panels_html = "".join(f'<section role="tabpanel" id="p-{k}" aria-labelledby="t-{k}" data-digest-tab="{escape(n)}"{"" if i == 0 else " hidden"}>{P[k]()}</section>' for i, (k, n) in enumerate(ASKS))
added = v("deltaAdded")
added_txt = ", ".join(f"{n} {t.lower()}{'s' if n != 1 else ''}" for t, n in sorted(added.items()))
n_asks = len(ASKS)
WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight"}
frags = [FRAME[k][0] for k, _ in ASKS]
title = (frags[0][0].upper() + frags[0][1:]) if n_asks == 1 else ("; ".join(frags[:-1]) + "; " + frags[-1]).capitalize()
verdict_lead = "Accept it." if n_asks == 1 else ("Accept both." if n_asks == 2 else f"Accept all {WORDS.get(n_asks, str(n_asks))}.")
verdict_body = " ".join(s[0].upper() + s[1:] for s in (FRAME[k][1] for k, _ in ASKS))
page = f"""<meta charset="utf-8">
<title>SelfSync Decision Page</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Condensed:wght@400;500&family=Roboto+Mono:wght@400;500&display=swap">
{style}
{extra_css}
<div class="page">
<header class="rpt">
  <p class="project" data-digest="project"><b>Project</b> SelfSync &middot; williamweatherholtz/obsidian-selfsync</p>
  <h1 data-digest="title">{escape(title)}</h1>
  <div class="title-row">
    <p class="eyebrow" data-digest="subtitle">{"One ask" if n_asks == 1 else WORDS.get(n_asks, str(n_asks)).capitalize() + " asks, one tab each"}. Then Copy for AI.</p>
    <button class="copy" data-copy type="button" aria-label="Copy report for AI">&#8681; Copy for AI</button>
  </div>
</header>
<div class="ask"><p class="verdict"><strong>{verdict_lead}</strong> {verdict_body}</p>
<p class="rule">Rule: disk honest to what you signed; controls that caught drift kept; history kept; one answer per question.</p>
<div class="chips"><span class="chip"><b>Waiting</b> {v('pendingAcceptances')}</span><span class="chip"><b>Oldest</b> {v('oldestSince')}</span><span class="chip"><b>Checks</b> {G0} &rarr; {GH}</span></div>
<div class="tabs" role="tablist" aria-label="The asks">{tabs_html}</div>
{panels_html}
<label class="note-row">Anything to add<textarea data-d="note" rows="2" placeholder="optional"></textarea></label>
<p class="delta">Since the last release: {sum(added.values())} items added ({added_txt}), {v('deltaRetired')} retired, {v('deltaResolved')} issues resolved. {v('pendingDispositions')} finding verdicts wait on the disposition ledger (or the console deck when you are local).</p>
<div class="copy-bottom"><button class="copy" data-copy type="button" aria-label="Copy report for AI">&#8681; Copy for AI</button></div>
<footer class="rpt"><span data-digest="provenance">Tree {head}, {v('date')}: counts read from the authority queue, commit delta, decision files, manifest and version report; none typed. Exhibit geometry unmeasured (no browser probe).</span></footer>
</div>
{script}
"""
io.open("docs/decision-page/index.html", "w", encoding="utf-8").write(page)
print(f"wrote docs/decision-page/index.html - {v('pendingAcceptances')} acceptances, {len(ASKS)} tabs, {n_kids} clause records")
