#!/usr/bin/env python3
"""Import the league workbook (College Hoops Teams League.xlsx) into SQL.

Reads two sheets:
  "Conference Tiers"  -> conference_tiers (tier per NCAA conference) and teams (every D1 team)
  "<season> DRAFT"    -> managers and rosters for the season

Usage:
  scripts/import_league.py "College Hoops Teams League.xlsx" --season 2026-27 \\
      --start 2026-11-02 --end 2027-04-06 > import.sql
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f import.sql

then re-run sync-scores for the season so points reflect the new rosters/tiers.

Spreadsheet names ("Florida State", "USC", "Saint Mary's") are matched to the NCAA
scoreboard's short names ("Florida St.", "Southern California", "Saint Mary's (CA)").
To know those, the script pulls a couple of weeks of NCAA scoreboards (--index-start,
--index-days), which also tells it which API conference each sheet conference is.
Anything it can't match is listed on stderr and the script exits non-zero, so nothing
is imported half-matched. Fix by adding to ALIASES below.

Standard library only, so it runs anywhere with python3 (including the Proxmox VM).
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import re
import sys
import time
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

NCAA_API_BASE = "https://ncaa-api.henrygd.me"
# The API rejects Python's default urllib user agent with 403.
USER_AGENT = "fantasy-hoops-import/1.0"

# Spreadsheet name (after normalize()) -> NCAA scoreboard short name.
ALIASES = {
    "usc": "Southern California",
    "unc": "North Carolina",
    "miami": "Miami (FL)",
    "miami (oh)": "Miami (OH)",
    "pitt": "Pittsburgh",
    "saint mary's": "Saint Mary's (CA)",
    "st. thomas": "St. Thomas (MN)",
    "st. john's": "St. John's (NY)",
    "queens": "Queens (NC)",
    "charleston": "Col. of Charleston",
    "saint joe's": "Saint Joseph's",
    "unc wilmington": "UNCW",
    "unc wilmgton": "UNCW",
    "unc greensboro": "UNC Greensboro",
    "unc asheville": "UNC Asheville",
    "charleston suthern": "Charleston So.",
    "charleston southern": "Charleston So.",
    "binghampton": "Binghamton",
    "loyola chicago": "Loyola Chicago",
    "loyola marymount": "LMU (CA)",
    "loyola md": "Loyola Maryland",
    "fairleigh dickinson": "FDU",
    "fgcu": "FGCU",
    "liu": "LIU",
    "uic": "UIC",
    "umbc": "UMBC",
    "ut martin": "UT Martin",
    "ut arlington": "UT Arlington",
    "ut rio grande valley": "UTRGV",
    "utrgv": "UTRGV",
    "texas a&m cc": "A&M-Corpus Christi",
    "east texas a&m": "East Texas A&M",
    "se louisiana": "Southeastern La.",
    "southeast missouri": "Southeast Mo. St.",
    "siu edwardsville": "SIUE",
    "prairie view a&m": "Prairie View",
    "arkansas pine bluff": "Ark.-Pine Bluff",
    "mississippi valley st.": "Mississippi Val.",
    "maryland eastern shore": "UMES",
    "north carolina central": "N.C. Central",
    "north carolina a&t": "N.C. A&T",
    "south carolina st.": "South Carolina St.",
    "bethune-cookman": "Bethune-Cookman",
    "florida a&m": "Florida A&M",
    "alabama a&m": "Alabama A&M",
    "app st.": "App State",
    "ulm": "ULM",
    "louisiana": "Louisiana",
    "fiu": "FIU",
    "uab": "UAB",
    "utsa": "UTSA",
    "utep": "UTEP",
    "ucf": "UCF",
    "smu": "SMU",
    "tcu": "TCU",
    "byu": "BYU",
    "lsu": "LSU",
    "vcu": "VCU",
    "unlv": "UNLV",
    "njit": "NJIT",
    "etsu": "ETSU",
    "vmi": "VMI",
    "csun": "CSUN",
    "uc santa barbara": "UC Santa Barbara",
    "hawai'i": "Hawaii",
    "depaul": "DePaul",
    "cal": "California",
    "cal baptist": "California Baptist",
    "cal st. bakersfield": "CSU Bakersfield",
    "cal st. fullerton": "Cal St. Fullerton",
    "long beach st.": "Long Beach St.",
    "sacramento st.": "Sacramento St.",
    "ole miss": "Ole Miss",
    "umass": "Massachusetts",
    "umass lowell": "UMass Lowell",
    "kansas city": "Kansas City",
    "omaha": "Omaha",
    "iu indy": "IU Indy",
    "purdue fort wayne": "Purdue Fort Wayne",
    "detroit mercy": "Detroit Mercy",
    "green bay": "Green Bay",
    "milwaukee": "Milwaukee",
    "le moyne": "Le Moyne",
    "mount st. mary's": "Mount St. Mary's",
    "saint peter's": "Saint Peter's",
    "st. bonaventure": "St. Bonaventure",
    "the citadel": "The Citadel",
    "western carolina": "Western Caro.",
    "western kentucky": "Western Ky.",
    "eastern kentucky": "Eastern Ky.",
    "central arkansas": "Central Ark.",
    "north alabama": "North Ala.",
    "west georgia": "West Ga.",
    "georgia southern": "Ga. Southern",
    "middle tennessee": "Middle Tenn.",
    "florida atlantic": "Fla. Atlantic",
    "south florida": "South Fla.",
    "east carolina": "East Carolina",
    "northern iowa": "UNI",
    "southern illinois": "Southern Ill.",
    "illinois st.": "Illinois St.",
    "northern illinois": "NIU",
    "northern kentucky": "Northern Ky.",
    "northern arizona": "Northern Ariz.",
    "northern colorado": "Northern Colo.",
    "eastern washington": "Eastern Wash.",
    "eastern illinois": "Eastern Ill.",
    "eastern michigan": "Eastern Mich.",
    "western michigan": "Western Mich.",
    "central michigan": "Central Mich.",
    "western illinois": "Western Ill.",
    "southern indiana": "Southern Ind.",
    "southern utah": "Southern Utah",
    "central connecticut": "Central Conn. St.",
    "north florida": "North Florida",
    "houston christian": "Houston Christian",
    "incarnate word": "UIW",
    "stephen f. austin": "SFA",
    "northwestern st.": "Northwestern St.",
    "nicholls": "Nicholls",
    "new orleans": "LSU New Orleans",
    "grambling st.": "Grambling",
    "albany": "UAlbany",
    "alcorn st.": "Alcorn",
    "lamar": "Lamar University",
    "southern miss": "Southern Miss.",
    "southern": "Southern U.",
    "mercyhurst": "Mercyhurst",
    "new haven": "New Haven",
    "stonehill": "Stonehill",
    "west florida": "West Florida",
    "gardner-webb": "Gardner-Webb",
    "usc upstate": "USC Upstate",
    "boston": "Boston U.",
    "army": "Army West Point",
    "loyola maryland": "Loyola Maryland",
    "william & mary": "William & Mary",
    "seattle": "Seattle U",
    "denver": "Denver",
    "texas": "Texas",
    "texas a&m": "Texas A&M",
}

TIER_LABELS = {
    "high majors": "highMajor",
    "high mid-majors": "highMid",
    "high mid majors": "highMid",
    "true mid-majors": "trueMid",
    "true mid majors": "trueMid",
    "low-majors": "lowMajor",
    "low majors": "lowMajor",
    "low mid-majors": "lowMajor",
}


# ---------------------------------------------------------------- xlsx reading
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}


def read_workbook(path: str) -> dict[str, list[list[str]]]:
    """Return {sheet name: rows}, each row a list of cell strings (column-aligned)."""
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    sheets: dict[str, list[list[str]]] = {}
    for sh in wb.find("m:sheets", NS):
        target = rels[sh.get(f"{{{NS['r']}}}id")].lstrip("/")
        target = target if target.startswith("xl/") else "xl/" + target
        rows: list[list[str]] = []
        for row in ET.fromstring(z.read(target)).iter(f"{{{NS['m']}}}row"):
            idx = int(row.get("r")) - 1
            cells: dict[int, str] = {}
            for c in row.findall("m:c", NS):
                v = c.find("m:v", NS)
                kind = c.get("t")
                if kind == "s" and v is not None:
                    val = shared[int(v.text)]
                elif kind == "inlineStr":
                    val = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
                else:
                    val = v.text if v is not None else ""
                col = 0
                for ch in re.match(r"[A-Z]+", c.get("r")).group():
                    col = col * 26 + ord(ch) - 64
                cells[col - 1] = (val or "").strip()
            while len(rows) < idx:
                rows.append([])
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
        sheets[sh.get("name")] = rows
    return sheets


def cell(rows: list[list[str]], r: int, c: int) -> str:
    return rows[r][c] if r < len(rows) and c < len(rows[r]) else ""


# ---------------------------------------------------------------- name matching
def normalize(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).replace("’", "'").strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\bState\b", "St.", s)
    return s.lower()


def build_ncaa_index(start: dt.date, days: int, base: str) -> dict[str, str]:
    """NCAA short name -> conferenceSeo, from `days` days of scoreboards."""
    seen: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for i in range(days):
        d = start + dt.timedelta(days=i)
        url = f"{base}/scoreboard/basketball-men/d1/{d:%Y/%m/%d}/all-conf"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"accept": "application/json", "user-agent": USER_AGENT}), timeout=30) as r:
                data = json.load(r)
        except Exception as e:  # noqa: BLE001 - a missing day is fine
            print(f"  warning: {d} scoreboard failed: {e}", file=sys.stderr)
            continue
        for w in data.get("games", []):
            g = w.get("game", w)
            for side in ("home", "away"):
                t = g.get(side) or {}
                name = (t.get("names") or {}).get("short")
                conf = ((t.get("conferences") or [{}])[0] or {}).get("conferenceSeo") or ""
                if name:
                    seen[name][conf.lower()] += 1
        time.sleep(0.3)  # stay under the public API's rate limit
    return {name: c.most_common(1)[0][0] for name, c in seen.items()}


class Resolver:
    def __init__(self, ncaa_names):
        # .strip(): the API has names with stray spaces ("LSU New Orleans ")
        self.by_norm = {normalize(n): n.strip() for n in ncaa_names}
        self.missing: list[str] = []

    def __call__(self, sheet_name: str) -> str | None:
        key = normalize(sheet_name)
        # Only accept names the NCAA scoreboard actually uses, so a bad alias can't
        # create a phantom team. A team that hasn't played during the index window
        # shows up as unmatched: widen --index-days.
        hit = self.by_norm.get(key) or self.by_norm.get(normalize(ALIASES.get(key, "")))
        if not hit:
            self.missing.append(sheet_name)
        return hit


# ---------------------------------------------------------------- sheet parsing
def parse_conference_tiers(rows):
    """Yield (tier, sheet conference name, [team names]).

    Layout: a row with tier labels (merged across their group), the next row has the
    conference names, then team names below each conference until a blank row.
    Groups of conferences are separated by an empty column.
    """
    r = 0
    while r < len(rows):
        labels = {c: TIER_LABELS[v.lower()] for c, v in enumerate(rows[r]) if v.lower() in TIER_LABELS}
        if not labels:
            r += 1
            continue
        conf_row = rows[r + 1] if r + 1 < len(rows) else []
        runs, start = [], None  # contiguous runs of non-empty conference cells
        for c in range(len(conf_row) + 1):
            filled = c < len(conf_row) and conf_row[c]
            if filled and start is None:
                start = c
            if not filled and start is not None:
                runs.append((start, c - 1))
                start = None
        for a, b in runs:
            # a group's label sits somewhere over its span (merged cell)
            tier = next((t for c, t in labels.items() if a - 1 <= c <= b + 1), None)
            if tier is None:
                sys.exit(f"Conference Tiers: no tier label over columns {a}-{b} (row {r + 1})")
            for c in range(a, b + 1):
                teams = []
                rr = r + 2
                while rr < len(rows) and not any(v.lower() in TIER_LABELS for v in rows[rr]):
                    v = cell(rows, rr, c)
                    if v:
                        teams.append(v)
                    rr += 1
                yield tier, conf_row[c], teams
        r += 2


def parse_draft(rows):
    """Return [(manager first name, [teams in draft order])]."""
    header = rows[0]
    managers = [(c, v) for c, v in enumerate(header) if v]
    picks = {name: [] for _, name in managers}
    for row in rows[1:]:
        first = row[0] if row else ""
        if not re.fullmatch(r"\d+(\.0)?", first or ""):
            if any(row):
                break  # "DRAFT RULES" etc.
            continue
        for c, name in managers:
            if c < len(row) and row[c]:
                picks[name].append(row[c])
    return [(name, picks[name]) for _, name in managers]


def full_manager_names(sheets, season_prefix):
    """First name -> "First Last", read from the season's standings sheet if present."""
    out = {}
    for sheet_name, rows in sheets.items():
        if sheet_name.lower().startswith(season_prefix) and "standings" in sheet_name.lower():
            for row in rows:
                for v in row:
                    parts = v.split()
                    if len(parts) == 2 and all(p[:1].isupper() and p.isalpha() for p in parts):
                        out.setdefault(parts[0], v)
    return out


# ---------------------------------------------------------------- SQL output
def q(s: str | None) -> str:
    return "null" if s is None else "'" + s.replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("--season", required=True, help="season label, e.g. 2026-27")
    ap.add_argument("--start", required=True, help="season start date YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="season end date YYYY-MM-DD")
    ap.add_argument("--index-start", help="first scoreboard date used to learn NCAA names (default: --start)")
    ap.add_argument("--index-days", type=int, default=14)
    ap.add_argument("--ncaa-api", default=NCAA_API_BASE)
    args = ap.parse_args()

    sheets = read_workbook(args.workbook)
    y1, y2 = args.season.split("-")
    season_prefix = f"{y1}-{y1[:2]}{y2}"  # '2026-27' -> '2026-2027'
    draft_sheet = next((n for n in sheets if n.lower().startswith(season_prefix) and "draft" in n.lower()), None)
    if not draft_sheet:
        sys.exit(f"No '{season_prefix} DRAFT' sheet. Sheets: {', '.join(sheets)}")
    if "Conference Tiers" not in sheets:
        sys.exit("No 'Conference Tiers' sheet.")

    index_start = dt.date.fromisoformat(args.index_start or args.start)
    print(f"Learning NCAA team names from {args.index_days} days of scoreboards from {index_start}...", file=sys.stderr)
    ncaa = build_ncaa_index(index_start, args.index_days, args.ncaa_api.rstrip("/"))
    resolve = Resolver(ncaa)

    # Conference tiers: sheet conference -> API conferenceSeo by majority of its teams.
    conferences = []  # (tier, sheet conf, seo, [(sheet team, ncaa team)])
    for tier, conf, teams in parse_conference_tiers(sheets["Conference Tiers"]):
        resolved = [(t, resolve(t)) for t in teams]
        seos = collections.Counter(ncaa.get(n) for _, n in resolved if n and ncaa.get(n))
        seo = seos.most_common(1)[0][0] if seos else None
        conferences.append((tier, conf, seo, resolved))

    draft = parse_draft(sheets[draft_sheet])
    full_names = full_manager_names(sheets, season_prefix)
    roster = [(full_names.get(m, m), [(t, resolve(t)) for t in teams]) for m, teams in draft]

    # ---- report
    err = sys.stderr
    print("\nConference mapping (sheet -> NCAA API):", file=err)
    for tier, conf, seo, teams in conferences:
        others = {ncaa.get(n) for _, n in teams if n and ncaa.get(n) and ncaa.get(n) != seo}
        note = f"  (some teams show as {', '.join(sorted(others))})" if others else ""
        print(f"  {tier:<9} {conf:<14} -> {seo or '???'}  [{len(teams)} teams]{note}", file=err)
    print(f"\n{draft_sheet}: {len(roster)} managers, {sum(len(t) for _, t in roster)} picks", file=err)
    for m, teams in roster:
        print(f"  {m}: {', '.join(n or f'??{s}' for s, n in teams)}", file=err)

    problems = []
    if resolve.missing:
        problems.append("Unmatched team names (add to ALIASES): " + ", ".join(sorted(set(resolve.missing))))
    if any(seo is None for *_, seo, _ in conferences):
        problems.append("Conferences with no matched teams: " + ", ".join(c for _, c, s, _ in conferences if not s))
    dup = [s for s, n in collections.Counter(seo for _, _, seo, _ in conferences).items() if n > 1]
    if dup:
        problems.append("Two sheet conferences map to the same API conference: " + ", ".join(dup))
    drafted = [n for _, teams in roster for _, n in teams]
    dup_picks = [n for n, k in collections.Counter(n for n in drafted if n).items() if k > 1]
    if dup_picks:
        problems.append("Teams drafted twice: " + ", ".join(dup_picks))
    if problems:
        print("\nERRORS:\n  " + "\n  ".join(problems), file=err)
        sys.exit(1)

    # ---- SQL
    team_conf = {}
    for _, _, seo, teams in conferences:
        for _, n in teams:
            team_conf[n] = seo
    out = [f"-- Generated by scripts/import_league.py from {args.workbook.split('/')[-1]} "
           f"on {dt.datetime.now():%Y-%m-%d %H:%M}", "begin;", ""]
    out.append("-- Conference tiers (from the 'Conference Tiers' sheet)")
    out.append("insert into public.conference_tiers (conference_seo, tier) values")
    out.append(",\n".join(f"  ({q(seo)}, {q(tier)})" for tier, _, seo, _ in conferences))
    out.append("on conflict (conference_seo) do update set tier = excluded.tier;\n")

    out.append("-- Every D1 team listed on the sheet, with its conference")
    out.append("insert into public.teams (name, conference_seo) values")
    out.append(",\n".join(f"  ({q(n)}, {q(team_conf.get(n))})" for n in sorted(set(team_conf) | set(drafted))))
    out.append("on conflict (name) do update set conference_seo = coalesce(excluded.conference_seo, teams.conference_seo);\n")

    out.append(f"-- Season {args.season}")
    out.append(f"insert into public.seasons (label, start_date, end_date) values ({q(args.season)}, {q(args.start)}, {q(args.end)})")
    out.append("on conflict (label) do update set start_date = excluded.start_date, end_date = excluded.end_date;\n")

    out.append("-- Managers")
    out.append("insert into public.managers (name) values")
    out.append(",\n".join(f"  ({q(m)})" for m, _ in roster))
    out.append("on conflict (name) do nothing;\n")

    out.append(f"-- Rosters ({draft_sheet}). Teams no longer drafted are removed (with their points);")
    out.append("-- teams that stay keep their points, even if they changed managers.")
    values = ",\n".join(f"    ({q(n)}, {q(m)})" for m, teams in roster for _, n in teams)
    out.append(f"""with s as (select id from public.seasons where label = {q(args.season)}),
draft (team_name, manager_name) as (values
{values}
),
removed as (
  delete from public.rosters r using s
  where r.season_id = s.id and r.team_name not in (select team_name from draft)
)
insert into public.rosters (season_id, team_name, manager_id)
select s.id, d.team_name, m.id
from draft d cross join s join public.managers m on m.name = d.manager_name
on conflict (season_id, team_name) do update set manager_id = excluded.manager_id;
""")
    out.append("commit;")
    print("\n".join(out))
    print(f"\nOK: {len(conferences)} conferences, {len(team_conf)} teams, {len(drafted)} roster picks.", file=err)


if __name__ == "__main__":
    main()
