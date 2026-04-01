# data/

This directory is populated by `scripts/process_ssa.py`.

Expected structure after running the script:

```
data/
  index.json          # lightweight list of all names (name, total, fixedness, etc.)
  names/
    Aaron.json        # per-name yearly data + fixedness scores
    Abigail.json
    ...               # ~51k files for names with ≥50 all-time births
```

## How to generate

```bash
# From the project root:
pip install pandas numpy

# Option A — raw SSA yearly files (yob1880.txt … yob2024.txt):
python scripts/process_ssa.py --ssa-dir path/to/names/

# Option B — pre-compiled CSV (ssa_names_compiled.csv):
python scripts/process_ssa.py --compiled path/to/ssa_names_compiled.csv

# Optional: change minimum birth threshold (default 50)
python scripts/process_ssa.py --compiled ... --min-births 100

# Optional: write output elsewhere
python scripts/process_ssa.py --compiled ... --out-dir /some/other/dir
```

## File sizes

~51k JSON files. Typical size per name:
- Common names (Jordan, Sophia): ~8–14 KB
- Rarer names: ~2–4 KB
- Total directory: roughly 150–250 MB uncompressed

GitHub Pages serves these as static files. No server needed.
