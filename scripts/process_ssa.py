"""
process_ssa.py
==============
Reads raw SSA yearly files (yob1880.txt … yob2024.txt) OR a pre-compiled
ssa_names_compiled.csv and writes:

  frontend/public/data/index.json          – sorted list of all names
  frontend/public/data/names/<NAME>.json   – per-name yearly data + scores

Run from the project root:
    python scripts/process_ssa.py --ssa-dir path/to/names/
    python scripts/process_ssa.py --compiled path/to/ssa_names_compiled.csv

The output folder defaults to frontend/public/data/ (relative to CWD).
Pass --out-dir to override.

Fixedness formula (from gender_fixedness_score_redesign.ipynb):
    p_smooth  = (F + α) / (F + M + 2α)           [Beta prior smoothing]
    signal    = 2 * |p_smooth - 0.5|
    conf      = n / (n + k)                        [confidence weight]
    fixedness = signal * conf
    ambiguity = 1 - fixedness

Default hyperparameters match the notebook: α=10, k=200.
"""

import argparse
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# ── Hyperparameters ────────────────────────────────────────────────────────────
ALPHA = 10.0    # Beta prior smoothing strength
K_CONF = 200.0  # Confidence saturation half-point
MIN_YEAR = 1880
MAX_YEAR = 2024
SSA_THRESHOLD = 5  # SSA suppresses counts below this; treat missing as 0


# ── Score helpers ──────────────────────────────────────────────────────────────

def smoothed_p(f: pd.Series, m: pd.Series) -> pd.Series:
    return (f + ALPHA) / (f + m + 2 * ALPHA)


def confidence(n: pd.Series) -> pd.Series:
    return n / (n + K_CONF)


def add_fixedness(df: pd.DataFrame) -> pd.DataFrame:
    """Add fixedness columns to a DataFrame with F and M columns."""
    out = df.copy()
    out["n"] = out["F"] + out["M"]
    out["p_female_smooth"] = smoothed_p(out["F"], out["M"])
    out["base_fixedness"] = 2.0 * (out["p_female_smooth"] - 0.5).abs()
    out["confidence"] = confidence(out["n"])
    out["fixedness"] = out["base_fixedness"] * out["confidence"]
    out["ambiguity"] = 1.0 - out["fixedness"]

    # Posterior SD of p_female (Beta distribution)
    a = out["F"] + ALPHA
    b = out["M"] + ALPHA
    out["posterior_sd"] = np.sqrt((a * b) / (((a + b) ** 2) * (a + b + 1)))
    out["fixedness_ci_width"] = 4.0 * out["posterior_sd"] * out["confidence"]

    return out


# ── Data loading ───────────────────────────────────────────────────────────────

def load_ssa_from_dir(ssa_dir: str) -> pd.DataFrame:
    """Compile yearly yobYYYY.txt files into one DataFrame."""
    files = sorted(glob.glob(os.path.join(ssa_dir, "yob*.txt")))
    if not files:
        sys.exit(f"ERROR: No yob*.txt files found in {ssa_dir!r}")
    chunks = []
    for path in files:
        year = int(Path(path).stem[3:7])
        if not (MIN_YEAR <= year <= MAX_YEAR):
            continue
        df = pd.read_csv(path, header=None, names=["name", "sex", "count"])
        df["year"] = year
        chunks.append(df)
    print(f"Loaded {len(chunks)} yearly files from {ssa_dir}")
    return pd.concat(chunks, ignore_index=True)


def load_ssa_from_csv(path: str) -> pd.DataFrame:
    print(f"Loading compiled CSV from {path}")
    return pd.read_csv(path)


def normalize(ssa: pd.DataFrame) -> pd.DataFrame:
    ssa = ssa.copy()
    ssa["name"] = ssa["name"].astype(str).str.strip().str.title()
    ssa["sex"] = ssa["sex"].astype(str).str.upper().str.strip()
    ssa = ssa[ssa["sex"].isin(["F", "M"])].copy()
    ssa["year"] = ssa["year"].astype(int)
    ssa = ssa[(ssa["year"] >= MIN_YEAR) & (ssa["year"] <= MAX_YEAR)]
    ssa["count"] = ssa["count"].astype(int)
    return ssa


# ── Per-name export ────────────────────────────────────────────────────────────

def build_name_record(name: str, name_df: pd.DataFrame) -> dict:
    """Build the full JSON record for one name."""
    # Pivot to wide (year × sex)
    wide = (
        name_df.pivot_table(index="year", columns="sex", values="count", fill_value=0)
        .reset_index()
    )
    wide.columns.name = None
    for col in ["F", "M"]:
        if col not in wide.columns:
            wide[col] = 0
    wide["F"] = wide["F"].astype(float)
    wide["M"] = wide["M"].astype(float)

    # Fill missing years with zeros so chart lines are continuous
    all_years = pd.DataFrame({"year": range(MIN_YEAR, MAX_YEAR + 1)})
    wide = all_years.merge(wide, on="year", how="left").fillna(0)
    wide["F"] = wide["F"].astype(int)
    wide["M"] = wide["M"].astype(int)

    wide = add_fixedness(wide)

    # All-time aggregated stats
    total_f = int(wide["F"].sum())
    total_m = int(wide["M"].sum())
    total_n = total_f + total_m
    alltime_fix = float(add_fixedness(
        pd.DataFrame([{"F": total_f, "M": total_m}])
    )["fixedness"].iloc[0])
    p_female_alltime = float(smoothed_p(
        pd.Series([total_f]), pd.Series([total_m])
    ).iloc[0])

    dominant = "F" if p_female_alltime >= 0.5 else "M"
    dominant_pct = round(max(p_female_alltime, 1 - p_female_alltime) * 100, 1)

    # Peak year
    peak_row = wide.loc[wide["n"].idxmax()]
    peak_year = int(peak_row["year"])
    peak_count = int(peak_row["n"])

    # Recent 5-year average (2020-2024)
    recent = wide[wide["year"] >= 2020]
    recent_avg = int(recent["n"].mean().round()) if len(recent) > 0 else 0

    # Temporal stability (std of p_female across decades with ≥20 births)
    wide["decade"] = (wide["year"] // 10) * 10
    decade_grp = (
        wide[wide["n"] >= 20]
        .groupby("decade")[["F", "M"]]
        .sum()
        .reset_index()
    )
    if len(decade_grp) >= 3:
        decade_p = smoothed_p(decade_grp["F"].astype(float), decade_grp["M"].astype(float))
        stability = float(1 / (1 + decade_p.std()))
    else:
        stability = None

    temporal_fixedness = (alltime_fix * stability) if stability is not None else alltime_fix

    # Yearly records — only include years with any births for file size
    yearly = []
    for _, row in wide.iterrows():
        yr = int(row["year"])
        f = int(row["F"])
        m = int(row["M"])
        n = f + m
        fix = round(float(row["fixedness"]), 4)
        yearly.append({
            "year": yr,
            "F": f,
            "M": m,
            "total": n,
            "fixedness": fix,
            "p_female_smooth": round(float(row["p_female_smooth"]), 4),
            "confidence": round(float(row["confidence"]), 4),
        })

    return {
        "name": name,
        "alltime": {
            "total_F": total_f,
            "total_M": total_m,
            "total": total_n,
            "fixedness": round(alltime_fix, 4),
            "temporal_fixedness": round(temporal_fixedness, 4),
            "stability": round(stability, 4) if stability is not None else None,
            "p_female_smooth": round(p_female_alltime, 4),
            "dominant_gender": dominant,
            "dominant_pct": dominant_pct,
            "peak_year": peak_year,
            "peak_count": peak_count,
            "recent_avg_per_year": recent_avg,
        },
        "yearly": yearly,
    }


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Process SSA data for Baby Name Explorer")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--ssa-dir", help="Directory containing yobYYYY.txt files")
    group.add_argument("--compiled", help="Path to pre-compiled ssa_names_compiled.csv")
    parser.add_argument(
        "--out-dir",
        default="frontend/public/data",
        help="Output directory (default: frontend/public/data)",
    )
    parser.add_argument(
        "--min-births",
        type=int,
        default=50,
        help="Minimum all-time births to include a name (default: 50)",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    names_dir = out_dir / "names"
    names_dir.mkdir(parents=True, exist_ok=True)

    # Load
    if args.compiled:
        raw = load_ssa_from_csv(args.compiled)
    else:
        raw = load_ssa_from_dir(args.ssa_dir)

    ssa = normalize(raw)
    print(f"Shape after normalization: {ssa.shape}")
    print(f"Year range: {ssa['year'].min()} – {ssa['year'].max()}")

    # All-time totals for threshold filtering
    alltime = ssa.groupby("name")["count"].sum().reset_index(name="total")
    kept_names = alltime[alltime["total"] >= args.min_births]["name"].tolist()
    print(f"Names with ≥{args.min_births} all-time births: {len(kept_names):,} / {alltime.shape[0]:,}")

    ssa_filtered = ssa[ssa["name"].isin(kept_names)].copy()

    # Build index
    index_entries = []

    total_names = len(kept_names)
    for i, name in enumerate(sorted(kept_names), 1):
        if i % 1000 == 0:
            print(f"  Processing {i:,}/{total_names:,} …")

        name_df = ssa_filtered[ssa_filtered["name"] == name]
        record = build_name_record(name, name_df)

        # Write per-name JSON
        out_path = names_dir / f"{name}.json"
        with open(out_path, "w") as f:
            json.dump(record, f, separators=(",", ":"))

        # Index entry (lightweight)
        at = record["alltime"]
        index_entries.append({
            "name": name,
            "total": at["total"],
            "fixedness": at["fixedness"],
            "temporal_fixedness": at["temporal_fixedness"],
            "dominant_gender": at["dominant_gender"],
            "dominant_pct": at["dominant_pct"],
            "peak_year": at["peak_year"],
            "recent_avg": at["recent_avg_per_year"],
        })

    # Write index
    index_entries.sort(key=lambda x: x["name"])
    index_path = out_dir / "index.json"
    with open(index_path, "w") as f:
        json.dump(index_entries, f, separators=(",", ":"))

    print(f"\nDone.")
    print(f"  Name files : {names_dir}/")
    print(f"  Index      : {index_path}")
    print(f"  Total names: {len(index_entries):,}")


if __name__ == "__main__":
    main()
