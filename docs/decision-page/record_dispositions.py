#!/usr/bin/env python3
"""Record the owner's pasted disposition digest (from dispositions.html) through the write API.

    python docs/decision-page/record_dispositions.py DIGEST.txt --date YYYY-MM-DD [--by wweatherholtz] [--dry-run]

What it does, in order, and refuses to do otherwise:
  1. Parses the digest: `dispositions @<sha> by <actor>`, then `act (n): id id ...`, `accept-risk (n): ...`,
     `dismiss (n): ...`, optional `note <id>: text` lines, `undecided: n`. Every id must be a finding the
     dispositions lens lists as UNdispositioned at this tree; an unknown or already-dispositioned id aborts the run.
     The counts in parentheses must match the ids listed (control totals, D0067).
  2. Records the digest VERBATIM as a Statement (`keel record statement --from`, D0216/D0236) - the owner's words are
     the evidence for every disposition below, so they are stored once, unparaphrased, and cited from each.
  3. Writes one batch for `keel record review --batch` (D0092: act / accept-risk / dismiss -> a method=confirmation
     verification carrying disposition : DispositionKind, #Dispositions-linked to the finding, in the JUDGE's per-actor
     critiques file). Rationale per record: which digest line carried it, the statement's name, the owner's note if any.
  4. Prints `keel show dispositions` counts before and after. Never commits.

No disposition is ever inferred: a finding the digest does not name stays open (render skill anti-pattern 5).
"""
import argparse, io, json, os, re, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
os.chdir(ROOT)


def run(*a, check=True):
    r = subprocess.run(a, capture_output=True, text=True, encoding="utf-8")
    if check and r.returncode != 0:
        sys.exit(f"FAILED ({r.returncode}): {' '.join(a)}\n{r.stdout}{r.stderr}")
    return r.stdout + r.stderr


ap = argparse.ArgumentParser()
ap.add_argument("digest")
ap.add_argument("--date", required=True, help="the day the owner pasted the digest (their saidAt / judgedAt)")
ap.add_argument("--by", default=None, help="override the actor named in the digest header")
ap.add_argument("--dry-run", action="store_true")
args = ap.parse_args()

text = io.open(args.digest, encoding="utf-8").read().strip()
lines = [l.strip() for l in text.splitlines() if l.strip()]
m = re.match(r"dispositions @([0-9a-f]{7,40}) by (\S+)$", lines[0])
if not m:
    sys.exit(f"first line must read `dispositions @<sha> by <actor>`, got: {lines[0]!r}")
sha, actor = m.group(1), (args.by or m.group(2))
head = run("git", "rev-parse", "--short=8", "HEAD").strip()
if not head.startswith(sha[:7]) and not sha.startswith(head[:7]):
    print(f"NOTE: digest tree {sha} is not HEAD {head}; dispositions are recorded against {sha} as the owner saw it")

verdicts, notes = {}, {}
for l in lines[1:]:
    mv = re.match(r"(act|accept-risk|dismiss) \((\d+)\):\s*(.*)$", l)
    mn = re.match(r"note (\S+):\s*(.*)$", l)
    if mv:
        ids = mv.group(3).split()
        if len(ids) != int(mv.group(2)):
            sys.exit(f"control total mismatch on `{mv.group(1)}`: header says {mv.group(2)}, {len(ids)} ids listed")
        for i in ids:
            if i in verdicts:
                sys.exit(f"{i} appears under two verdicts")
            verdicts[i] = mv.group(1)
    elif mn:
        notes[mn.group(1)] = mn.group(2)
    elif re.match(r"undecided: \d+$", l):
        pass
    else:
        sys.exit(f"unrecognised digest line: {l!r}")

lens = json.loads(run("keel", "show", "dispositions", "."))
pending = {f["finding"] for f in lens["findings"] if not f["dispositioned"]}
unknown = sorted(i for i in verdicts if i not in pending)
if unknown:
    sys.exit(f"{len(unknown)} id(s) are not undispositioned findings at this tree: {' '.join(unknown)}")
if not verdicts:
    sys.exit("the digest names no dispositions")
counts = {k: sum(1 for v in verdicts.values() if v == k) for k in ("act", "accept-risk", "dismiss")}
print(f"before: dispositioned {lens['dispositioned']} / {lens['ge_medium_findings']}; digest carries {counts}, {len(notes)} note(s)")
if args.dry_run:
    sys.exit(0)

# 2. the statement - the owner's words, once, verbatim
out = run("keel", "record", "statement", "--from", args.digest, "--said-by", actor, "--said-at", args.date,
          "--title", f"Disposition digest for {len(verdicts)} findings at tree {sha}", "--channel", "chat")
ms = re.search(r"\b(st\d{3,})\b", out)
if not ms:
    sys.exit(f"could not read the statement name from keel's output:\n{out}")
st = ms.group(1)
print(f"statement {st} recorded")

# 3. the batch
batch = {"view": "dispositions", "judgedBy": actor, "judgedAgainst": sha, "dispositions": []}
for fid, v in verdicts.items():
    rationale = (f"Owner's disposition, from the digest they pasted on {args.date} (statement {st}, line `{v}`), "
                 f"chosen on the disposition ledger built at tree {sha}.")
    if fid in notes:
        rationale += f" Their note: {notes[fid]}"
    batch["dispositions"].append({"element": fid, "verdict": v, "rationale": rationale})
fd, bpath = tempfile.mkstemp(suffix=".json", prefix="disposition-batch-")
with io.open(fd, "w", encoding="utf-8") as fh:
    json.dump(batch, fh, indent=1)
out = run("keel", "record", "review", "--batch", bpath, "--sha", sha, "--judged-by", actor, "--judged-at", args.date)
written = len(re.findall(r"disposition:(act|acceptRisk|dismiss)", out))
os.remove(bpath)
print(f"written: {written} disposition(s)")
if written != len(verdicts):
    sys.exit(f"control total mismatch: {len(verdicts)} in the digest, {written} written\n{out[-2000:]}")

# 4. after
lens = json.loads(run("keel", "show", "dispositions", "."))
print(f"after: dispositioned {lens['dispositioned']} / {lens['ge_medium_findings']}; undispositioned {lens['undispositioned']}")
print("next: keel gate validate . && keel gate guard . ; then commit")
