/**
 * Frame rendering for the autonomous video.
 *
 * Every frame is a 1920x1080 PNG produced by Playwright against the machine's installed
 * Chrome. Two sources feed it: captured stdout from the real verifier commands, and live
 * screenshots of the running Cockpit. Both are composited into the same chrome so the
 * finished video reads as one piece rather than a pile of screen grabs.
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { repoRoot } from "./demo-script.mjs";

export const WIDTH = 1920;
export const HEIGHT = 1080;

const THEME = {
  bg: "#0b0f16",
  panel: "#0f1620",
  border: "#1f2b3a",
  text: "#dbe6f2",
  dim: "#7c8ea4",
  accent: "#4aa3ff",
  good: "#3fb950",
  warn: "#d29922",
  bad: "#f85149"
};

/** Shared page chrome. Content is injected as `body`; everything else stays constant. */
function shell(inner, { title, index, total, progress }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body {
      background: ${THEME.bg};
      color: ${THEME.text};
      font-family: "Segoe UI", system-ui, sans-serif;
      display: flex; flex-direction: column;
    }
    .topbar {
      height: 84px; flex: 0 0 84px; display: flex; align-items: center; gap: 20px;
      padding: 0 48px; border-bottom: 1px solid ${THEME.border};
      background: linear-gradient(180deg, #111a26 0%, ${THEME.bg} 100%);
    }
    .mark {
      font-size: 26px; font-weight: 700; letter-spacing: 0.14em;
      color: ${THEME.text}; text-transform: uppercase;
    }
    .mark span { color: ${THEME.accent}; }
    .beat-title { font-size: 26px; font-weight: 600; color: ${THEME.text}; }
    .beat-num {
      margin-left: auto; font-size: 18px; color: ${THEME.dim};
      font-variant-numeric: tabular-nums; letter-spacing: 0.08em;
    }
    .stage { flex: 1 1 auto; padding: 40px 48px; display: flex; min-height: 0; }
    .progress { height: 4px; flex: 0 0 4px; background: #101822; }
    .progress > div { height: 100%; background: ${THEME.accent}; width: ${(progress * 100).toFixed(2)}%; }
    .term {
      flex: 1 1 auto; background: ${THEME.panel}; border: 1px solid ${THEME.border};
      border-radius: 12px; padding: 28px 32px; display: flex; flex-direction: column;
      min-height: 0; box-shadow: 0 24px 60px rgba(0,0,0,0.45);
    }
    .term-bar {
      display: flex; align-items: center; gap: 10px; padding-bottom: 18px;
      border-bottom: 1px solid ${THEME.border}; margin-bottom: 18px;
    }
    .dot { width: 12px; height: 12px; border-radius: 50%; }
    .term-label { margin-left: 10px; font-size: 16px; color: ${THEME.dim}; letter-spacing: 0.06em; }
    pre {
      font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
      font-size: 21px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
      color: ${THEME.text}; flex: 1 1 auto; overflow: hidden;
    }
    .ok { color: ${THEME.good}; } .warn { color: ${THEME.warn}; } .bad { color: ${THEME.bad}; }
    .dimmed { color: ${THEME.dim}; } .cmd { color: ${THEME.accent}; }
    .shot { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; }
    .shot img {
      max-width: 100%; max-height: 100%; border-radius: 12px;
      border: 1px solid ${THEME.border}; box-shadow: 0 24px 60px rgba(0,0,0,0.5);
    }
    .card { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; gap: 28px; }
    .card h1 { font-size: 82px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.06; }
    .card h2 { font-size: 40px; font-weight: 600; color: ${THEME.accent}; }
    .card p { font-size: 32px; color: ${THEME.dim}; max-width: 1500px; line-height: 1.45; }
    .pills { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; }
    .pill {
      border: 1px solid ${THEME.border}; background: ${THEME.panel}; border-radius: 999px;
      padding: 14px 28px; font-size: 26px; color: ${THEME.text};
    }
  </style></head><body>
    <div class="topbar">
      <div class="mark">Be<span>l</span>ay</div>
      <div class="beat-title">${escapeHtml(title ?? "")}</div>
      <div class="beat-num">${index != null ? `BEAT ${index} / ${total}` : ""}</div>
    </div>
    <div class="stage">${inner}</div>
    <div class="progress"><div></div></div>
  </body></html>`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Colourises a captured transcript the way the source terminal would have. */
function colourise(line) {
  const safe = escapeHtml(line);
  if (/^\s*\$/u.test(line)) return `<span class="cmd">${safe}</span>`;
  if (/\b(WON|ok|passed|clean|succeeded|exactly one winner)\b/u.test(line) || line.includes("✓")) {
    return `<span class="ok">${safe}</span>`;
  }
  if (/\b(REFUSED|PENDING|warn|indeterminate|stale|blocked|rejected)\b/u.test(line)) {
    return `<span class="warn">${safe}</span>`;
  }
  if (/\b(FAIL|failed|error|UNEXPECTED)\b/u.test(line)) return `<span class="bad">${safe}</span>`;
  if (/^\s{2,}/u.test(line) || /correlation|advisory/u.test(line)) {
    return `<span class="dimmed">${safe}</span>`;
  }
  return safe;
}

export async function createRenderer(buildDir) {
  const framesRoot = join(buildDir, "frames");
  mkdirSync(framesRoot, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  let cockpit;

  async function shoot(html, path) {
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path, type: "png" });
    return path;
  }

  function beatDir(slug) {
    const dir = join(framesRoot, slug);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  return {
    /**
     * Reveals a captured transcript a chunk at a time. The frame count is capped so a
     * 400-line test log does not turn into 400 screenshots.
     */
    async terminalFrames({ slug, title, index, total, progress, label, lines, maxFrames = 26 }) {
      const dir = beatDir(slug);
      const visible = lines.slice(-46);
      const steps = Math.min(maxFrames, Math.max(1, visible.length));
      const paths = [];
      for (let step = 1; step <= steps; step += 1) {
        const upto = Math.ceil((visible.length * step) / steps);
        const body = visible.slice(0, upto).map(colourise).join("\n");
        const inner = `<div class="term">
            <div class="term-bar">
              <div class="dot" style="background:#f85149"></div>
              <div class="dot" style="background:#d29922"></div>
              <div class="dot" style="background:#3fb950"></div>
              <div class="term-label">${escapeHtml(label ?? "belay")}</div>
            </div><pre>${body}</pre></div>`;
        paths.push(
          await shoot(shell(inner, { title, index, total, progress }), join(dir, `f${String(step).padStart(3, "0")}.png`))
        );
      }
      return paths;
    },

    /** Frames a still (a cockpit capture or the architecture diagram) inside the chrome. */
    async imageFrame({ slug, name, title, index, total, progress, imagePath }) {
      const dir = beatDir(slug);
      const base64 = readFileSync(imagePath).toString("base64");
      const inner = `<div class="shot"><img src="data:image/png;base64,${base64}"></div>`;
      return shoot(shell(inner, { title, index, total, progress }), join(dir, `${name}.png`));
    },

    /** A text card, for the opening problem statement and the closing claim. */
    async cardFrame({ slug, name, title, index, total, progress, heading, sub, body, pills = [] }) {
      const dir = beatDir(slug);
      const inner = `<div class="card">
          ${sub ? `<h2>${escapeHtml(sub)}</h2>` : ""}
          ${heading ? `<h1>${escapeHtml(heading)}</h1>` : ""}
          ${body ? `<p>${escapeHtml(body)}</p>` : ""}
          ${pills.length > 0 ? `<div class="pills">${pills.map((p) => `<div class="pill">${escapeHtml(p)}</div>`).join("")}</div>` : ""}
        </div>`;
      return shoot(shell(inner, { title, index, total, progress }), join(dir, `${name}.png`));
    },

    /** Opens the live Cockpit once and reuses it for every screenshot that needs it. */
    async cockpitPage(origin) {
      if (!cockpit) {
        cockpit = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
        await cockpit.goto(origin, { waitUntil: "networkidle", timeout: 30000 });
      }
      return cockpit;
    },

    /** Captures the running Cockpit exactly as it is at this moment. */
    async captureCockpit(origin, outPath, { settleMs = 900 } = {}) {
      const target = await this.cockpitPage(origin);
      await target.waitForTimeout(settleMs);
      await target.screenshot({ path: outPath, type: "png" });
      return outPath;
    },

    async close() {
      await browser.close();
    }
  };
}

/** The architecture diagram shipped with the repo, used by the closing beat. */
export const architectureDiagram = join(repoRoot, "docs", "assets", "belay-architecture.png");
export const hasArchitectureDiagram = () => existsSync(architectureDiagram);
