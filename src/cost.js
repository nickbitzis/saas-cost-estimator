// Cost model for a small SaaS. Pure functions, no DOM, so it runs in the
// browser and under `node --test`.
//
// Prices are illustrative on-demand list prices in USD for a single US region,
// rounded. They are assumptions to edit, not a quote from any provider.

export const HOURS_PER_MONTH = 730;
export const SECONDS_PER_MONTH = 30 * 24 * 3600;

export const DEFAULT_PRICES = {
  serverlessPerMillionRequests: 0.2,
  serverlessPerGbSecond: 0.0000166667,
  apiGatewayPerMillionRequests: 1.0,
  containerPerVcpuHour: 0.04048,
  containerPerGbHour: 0.004445,
  vmPerHour: 0.0832,
  loadBalancerPerMonth: 18.0,
  loadBalancerPerGb: 0.008,
  dbStoragePerGbMonth: 0.115,
  dbTiers: [
    { name: "db.small (2 vCPU, 4 GB)", maxConnections: 150, perHour: 0.072 },
    { name: "db.medium (2 vCPU, 8 GB)", maxConnections: 400, perHour: 0.144 },
    { name: "db.large (4 vCPU, 16 GB)", maxConnections: 900, perHour: 0.288 },
    { name: "db.xlarge (8 vCPU, 32 GB)", maxConnections: 2000, perHour: 0.576 },
    { name: "db.2xlarge (16 vCPU, 64 GB)", maxConnections: 5000, perHour: 1.152 },
  ],
  objectStoragePerGbMonth: 0.023,
  egressFreeGb: 100,
  egressPerGb: 0.09,
  cdnPerGb: 0.085,
  logsPerGbIngested: 0.5,
};

export const DEFAULT_INPUTS = {
  monthlyActiveUsers: 20000,
  requestsPerUserPerDay: 40,
  avgResponseKb: 30,
  peakToAverage: 4,
  avgDurationMs: 120,
  functionMemoryMb: 512,
  rpsPerVcpu: 60,
  rpsPerVm: 120,
  minInstances: 2,
  containerVcpu: 1,
  containerMemoryGb: 2,
  dbBaseGb: 20,
  dbGbPerThousandUsers: 1.5,
  dbHighAvailability: true,
  storageGbPerUser: 0.05,
  cdnHitRatio: 0.6,
  logKbPerRequest: 1,
};

export const ARCHITECTURES = ["serverless", "containers", "vms"];
export const ARCH_LABELS = { serverless: "Serverless functions", containers: "Containers", vms: "Virtual machines" };

const round2 = (x) => Math.round(x * 100) / 100;

export function traffic(inputs) {
  const mau = Math.max(0, Number(inputs.monthlyActiveUsers) || 0);
  const requests = mau * Math.max(0, inputs.requestsPerUserPerDay) * 30;
  const avgRps = requests / SECONDS_PER_MONTH;
  const peakRps = avgRps * Math.max(1, inputs.peakToAverage);
  const egressGb = (requests * Math.max(0, inputs.avgResponseKb)) / 1e6;
  return { mau, requests, avgRps, peakRps, egressGb };
}

function computeLines(arch, inputs, prices, t) {
  if (arch === "serverless") {
    const millions = t.requests / 1e6;
    const gbSeconds = t.requests * (inputs.avgDurationMs / 1000) * (inputs.functionMemoryMb / 1024);
    return [
      { item: "Function requests", cost: millions * prices.serverlessPerMillionRequests, detail: `${fmtNum(millions)}M requests` },
      { item: "Function compute", cost: gbSeconds * prices.serverlessPerGbSecond, detail: `${fmtNum(gbSeconds)} GB-seconds` },
      { item: "API gateway", cost: millions * prices.apiGatewayPerMillionRequests, detail: `${fmtNum(millions)}M requests` },
    ];
  }
  const lb = [
    { item: "Load balancer", cost: prices.loadBalancerPerMonth + t.egressGb * prices.loadBalancerPerGb, detail: `${fmtNum(t.egressGb)} GB processed` },
  ];
  if (arch === "containers") {
    const vcpuNeeded = t.peakRps / Math.max(1, inputs.rpsPerVcpu);
    const tasks = Math.max(inputs.minInstances, Math.ceil(vcpuNeeded / Math.max(0.25, inputs.containerVcpu)));
    const perTask = inputs.containerVcpu * prices.containerPerVcpuHour + inputs.containerMemoryGb * prices.containerPerGbHour;
    return [{ item: "Container tasks", cost: tasks * perTask * HOURS_PER_MONTH, detail: `${tasks} tasks, ${inputs.containerVcpu} vCPU / ${inputs.containerMemoryGb} GB each`, count: tasks }, ...lb];
  }
  if (arch === "vms") {
    const vms = Math.max(inputs.minInstances, Math.ceil(t.peakRps / Math.max(1, inputs.rpsPerVm)));
    return [{ item: "VM instances", cost: vms * prices.vmPerHour * HOURS_PER_MONTH, detail: `${vms} instances`, count: vms }, ...lb];
  }
  throw new Error(`Unknown architecture: ${arch}`);
}

// Pick the smallest database tier that fits the expected connection count.
// Serverless functions open more connections per request, so they need more
// headroom unless a connection pooler sits in front.
export function pickDbTier(arch, inputs, prices, t) {
  const perRps = arch === "serverless" ? 1.5 : 0.5;
  const connections = Math.ceil(t.peakRps * perRps) + 20;
  const tier = prices.dbTiers.find((x) => x.maxConnections >= connections) ?? prices.dbTiers[prices.dbTiers.length - 1];
  return { tier, connections, overCapacity: tier.maxConnections < connections };
}

export function estimate(arch, inputs = DEFAULT_INPUTS, prices = DEFAULT_PRICES) {
  const t = traffic(inputs);
  const lines = computeLines(arch, inputs, prices, t);

  const db = pickDbTier(arch, inputs, prices, t);
  const haFactor = inputs.dbHighAvailability ? 2 : 1;
  const dbGb = inputs.dbBaseGb + (t.mau / 1000) * inputs.dbGbPerThousandUsers;
  lines.push({
    item: "Database instance",
    cost: db.tier.perHour * HOURS_PER_MONTH * haFactor,
    detail: `${db.tier.name}${inputs.dbHighAvailability ? ", multi-AZ" : ""}, ~${db.connections} connections`,
  });
  lines.push({ item: "Database storage", cost: dbGb * prices.dbStoragePerGbMonth * haFactor, detail: `${fmtNum(dbGb)} GB` });

  const objectGb = t.mau * inputs.storageGbPerUser;
  lines.push({ item: "Object storage", cost: objectGb * prices.objectStoragePerGbMonth, detail: `${fmtNum(objectGb)} GB` });

  const hit = Math.min(1, Math.max(0, inputs.cdnHitRatio));
  const cdnGb = t.egressGb * hit;
  const originGb = t.egressGb - cdnGb;
  if (cdnGb > 0) lines.push({ item: "CDN transfer", cost: cdnGb * prices.cdnPerGb, detail: `${fmtNum(cdnGb)} GB served from cache` });
  const billableEgress = Math.max(0, originGb - prices.egressFreeGb);
  lines.push({ item: "Origin egress", cost: billableEgress * prices.egressPerGb, detail: `${fmtNum(originGb)} GB, first ${prices.egressFreeGb} GB free` });

  const logGb = (t.requests * inputs.logKbPerRequest) / 1e6;
  lines.push({ item: "Logs and monitoring", cost: logGb * prices.logsPerGbIngested, detail: `${fmtNum(logGb)} GB ingested` });

  for (const l of lines) l.cost = round2(l.cost);
  const total = round2(lines.reduce((s, l) => s + l.cost, 0));
  return {
    arch,
    lines,
    total,
    perUser: t.mau ? total / t.mau : 0,
    traffic: t,
    warnings: db.overCapacity ? ["Peak connections exceed the largest database tier. Add a connection pooler or read replicas."] : [],
  };
}

export function compareAll(inputs = DEFAULT_INPUTS, prices = DEFAULT_PRICES) {
  const results = ARCHITECTURES.map((a) => estimate(a, inputs, prices));
  const cheapest = results.reduce((best, r) => (r.total < best.total ? r : best));
  return { results, cheapest: cheapest.arch };
}

// Total monthly cost across a range of user counts, for the scaling chart.
export function scalingCurve(inputs = DEFAULT_INPUTS, prices = DEFAULT_PRICES, points = defaultUserPoints()) {
  return ARCHITECTURES.map((arch) => ({
    arch,
    points: points.map((mau) => ({ mau, total: estimate(arch, { ...inputs, monthlyActiveUsers: mau }, prices).total })),
  }));
}

export function defaultUserPoints() {
  const pts = [];
  for (let e = 3; e <= 6; e++) for (const m of [1, 2, 5]) if (m * 10 ** e <= 1e6) pts.push(m * 10 ** e);
  return pts;
}

// First user count (on the given grid) where architecture b becomes cheaper than a.
export function crossover(curveA, curveB) {
  for (let i = 1; i < curveA.points.length; i++) {
    const prevA = curveA.points[i - 1].total;
    const prevB = curveB.points[i - 1].total;
    const a = curveA.points[i].total;
    const b = curveB.points[i].total;
    if (prevA <= prevB && a > b) return curveA.points[i].mau;
  }
  return null;
}

export function fmtNum(x) {
  if (x >= 100) return Math.round(x).toLocaleString("en-US");
  if (x >= 1) return x.toFixed(1);
  return x.toFixed(2);
}

export function fmtUsd(x) {
  return x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: x < 10 ? 2 : 0 });
}

// Inputs are encoded in the URL hash so an estimate can be shared as a link.
export function encodeInputs(inputs) {
  const diff = {};
  for (const [k, v] of Object.entries(inputs)) if (DEFAULT_INPUTS[k] !== v) diff[k] = v;
  return new URLSearchParams(Object.entries(diff).map(([k, v]) => [k, String(v)])).toString();
}

export function decodeInputs(hash) {
  const params = new URLSearchParams(String(hash).replace(/^#/, ""));
  const out = { ...DEFAULT_INPUTS };
  for (const [k, v] of params) {
    if (!(k in DEFAULT_INPUTS)) continue;
    if (typeof DEFAULT_INPUTS[k] === "boolean") out[k] = v === "true";
    else if (Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}
