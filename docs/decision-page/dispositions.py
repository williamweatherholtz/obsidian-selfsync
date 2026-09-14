#!/usr/bin/env python3
# not-an-instrument: every number on this page is READ from the tree at build time (`keel show dispositions`,
# `keel show open-issues`, the Issue records, their #Resolves resolvers and those resolvers' recorded verdicts).
"""Build SelfSync's finding-disposition ledger — the remote surface for the D0092 dispositions the console deck
would otherwise collect at http://127.0.0.1:7777 (the owner is not always local to that port).

    python docs/decision-page/dispositions.py        # writes docs/decision-page/dispositions.html + dispositions.json

The page lists every >= Medium finding that has no typed disposition, grouped by what its resolver has done, with
one act / accept-risk / dismiss choice per finding and a per-group bulk choice. Nothing on the page writes anything:
the owner copies the digest it composes and pastes it back; `record_dispositions.py` then records the digest verbatim
as a Statement (D0216) and writes each disposition through `keel record review --batch` (D0092). The digest is
transport, never truth (render skill: round-trip, don't shadow-store).
"""
import glob, io, json, os, re, subprocess
from html import escape

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
os.chdir(ROOT)
OUT = os.path.join("docs", "decision-page")


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, encoding="utf-8").stdout


# ------------------------------------------------------------------ facts
F = {}
def fact(k, val, how): F[k] = {"value": val, "how": how}; return val

head = fact("head", sh("git", "rev-parse", "--short=8", "HEAD").strip(), "git rev-parse --short=8 HEAD")
date = fact("date", sh("git", "log", "-1", "--format=%cs").strip(), "git log -1 --format=%cs")
lens = json.loads(sh("keel", "show", "dispositions", "."))
pending = [f for f in lens["findings"] if not f["dispositioned"]]
fact("awaiting", len(pending), "keel show dispositions . | findings where dispositioned == false")
fact("geMedium", lens["ge_medium_findings"], "keel show dispositions . | ge_medium_findings")
oi = json.loads(sh("keel", "show", "open-issues", "."))
open_set = {x["issue"] if isinstance(x, dict) and "issue" in x else (x.get("name") if isinstance(x, dict) else x) for x in oi.get("open_issues", [])}

texts = {p: io.open(p, encoding="utf-8").read() for p in glob.glob(".tracking/**/*.sysml", recursive=True)}
alltxt = "\n".join(texts.values())
dectxt = "\n".join(io.open(p, encoding="utf-8").read() for p in glob.glob(".engine/decisions/*.sysml"))
ATTR = re.compile(r':>> (\w+) = (?:"((?:[^"\\]|\\.)*)"|([\w:]+))')


def attrs(body):
    return {k: (s if s else e) for k, s, e in ATTR.findall(body)}


def unesc(s):
    return s.replace('\\"', '"').replace("\\n", " ")


def resolver_state(r):
    if re.search(r"part " + r + r"DoDR\d+ : TestResult \{[^}]*VerdictKind::pass", alltxt):
        return "done"
    if re.search(r"part " + r + r" : Decision \{[^}]*DecisionStatus::accepted", dectxt):
        return "decision"
    return "open"


rows = []
for f in pending:
    n = f["finding"]
    m = re.search(r"part " + n + r" : Issue \{(.*?)\}", alltxt, re.S)
    a = attrs(m.group(1)) if m else {}
    res = re.findall(r"#Resolves dependency from (\w+) to " + n + ";", alltxt)
    states = [resolver_state(r) for r in res]
    group = "open" if "open" in states else ("decision" if "decision" in states else ("done" if states else "none"))
    rows.append({"finding": n, "severity": f["severity"], "title": unesc(a.get("title", "")), "createdAt": a.get("createdAt", ""),
                 "description": unesc(a.get("description", "")), "relatedTask": a.get("relatedTask", ""),
                 "inField": a.get("discoveredInField", "false") == "true", "resolvers": res, "states": states, "group": group,
                 "open": n in open_set})

sev_order = {"Critical": 0, "High": 1, "Medium": 2}
rows.sort(key=lambda r: (sev_order.get(r["severity"], 9), r["createdAt"], r["finding"]))
fact("bySeverity", {s: sum(1 for r in rows if r["severity"] == s) for s in ("Critical", "High", "Medium") if any(r["severity"] == s for r in rows)}, "count per Issue.severity")
fact("byGroup", {g: sum(1 for r in rows if r["group"] == g) for g in ("done", "decision", "open", "none")}, "resolver state: a passing <resolver>DoDR result = done; an accepted Decision resolver = decision; else open")
fact("inField", sum(1 for r in rows if r["inField"]), "Issue.discoveredInField == true")
fact("stillOpen", sum(1 for r in rows if r["open"]), "keel show open-issues . | open_issues intersected with the pending set")
GROUPS = [
    ("done", "Fix shipped", "The resolver task has a passing verdict: the change these findings asked for is in the code or the model. "
             "ACT records that the fix was the answer; ACCEPT RISK says the fix was partial and the rest is carried knowingly."),
    ("decision", "Mooted by an accepted decision", "An accepted Decision resolves these: the project chose not to do the thing. "
                 "DISMISS says the finding was never a defect here; ACCEPT RISK says it is real and the decision carries it."),
    ("open", "Resolver still open", "The resolving task has no passing verdict yet. ACT keeps the task on the backlog; "
             "ACCEPT RISK closes the finding without the task; DISMISS says the finding was wrong."),
    ("none", "No resolver", "Untriaged. Should not occur under the issues guard."),
]
GROUPS = [g for g in GROUPS if any(r["group"] == g[0] for r in rows)]
json.dump({"facts": F, "rows": rows}, io.open(os.path.join(OUT, "dispositions.json"), "w", encoding="utf-8", newline="\n"), indent=1)


# ------------------------------------------------------------------ page
def v(k): return F[k]["value"]


def row_html(r):
    sev = r["severity"]
    res = " ".join(f'<span class="res {escape(s)}">{escape(x)} <em>{ {"done": "done", "decision": "accepted", "open": "open"}[s] }</em></span>' for x, s in zip(r["resolvers"], r["states"]))
    field = '<span class="tag">field</span>' if r["inField"] else ""
    desc = escape(r["description"]) if r["description"] else "<i>no description recorded</i>"
    n = escape(r["finding"])
    return (f'<li class="row sev-{sev.lower()}" data-id="{n}" data-sev="{sev}" data-group="{escape(r["group"])}" data-text="{escape((r["title"] + " " + r["finding"]).lower())}">'
            f'<div class="head"><span class="sev">{sev[0]}</span><h3>{escape(r["title"]) or n}</h3></div>'
            f'<div class="meta"><code>{n}</code><span>{escape(r["createdAt"])}</span>{field}{res}</div>'
            f'<details><summary>what was found</summary><p>{desc}</p></details>'
            f'<div class="verdict" role="radiogroup" aria-label="disposition for {n}">'
            + "".join(f'<label><input type="radio" name="v-{n}" value="{k}"><span>{t}</span></label>' for k, t in (("act", "Act"), ("accept-risk", "Accept risk"), ("dismiss", "Dismiss")))
            + f'<input class="note" type="text" placeholder="note (optional)" aria-label="note for {n}"></div></li>')


groups_html = ""
for key, label, rule in GROUPS:
    grp = [r for r in rows if r["group"] == key]
    groups_html += (f'<section class="group" data-group="{key}"><div class="ghead"><div><h2>{escape(label)} <b>{len(grp)}</b></h2><p class="rule">{escape(rule)}</p></div>'
                    f'<div class="bulk" role="group" aria-label="whole group"><span>whole group:</span>'
                    f'<button type="button" data-bulk="act">Act</button><button type="button" data-bulk="accept-risk">Accept risk</button>'
                    f'<button type="button" data-bulk="dismiss">Dismiss</button><button type="button" data-bulk="" class="ghost">Clear</button></div></div>'
                    f'<ul class="rows">{"".join(row_html(r) for r in grp)}</ul></section>')

sev_chips = "".join(f'<span class="chip"><b>{c}</b>{escape(s)}</span>' for s, c in v("bySeverity").items())
grp_chips = "".join(f'<span class="chip"><b>{v("byGroup")[k]}</b>{escape(l.lower())}</span>' for k, l, _ in GROUPS)

HTML = f"""<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SelfSync Disposition Ledger</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&family=Roboto+Condensed:wght@400;500&family=Roboto+Mono:wght@400;500&display=swap">
<style>
  :root{{
    --paper:#FFFFFF; --ink:#1A1A1A; --head:#00011E; --accent:#23A2D7;
    --line:#B9C8D2; --fill:#EEF3F6; --card:#F4F7F9; --muted:#4A5560;
    --ok:#2E7D46; --warn:#B87A00; --bad:#B00020;
  }}
  @media (prefers-color-scheme: dark){{
    :root:not([data-theme="light"]){{
      --paper:#0B1220; --ink:#DCE4EC; --head:#EAF2F8; --accent:#4FBBE8;
      --line:#2E4256; --fill:#152238; --card:#111B2B; --muted:#93A3B3;
      --ok:#5BBF83; --warn:#E0A947; --bad:#F27689;
    }}
  }}
  :root[data-theme="dark"]{{
    --paper:#0B1220; --ink:#DCE4EC; --head:#EAF2F8; --accent:#4FBBE8;
    --line:#2E4256; --fill:#152238; --card:#111B2B; --muted:#93A3B3;
    --ok:#5BBF83; --warn:#E0A947; --bad:#F27689;
  }}
  *{{box-sizing:border-box}}
  body{{background:var(--paper); color:var(--ink); margin:0; font:300 15px/1.55 Roboto,"Helvetica Neue",Arial,sans-serif}}
  .page{{max-width:960px; margin:0 auto; padding:0 20px 140px}}
  header{{padding-top:22px; border-bottom:2px solid var(--accent); padding-bottom:14px}}
  .eyebrow{{font:400 12.5px/1.4 "Roboto Condensed",sans-serif; letter-spacing:.13em; text-transform:uppercase; color:var(--accent); margin:0}}
  h1{{font:300 32px/1.15 Roboto,sans-serif; color:var(--head); margin:.35em 0 .3em; text-wrap:balance}}
  .lede{{max-width:72ch; margin:.4em 0 0; font-size:15.5px}}
  .lede b{{font-weight:500; color:var(--head)}}
  .chips{{display:flex; gap:8px; flex-wrap:wrap; margin:14px 0 0}}
  .chip{{font:500 11px/1 "Roboto Condensed",sans-serif; letter-spacing:.1em; text-transform:uppercase; color:var(--muted);
    border:1px solid var(--line); background:var(--fill); border-radius:3px; padding:6px 9px; font-variant-numeric:tabular-nums}}
  .chip b{{color:var(--head); font-weight:500; margin-right:5px}}
  .how{{display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin:18px 0 6px}}
  .how div{{border-left:3px solid var(--line); padding:2px 0 2px 12px; font-size:14px}}
  .how b{{display:block; font:500 12px/1.6 "Roboto Condensed",sans-serif; letter-spacing:.1em; text-transform:uppercase; color:var(--head)}}
  .how .act{{border-color:var(--accent)}} .how .risk{{border-color:var(--warn)}} .how .dis{{border-color:var(--muted)}}
  .tools{{display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:18px 0 6px; position:sticky; top:0; background:var(--paper); padding:10px 0; z-index:2; border-bottom:1px solid var(--line)}}
  .tools input[type=search]{{flex:1 1 220px; min-height:40px; border:1px solid var(--line); border-radius:6px; padding:0 12px; background:var(--card); color:var(--ink); font:300 14.5px Roboto,sans-serif}}
  .tools select,.tools label{{font:400 13.5px "Roboto Condensed",sans-serif; color:var(--ink)}}
  .tools select{{min-height:40px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); padding:0 8px}}
  .tools label{{display:inline-flex; gap:6px; align-items:center; min-height:40px}}
  .group{{margin-top:26px}}
  .ghead{{display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap; align-items:flex-end; border-bottom:1px solid var(--line); padding-bottom:8px}}
  h2{{font:500 19px/1.25 "Roboto Condensed",sans-serif; color:var(--head); margin:0}}
  h2 b{{font-weight:400; color:var(--accent); margin-left:6px; font-variant-numeric:tabular-nums}}
  .rule{{font-size:13.5px; color:var(--muted); max-width:78ch; margin:4px 0 0}}
  .bulk{{display:flex; gap:6px; align-items:center; flex-wrap:wrap}}
  .bulk span{{font:500 11px/1 "Roboto Condensed",sans-serif; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin-right:4px}}
  button{{font:500 13.5px/1 "Roboto Condensed",sans-serif; letter-spacing:.05em; min-height:36px; padding:0 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--head); cursor:pointer}}
  button:hover{{border-color:var(--accent)}} button:focus-visible{{outline:2px solid var(--accent); outline-offset:2px}}
  button.ghost{{color:var(--muted)}}
  ul.rows{{list-style:none; margin:0; padding:0}}
  .row{{border-bottom:1px solid var(--line); padding:12px 0 12px 14px; position:relative}}
  .row::before{{content:""; position:absolute; left:0; top:14px; bottom:14px; width:3px; border-radius:2px; background:var(--line)}}
  .row.sev-high::before{{background:var(--bad)}} .row.sev-critical::before{{background:var(--bad)}} .row.sev-medium::before{{background:var(--warn)}}
  .row.decided::before{{background:var(--ok)}}
  .row.hidden{{display:none}}
  .head{{display:flex; gap:10px; align-items:baseline}}
  .sev{{font:500 11px/1 "Roboto Condensed",sans-serif; color:var(--paper); background:var(--muted); border-radius:3px; padding:4px 6px; flex:none}}
  .sev-high .sev,.sev-critical .sev{{background:var(--bad)}} .sev-medium .sev{{background:var(--warn)}}
  h3{{font:400 15.5px/1.35 Roboto,sans-serif; color:var(--head); margin:0; text-wrap:pretty}}
  .meta{{display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:5px 0 0; font-size:12.5px; color:var(--muted)}}
  .meta code{{font:400 12px "Roboto Mono",monospace; color:var(--muted)}}
  .tag{{font:500 10px/1 "Roboto Condensed",sans-serif; letter-spacing:.1em; text-transform:uppercase; border:1px solid var(--warn); color:var(--warn); border-radius:3px; padding:2px 5px}}
  .res{{font:400 12px "Roboto Mono",monospace}} .res em{{font:500 10px/1 "Roboto Condensed",sans-serif; letter-spacing:.08em; text-transform:uppercase; margin-left:3px}}
  .res.done em{{color:var(--ok)}} .res.open em{{color:var(--warn)}} .res.decision em{{color:var(--accent)}}
  details{{margin:6px 0 0; font-size:13.5px}} summary{{cursor:pointer; color:var(--accent); font:400 13px "Roboto Condensed",sans-serif}}
  details p{{max-width:80ch; margin:6px 0 0; color:var(--ink)}}
  .verdict{{display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:9px 0 0}}
  .verdict label{{display:inline-flex; gap:7px; align-items:center; border:1px solid var(--line); border-radius:6px; padding:0 11px; min-height:36px; cursor:pointer; background:var(--card); font-size:13.5px}}
  .verdict label:has(input:checked){{border-color:var(--accent); background:var(--fill); box-shadow:inset 3px 0 0 var(--accent)}}
  .verdict input[type=radio]{{accent-color:var(--accent); margin:0}}
  .note{{flex:1 1 180px; min-height:36px; border:1px solid var(--line); border-radius:6px; padding:0 10px; background:var(--card); color:var(--ink); font:300 13.5px Roboto,sans-serif}}
  .note:focus,.tools input:focus{{outline:2px solid var(--accent); outline-offset:1px}}
  footer.bar{{position:fixed; left:0; right:0; bottom:0; background:var(--paper); border-top:2px solid var(--accent); padding:10px 20px; z-index:3}}
  .bar .in{{max-width:960px; margin:0 auto; display:flex; gap:12px; align-items:center; flex-wrap:wrap}}
  .bar .count{{font:400 14px "Roboto Condensed",sans-serif; color:var(--head); font-variant-numeric:tabular-nums}}
  .bar .count b{{font-weight:500; color:var(--accent)}}
  button.copy{{background:var(--accent); color:#fff; border-color:var(--accent); min-height:44px; padding:0 18px; font-size:14.5px}}
  button.copy:hover{{filter:brightness(1.08)}}
  #digest{{width:100%; min-height:88px; margin-top:8px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--ink); font:400 12px/1.45 "Roboto Mono",monospace; padding:8px}}
  .bar small{{color:var(--muted); font-size:12.5px}}
  @media (prefers-reduced-motion: no-preference){{ .row{{transition:background .15s}} }}
</style>
<div class="page">
<header>
  <p class="eyebrow">SelfSync · finding dispositions · tree {escape(head)} · {escape(date)}</p>
  <h1>Disposition Ledger</h1>
  <p class="lede"><b>{v("awaiting")} findings</b> rated Medium or higher still carry no typed verdict from you. Each one was raised by a critique or a field report,
  and each already has a resolver. Choosing a verdict here is the D0092 judgment the console deck would collect; this page collects it where you are.</p>
  <div class="chips">{sev_chips}{grp_chips}<span class="chip"><b>{v("inField")}</b>found in the field</span></div>
  <div class="how">
    <div class="act"><b>Act</b>The fix is the answer. For a shipped fix this attests it; for an open resolver it keeps the task on the backlog.</div>
    <div class="risk"><b>Accept risk</b>Leave it as it stands, knowingly. The finding closes and the residual is yours.</div>
    <div class="dis"><b>Dismiss</b>Not a defect here. The finding closes as a false positive.</div>
  </div>
  <p class="rule">Nothing on this page is recorded. Choose row by row or by whole group, then <b>Copy digest</b> and paste it back in the chat.
  The digest is recorded verbatim as your statement; every disposition it names is written through <code>keel record review</code> against tree {escape(head)}. Rows left blank stay open.</p>
</header>
<div class="tools">
  <input type="search" id="q" placeholder="filter by title or id" aria-label="filter">
  <select id="sev" aria-label="severity"><option value="">all severities</option><option>High</option><option>Medium</option></select>
  <label><input type="checkbox" id="undecided"> undecided only</label>
</div>
{groups_html}
</div>
<footer class="bar"><div class="in">
  <span class="count"><b id="n-decided">0</b> decided · <span id="n-open">{v("awaiting")}</span> open</span>
  <button type="button" class="copy" id="copy">Copy digest</button>
  <button type="button" class="ghost" id="reset">Clear all</button>
  <small id="msg">choices are kept in this browser until you copy</small>
  <textarea id="digest" readonly aria-label="digest" placeholder="the digest appears here after Copy digest; select all and copy if the clipboard is blocked"></textarea>
</div></footer>
<script>
(function(){{
  var HEAD={json.dumps(head)}, KEY='selfsync-dispositions-'+HEAD, rows=Array.prototype.slice.call(document.querySelectorAll('.row'));
  var state={{}};
  try{{ state=JSON.parse(localStorage.getItem(KEY)||'{{}}')||{{}}; }}catch(e){{ state={{}}; }}
  function save(){{ try{{ localStorage.setItem(KEY,JSON.stringify(state)); }}catch(e){{}} }}
  function apply(){{
    var d=0;
    rows.forEach(function(r){{
      var id=r.dataset.id, s=state[id]||{{}};
      r.querySelectorAll('input[type=radio]').forEach(function(i){{ i.checked=(i.value===s.v); }});
      r.querySelector('.note').value=s.n||'';
      r.classList.toggle('decided',!!s.v); if(s.v) d++;
    }});
    document.getElementById('n-decided').textContent=d; document.getElementById('n-open').textContent=rows.length-d;
    filter();
  }}
  function filter(){{
    var q=document.getElementById('q').value.toLowerCase(), sev=document.getElementById('sev').value, und=document.getElementById('undecided').checked;
    rows.forEach(function(r){{
      var show=(!q||r.dataset.text.indexOf(q)>=0)&&(!sev||r.dataset.sev===sev)&&(!und||!r.classList.contains('decided'));
      r.classList.toggle('hidden',!show);
    }});
  }}
  document.addEventListener('change',function(e){{
    var r=e.target.closest('.row'); if(!r) return;
    var s=state[r.dataset.id]||{{}};
    if(e.target.type==='radio') s.v=e.target.value; if(e.target.classList.contains('note')) s.n=e.target.value;
    state[r.dataset.id]=s; save(); apply();
  }});
  document.addEventListener('input',function(e){{ if(e.target.classList.contains('note')){{ var r=e.target.closest('.row'); var s=state[r.dataset.id]||{{}}; s.n=e.target.value; state[r.dataset.id]=s; save(); }} }});
  document.querySelectorAll('[data-bulk]').forEach(function(b){{
    b.addEventListener('click',function(){{
      var g=b.closest('.group'); g.querySelectorAll('.row').forEach(function(r){{ var s=state[r.dataset.id]||{{}}; if(b.dataset.bulk) s.v=b.dataset.bulk; else delete s.v; state[r.dataset.id]=s; }});
      save(); apply();
      document.getElementById('msg').textContent=(b.dataset.bulk?('"'+b.textContent+'" set on the whole group "'+g.querySelector('h2').firstChild.textContent.trim()+'"'):'group cleared');
    }});
  }});
  ['q','sev','undecided'].forEach(function(id){{ document.getElementById(id).addEventListener('input',filter); document.getElementById(id).addEventListener('change',filter); }});
  document.getElementById('reset').addEventListener('click',function(){{ state={{}}; save(); apply(); document.getElementById('digest').value=''; }});
  function digest(){{
    var by={{'act':[],'accept-risk':[],'dismiss':[]}}, notes=[], open=0;
    rows.forEach(function(r){{ var s=state[r.dataset.id]||{{}}; if(s.v){{ by[s.v].push(r.dataset.id); if(s.n) notes.push('note '+r.dataset.id+': '+s.n.replace(/\\s+/g,' ').trim()); }} else open++; }});
    var lines=['dispositions @'+HEAD+' by wweatherholtz'];
    ['act','accept-risk','dismiss'].forEach(function(k){{ lines.push(k+' ('+by[k].length+'): '+by[k].join(' ')); }});
    lines=lines.concat(notes); lines.push('undecided: '+open);
    return lines.join('\\n');
  }}
  document.getElementById('copy').addEventListener('click',function(){{
    var t=digest(), ta=document.getElementById('digest'); ta.value=t;
    var done=function(ok){{ document.getElementById('msg').textContent=ok?'copied - paste it in the chat':'clipboard blocked - select the text below and copy it'; if(!ok){{ ta.focus(); ta.select(); }} }};
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function(){{done(true)}},function(){{done(false)}}); else done(false);
  }});
  apply();
}})();
</script>
"""
io.open(os.path.join(OUT, "dispositions.html"), "w", encoding="utf-8", newline="\n").write(HTML)
print(f"dispositions.html: {v('awaiting')} findings, groups {v('byGroup')}, severities {v('bySeverity')}, tree {head}")
