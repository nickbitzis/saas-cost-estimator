import {
  ARCHITECTURES, ARCH_LABELS, DEFAULT_INPUTS, compareAll, crossover, decodeInputs,
  encodeInputs, fmtUsd, scalingCurve,
} from "./cost.js";

const form = document.getElementById("form");
const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";

let inputs = decodeInputs(location.hash);
let selected = null;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function fillForm() {
  for (const field of form.elements) {
    if (!field.name) continue;
    const v = inputs[field.name];
    if (field.type === "checkbox") field.checked = Boolean(v);
    else if (field.dataset.log) field.value = Math.log10(v);
    else field.value = v;
  }
}

function readField(field) {
  if (field.type === "checkbox") return field.checked;
  if (field.dataset.log) return roundUsers(10 ** Number(field.value));
  const n = Number(field.value);
  return Number.isFinite(n) ? n : DEFAULT_INPUTS[field.name];
}

function roundUsers(n) {
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / mag) * mag;
}

function update() {
  document.querySelector('output[data-for="monthlyActiveUsers"]').textContent = inputs.monthlyActiveUsers.toLocaleString("en-US");
  const { results, cheapest } = compareAll(inputs);
  if (!selected) selected = cheapest;

  $("cards").replaceChildren(
    ...results.map((r) =>
      el("button", {
        type: "button",
        class: `card${r.arch === cheapest ? " best" : ""}${r.arch === selected ? " selected" : ""}`,
        onclick: () => { selected = r.arch; update(); },
      }, [
        el("span", { class: "card-label" }, [el("i", { class: `swatch s-${r.arch}` }), ARCH_LABELS[r.arch]]),
        el("span", { class: "card-total", text: fmtUsd(r.total) }),
        el("span", { class: "card-sub", text: `${fmtUsd(r.perUser * 1000)} per 1,000 users` }),
        r.arch === cheapest ? el("span", { class: "badge", text: "Lowest" }) : "",
      ]),
    ),
  );

  const warnings = [...new Set(results.flatMap((r) => r.warnings))];
  $("warnings").replaceChildren(...warnings.map((w) => el("li", { text: w })));

  const chosen = results.find((r) => r.arch === selected);
  $("tabs").replaceChildren(
    ...ARCHITECTURES.map((a) =>
      el("button", { type: "button", role: "tab", "aria-selected": String(a === selected), class: "tab", text: ARCH_LABELS[a],
        onclick: () => { selected = a; update(); } }),
    ),
  );
  $("items").replaceChildren(
    ...chosen.lines.map((l) => el("tr", {}, [
      el("td", { text: l.item }), el("td", { class: "muted", text: l.detail }), el("td", { class: "num", text: fmtUsd(l.cost) }),
    ])),
  );
  $("items-total").textContent = fmtUsd(chosen.total);

  drawChart();
  history.replaceState(null, "", `#${encodeInputs(inputs)}`);
}

function drawChart() {
  const curves = scalingCurve(inputs);
  const chart = $("chart");
  const W = 640, H = 310, m = { l: 64, r: 16, t: 12, b: 48 };
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const xs = curves[0].points.map((p) => p.mau);
  const totals = curves.flatMap((c) => c.points.map((p) => Math.max(1, p.total)));
  // Both axes are log scale: costs span two orders of magnitude, and the
  // crossover points are the story.
  const yLo = Math.log10(niceFloor(Math.min(...totals)));
  const yHi = Math.log10(niceCeil(Math.max(...totals)));
  const x = (mau) => m.l + ((Math.log10(mau) - Math.log10(xs[0])) / (Math.log10(xs.at(-1)) - Math.log10(xs[0]))) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((Math.log10(Math.max(1, v)) - yLo) / (yHi - yLo)) * (H - m.t - m.b);

  const nodes = [];
  for (const v of logTicks(10 ** yLo, 10 ** yHi)) {
    nodes.push(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }));
    nodes.push(svg("text", { x: m.l - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, `$${compact(v)}`));
  }
  for (const t of [1e3, 1e4, 1e5, 1e6]) {
    nodes.push(svg("text", { x: x(t), y: H - m.b + 18, class: "tick", "text-anchor": "middle" }, compact(t)));
  }
  nodes.push(svg("text", { x: (m.l + W - m.r) / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, "Monthly active users. Both axes use a log scale."));

  const cur = inputs.monthlyActiveUsers;
  if (cur >= xs[0] && cur <= xs.at(-1)) {
    nodes.push(svg("line", { x1: x(cur), x2: x(cur), y1: m.t, y2: H - m.b, class: "marker" }));
  }

  for (const c of curves) {
    const d = c.points.map((p, i) => `${i ? "L" : "M"}${x(p.mau).toFixed(1)},${y(p.total).toFixed(1)}`).join("");
    nodes.push(svg("path", { d, class: `line s-${c.arch}` }));
  }

  const hover = svg("g", { class: "hover", visibility: "hidden" });
  const hoverLine = svg("line", { y1: m.t, y2: H - m.b, class: "crosshair" });
  hover.append(hoverLine, ...curves.map((c) => svg("circle", { r: 4.5, class: `dot s-${c.arch}`, "data-arch": c.arch })));
  nodes.push(hover);
  const hit = svg("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" });
  nodes.push(hit);
  chart.replaceChildren(...nodes);

  const tip = $("tooltip");
  const show = (evt) => {
    const box = chart.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    let idx = 0;
    for (let i = 0; i < xs.length; i++) if (Math.abs(x(xs[i]) - px) < Math.abs(x(xs[idx]) - px)) idx = i;
    const cx = x(xs[idx]);
    hover.setAttribute("visibility", "visible");
    hoverLine.setAttribute("x1", cx);
    hoverLine.setAttribute("x2", cx);
    for (const dot of hover.querySelectorAll("circle")) {
      const c = curves.find((k) => k.arch === dot.dataset.arch);
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", y(c.points[idx].total));
    }
    const rows = curves
      .map((c) => ({ arch: c.arch, total: c.points[idx].total }))
      .sort((a, b) => b.total - a.total);
    tip.replaceChildren(
      el("strong", { text: `${xs[idx].toLocaleString("en-US")} users` }),
      ...rows.map((r) => el("div", { class: "tip-row" }, [el("i", { class: `swatch s-${r.arch}` }), el("span", { text: ARCH_LABELS[r.arch] }), el("b", { text: fmtUsd(r.total) })])),
    );
    tip.hidden = false;
    const left = (cx / W) * box.width;
    tip.style.left = `${Math.min(box.width - tip.offsetWidth - 4, Math.max(4, left + 12))}px`;
    tip.style.top = "8px";
  };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerleave", () => { hover.setAttribute("visibility", "hidden"); tip.hidden = true; });

  $("legend").replaceChildren(...ARCHITECTURES.map((a) => el("li", {}, [el("i", { class: `swatch s-${a}` }), ARCH_LABELS[a]])));

  const sv = curves.find((c) => c.arch === "serverless");
  const notes = ["containers", "vms"].map((a) => {
    const at = crossover(sv, curves.find((c) => c.arch === a));
    return at ? `${ARCH_LABELS[a].toLowerCase()} by about ${at.toLocaleString("en-US")} users` : null;
  }).filter(Boolean);
  $("crossover").textContent = notes.length
    ? `Serverless stops being the cheapest option against ${notes.join(" and ")}. The vertical line marks your current user count.`
    : "Serverless stays cheapest across this range with these inputs. The vertical line marks your current user count.";
}

function niceFloor(v) {
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const s of [5, 2, 1]) if (s * mag <= v) return s * mag;
  return mag;
}

function logTicks(lo, hi) {
  const ticks = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const s of [1, 2, 5]) {
      const v = s * 10 ** e;
      if (v >= lo - 1e-9 && v <= hi + 1e-9) ticks.push(v);
    }
  }
  return ticks;
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const s of [1, 2, 2.5, 5, 10]) if (s * mag >= v) return s * mag;
  return 10 * mag;
}

function compact(n) {
  return n >= 1e6 ? `${n / 1e6}M` : n >= 1e3 ? `${n / 1e3}k` : String(Math.round(n));
}

form.addEventListener("input", (e) => {
  if (!e.target.name) return;
  inputs = { ...inputs, [e.target.name]: readField(e.target) };
  update();
});

$("reset").addEventListener("click", () => {
  inputs = { ...DEFAULT_INPUTS };
  selected = null;
  fillForm();
  update();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

fillForm();
update();
