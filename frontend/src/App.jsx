import { useState, useEffect, useRef, useCallback } from "react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import "./App.css";

// ── Config ─────────────────────────────────────────────────────────────────────
// When hosted on GitHub Pages, DATA_BASE_URL should point to your repo's
// GitHub Pages URL, e.g. "https://yourname.github.io/baby-name-explorer/data"
// During local dev with `npm start`, set REACT_APP_DATA_URL in .env.local
const DATA_BASE_URL = process.env.REACT_APP_DATA_URL || "./data";

// ── Fixedness helpers (mirror of Python script) ────────────────────────────────
const ALPHA = 10;
const K_CONF = 200;

function getFixednessLabel(score) {
  if (score >= 0.85) return { label: "Strongly gendered", tier: "high" };
  if (score >= 0.65) return { label: "Mostly gendered", tier: "med-high" };
  if (score >= 0.40) return { label: "Moderately gendered", tier: "mid" };
  if (score >= 0.20) return { label: "Somewhat neutral", tier: "med-low" };
  return { label: "Truly gender-neutral", tier: "low" };
}

function fixednessColor(score) {
  // Interpolate between neutral purple → amber → forest green
  if (score < 0.3) return "#9b6bb5";
  if (score < 0.5) return "#c4963a";
  if (score < 0.7) return "#7c9e8f";
  return "#3d6b5a";
}

// ── Tooltip components ─────────────────────────────────────────────────────────
const PopTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  const f = payload.find((p) => p.dataKey === "F")?.value ?? 0;
  const m = payload.find((p) => p.dataKey === "M")?.value ?? 0;
  const total = f + m;
  return (
    <div className="custom-tooltip">
      <p className="tt-year">{label}</p>
      <div className="tt-row">
        <span className="tt-dot tt-dot--f" />
        <span>Female</span>
        <span className="tt-val">{f.toLocaleString()}</span>
      </div>
      <div className="tt-row">
        <span className="tt-dot tt-dot--m" />
        <span>Male</span>
        <span className="tt-val">{m.toLocaleString()}</span>
      </div>
      <div className="tt-row tt-total">
        <span>Total</span>
        <span className="tt-val">{total.toLocaleString()}</span>
      </div>
    </div>
  );
};

const FixednessTooltip = ({ active, payload, label }) => {
  if (!active || !payload || !payload.length) return null;
  const fix = payload[0]?.value ?? 0;
  const pf = payload.find((p) => p.dataKey === "pf_pct")?.value ?? null;
  return (
    <div className="custom-tooltip">
      <p className="tt-year">{label}</p>
      <div className="tt-row">
        <span>Fixedness</span>
        <span className="tt-val">{(fix * 100).toFixed(1)}/100</span>
      </div>
      {pf !== null && (
        <div className="tt-row">
          <span>% female</span>
          <span className="tt-val">{pf.toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
};

// ── Enrichment via Claude API ──────────────────────────────────────────────────
async function fetchEnrichment(name) {
  try {
    const prompt = `You are a concise name-etymology API. Return ONLY a JSON object, no markdown, no explanation.

For the baby name "${name}", return exactly:
{
  "meaning": "<1–2 sentence meaning and linguistic root>",
  "origin": "<culture/language, e.g. Latin, Hebrew, Old English, Sanskrit>",
  "notableVariants": ["<variant1>", "<variant2>"],
  "popularityNote": "<1 sentence on current usage context>"
}`;
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await resp.json();
    const text = data.content
      .map((c) => c.text || "")
      .join("")
      .replace(/```json|```/g, "")
      .trim();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [index, setIndex] = useState(null);
  const [indexError, setIndexError] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [nameData, setNameData] = useState(null);
  const [enrich, setEnrich] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [yearStart, setYearStart] = useState(1960);
  const [yearEnd, setYearEnd] = useState(2024);
  const inputRef = useRef(null);

  // Load name index on mount
  useEffect(() => {
    fetch(`${DATA_BASE_URL}/index.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setIndex)
      .catch(() => setIndexError(true));
  }, []);

  // Autocomplete from index
  useEffect(() => {
    if (!index || query.length < 2) {
      setSuggestions([]);
      return;
    }
    const q = query.toLowerCase();
    const hits = index
      .filter((e) => e.name.toLowerCase().startsWith(q))
      .slice(0, 8);
    setSuggestions(hits);
  }, [query, index]);

  const lookupName = useCallback(
    async (nameArg) => {
      const name =
        (nameArg || query).trim().charAt(0).toUpperCase() +
        (nameArg || query).trim().slice(1).toLowerCase();
      if (!name) return;

      setShowSuggestions(false);
      setLoading(true);
      setError(null);
      setNameData(null);
      setEnrich(null);

      try {
        const [dataResp, enrichResult] = await Promise.all([
          fetch(`${DATA_BASE_URL}/names/${name}.json`),
          fetchEnrichment(name),
        ]);

        if (!dataResp.ok) {
          if (dataResp.status === 404) {
            throw new Error(
              `"${name}" not found. It may have fewer than 50 all-time SSA births, or check spelling.`
            );
          }
          throw new Error(`HTTP ${dataResp.status}`);
        }

        const data = await dataResp.json();
        setNameData(data);
        setEnrich(enrichResult);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    },
    [query]
  );

  // Filter yearly data to selected range
  const filteredYearly = nameData
    ? nameData.yearly.filter(
        (r) => r.year >= yearStart && r.year <= yearEnd
      )
    : [];

  const chartData = filteredYearly.map((r) => ({
    year: r.year,
    F: r.F,
    M: r.M,
    total: r.total,
    fixedness: r.fixedness,
    pf_pct: r.p_female_smooth * 100,
  }));

  // Aggregate stats for the selected window
  const windowStats = (() => {
    if (!filteredYearly.length) return null;
    const totalF = filteredYearly.reduce((s, r) => s + r.F, 0);
    const totalM = filteredYearly.reduce((s, r) => s + r.M, 0);
    const n = totalF + totalM;
    const pf = n > 0 ? totalF / n : 0;
    // Recompute fixedness for window using notebook formula
    const pSmooth = (totalF + ALPHA) / (n + 2 * ALPHA);
    const signal = 2 * Math.abs(pSmooth - 0.5);
    const conf = n / (n + K_CONF);
    const fix = signal * conf;

    const peak = filteredYearly.reduce(
      (best, r) => (r.total > best.val ? { year: r.year, val: r.total } : best),
      { year: 0, val: 0 }
    );

    const recent = filteredYearly.filter((r) => r.year >= 2020);
    const recentAvg = recent.length
      ? Math.round(recent.reduce((s, r) => s + r.total, 0) / recent.length)
      : null;

    return { totalF, totalM, n, pf, fix, peak, recentAvg };
  })();

  const fixInfo = windowStats ? getFixednessLabel(windowStats.fix) : null;
  const fillCol = windowStats ? fixednessColor(windowStats.fix) : "#999";

  return (
    <div className="app">
      {/* ── Hero ── */}
      <header className="hero">
        <div className="hero-inner">
          <h1>Baby Name Explorer</h1>
          <p className="hero-sub">
            Explore the popularity and gender fixedness of any American baby
            name from 1880 to 2024, using official SSA birth records.
          </p>

          <div className="search-wrap" ref={inputRef}>
            <div className="search-bar">
              <input
                type="text"
                className="search-input"
                placeholder="Try Jordan, Sophia, Riley, Avery…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowSuggestions(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") lookupName();
                  if (e.key === "Escape") setShowSuggestions(false);
                }}
                onFocus={() => setShowSuggestions(true)}
                autoComplete="off"
              />
              <button
                className="search-btn"
                onClick={() => lookupName()}
                disabled={loading}
              >
                {loading ? "Loading…" : "Explore"}
              </button>
            </div>

            {showSuggestions && suggestions.length > 0 && (
              <ul className="suggestions">
                {suggestions.map((s) => (
                  <li
                    key={s.name}
                    className="suggestion-item"
                    onMouseDown={() => {
                      setQuery(s.name);
                      lookupName(s.name);
                    }}
                  >
                    <span className="sug-name">{s.name}</span>
                    <span className="sug-meta">
                      {s.dominant_gender === "F" ? "♀" : "♂"}{" "}
                      {s.dominant_pct}% · {s.total.toLocaleString()} births
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="year-row">
            <label>From</label>
            <input
              type="number"
              className="year-input"
              value={yearStart}
              min={1880}
              max={yearEnd - 1}
              onChange={(e) => setYearStart(parseInt(e.target.value) || 1880)}
            />
            <span className="year-dash">to</span>
            <input
              type="number"
              className="year-input"
              value={yearEnd}
              min={yearStart + 1}
              max={2024}
              onChange={(e) => setYearEnd(parseInt(e.target.value) || 2024)}
            />
          </div>

          {indexError && (
            <p className="index-warn">
              ⚠ Could not load name index. Run{" "}
              <code>python scripts/process_ssa.py</code> and place the output
              in <code>frontend/public/data/</code>.
            </p>
          )}
        </div>
      </header>

      {/* ── Results ── */}
      <main className="main">
        {loading && (
          <div className="state-msg">
            <span className="spinner" />
            Fetching data…
          </div>
        )}

        {error && !loading && (
          <div className="error-card">{error}</div>
        )}

        {!loading && !error && nameData && windowStats && (
          <>
            {/* Name header */}
            <div className="name-header">
              <h2 className="name-title">{nameData.name}</h2>
              {enrich && (
                <span className="badge badge--origin">{enrich.origin}</span>
              )}
              <span
                className="badge badge--fix"
                style={{ background: fillCol + "22", color: fillCol, borderColor: fillCol + "44" }}
              >
                {fixInfo.label}
              </span>
            </div>

            {/* Meaning card */}
            {enrich && (
              <div className="card meaning-card">
                <div className="card-label">Name meaning</div>
                <p className="meaning-text">{enrich.meaning}</p>
                {enrich.notableVariants?.length > 0 && (
                  <p className="variants">
                    Also spelled:{" "}
                    {enrich.notableVariants.join(", ")}
                  </p>
                )}
              </div>
            )}

            {/* Stats grid */}
            <div className="stats-grid">
              <StatCard
                label={`Total births`}
                sub={`${yearStart}–${yearEnd}`}
                value={windowStats.n.toLocaleString()}
              />
              <StatCard
                label="Peak year"
                sub={`${windowStats.peak.val.toLocaleString()} births`}
                value={windowStats.peak.year}
              />
              {windowStats.recentAvg !== null && (
                <StatCard
                  label="Avg births/yr"
                  sub="2020–2024"
                  value={windowStats.recentAvg.toLocaleString()}
                />
              )}
              <StatCard
                label="Dominant gender"
                sub={`${windowStats.dominant_pct ?? Math.round(Math.max(windowStats.pf, 1 - windowStats.pf) * 100)}% of births`}
                value={windowStats.pf >= 0.5 ? "Female" : "Male"}
              />
            </div>

            {/* Fixedness meter */}
            <div className="card fixedness-card">
              <div className="card-label">
                Gender fixedness — {yearStart}–{yearEnd}
              </div>
              <div className="meter-track">
                <div
                  className="meter-fill"
                  style={{
                    width: `${(windowStats.fix * 100).toFixed(1)}%`,
                    background: fillCol,
                  }}
                />
              </div>
              <div className="meter-axis">
                <span>Gender-neutral</span>
                <span className="meter-score" style={{ color: fillCol }}>
                  {(windowStats.fix * 100).toFixed(1)} / 100 —{" "}
                  {fixInfo.label}
                </span>
                <span>Strongly fixed</span>
              </div>
              <div className="gender-split">
                <div className="split-item">
                  <span className="dot dot--f" />
                  <span>
                    {Math.round(windowStats.pf * 100)}% female (
                    {windowStats.totalF.toLocaleString()} births)
                  </span>
                </div>
                <div className="split-item">
                  <span className="dot dot--m" />
                  <span>
                    {Math.round((1 - windowStats.pf) * 100)}% male (
                    {windowStats.totalM.toLocaleString()} births)
                  </span>
                </div>
              </div>
              <p className="fixedness-note">
                Bayesian-smoothed (α=10, k=200). Low birth counts correctly
                pull fixedness toward 0 — a name with 10 births isn't truly
                certain even if all 10 were female.
              </p>
            </div>

            {/* Popularity chart */}
            <div className="card chart-card">
              <h3 className="chart-title">Births per year</h3>
              <p className="chart-sub">
                Annual SSA births by sex, {yearStart}–{yearEnd}. Years with
                fewer than 5 births of one sex are shown as 0 (SSA
                suppression threshold).
              </p>
              <div className="legend">
                <LegendItem color="#c47da8" label="Female" />
                <LegendItem color="#5b8db8" label="Male" />
                <LegendItem color="#8a6bb5" label="Total" dashed />
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart
                  data={chartData}
                  margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0ebe4" />
                  <XAxis
                    dataKey="year"
                    tick={{ fontSize: 11, fill: "#999" }}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "#999" }}
                    tickLine={false}
                    tickFormatter={(v) =>
                      v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v
                    }
                    width={40}
                  />
                  <Tooltip content={<PopTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="F"
                    fill="#c47da822"
                    stroke="#c47da8"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    name="Female"
                  />
                  <Area
                    type="monotone"
                    dataKey="M"
                    fill="#5b8db822"
                    stroke="#5b8db8"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    name="Male"
                  />
                  <Line
                    type="monotone"
                    dataKey="total"
                    stroke="#8a6bb5"
                    strokeWidth={1.5}
                    strokeDasharray="5 3"
                    dot={false}
                    activeDot={{ r: 4 }}
                    name="Total"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Fixedness over time chart */}
            <div className="card chart-card">
              <h3 className="chart-title">Gender fixedness over time</h3>
              <p className="chart-sub">
                Confidence-weighted fixedness per year (0 = fully neutral, 1 =
                perfectly fixed). Low birth counts drag the score down — this
                is by design. Hover for the % female each year.
              </p>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart
                  data={chartData}
                  margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0ebe4" />
                  <XAxis
                    dataKey="year"
                    tick={{ fontSize: 11, fill: "#999" }}
                    tickLine={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[0, 1]}
                    tick={{ fontSize: 11, fill: "#999" }}
                    tickLine={false}
                    tickFormatter={(v) => v.toFixed(1)}
                    width={32}
                  />
                  <Tooltip content={<FixednessTooltip />} />
                  <ReferenceLine y={0.85} stroke="#3d6b5a" strokeDasharray="4 3" strokeOpacity={0.4} label={{ value: "Strongly fixed", position: "insideTopRight", fontSize: 10, fill: "#3d6b5a" }} />
                  <ReferenceLine y={0.4} stroke="#c4963a" strokeDasharray="4 3" strokeOpacity={0.4} label={{ value: "Moderately fixed", position: "insideTopRight", fontSize: 10, fill: "#c4963a" }} />
                  <Area
                    type="monotone"
                    dataKey="fixedness"
                    fill={fillCol + "22"}
                    stroke={fillCol}
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 4 }}
                    name="Fixedness"
                  />
                  <Line
                    type="monotone"
                    dataKey="pf_pct"
                    stroke="#c47da880"
                    strokeWidth={1}
                    dot={false}
                    yAxisId={1}
                    hide
                    name="pf_pct"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* All-time summary from precomputed data */}
            <div className="card">
              <div class="card-label">All-time summary (1880–2024)</div>
              <div className="alltime-grid">
                <AllTimeRow
                  label="All-time fixedness"
                  value={(nameData.alltime.fixedness * 100).toFixed(1) + " / 100"}
                />
                <AllTimeRow
                  label="Temporal fixedness"
                  value={
                    nameData.alltime.temporal_fixedness !== null
                      ? (nameData.alltime.temporal_fixedness * 100).toFixed(1) + " / 100"
                      : "—"
                  }
                  note="Penalizes names that drift across decades"
                />
                <AllTimeRow
                  label="Decade stability"
                  value={
                    nameData.alltime.stability !== null
                      ? (nameData.alltime.stability * 100).toFixed(1) + "%"
                      : "—"
                  }
                  note="1 = consistent gender association across all decades"
                />
                <AllTimeRow
                  label="All-time total births"
                  value={nameData.alltime.total.toLocaleString()}
                />
                <AllTimeRow
                  label="Female births"
                  value={nameData.alltime.total_F.toLocaleString()}
                />
                <AllTimeRow
                  label="Male births"
                  value={nameData.alltime.total_M.toLocaleString()}
                />
              </div>
            </div>

            {enrich?.popularityNote && (
              <div className="card meaning-card">
                <div className="card-label">Current usage context</div>
                <p className="meaning-text">{enrich.popularityNote}</p>
              </div>
            )}

            <p className="footnote">
              Data: US Social Security Administration baby names, 1880–2024.
              Fixedness score: Bayesian-smoothed Beta prior (α=10, k=200),
              confidence-weighted (k=200). Temporal fixedness applies a
              cross-decade stability penalty. SSA suppresses counts &lt; 5 per
              sex per year.
            </p>
          </>
        )}

        {!loading && !error && !nameData && (
          <div className="empty-state">
            <div className="empty-icon">◎</div>
            <p>Enter a name above to explore its history</p>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, sub, value }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function LegendItem({ color, label, dashed }) {
  return (
    <span className="legend-item">
      <span
        className="legend-swatch"
        style={{
          background: dashed ? "transparent" : color,
          border: dashed ? `1.5px dashed ${color}` : "none",
        }}
      />
      {label}
    </span>
  );
}

function AllTimeRow({ label, value, note }) {
  return (
    <div className="alltime-row">
      <div className="alltime-label">
        {label}
        {note && <span className="alltime-note"> — {note}</span>}
      </div>
      <div className="alltime-value">{value}</div>
    </div>
  );
}
