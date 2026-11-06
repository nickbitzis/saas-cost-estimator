import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INPUTS, DEFAULT_PRICES, HOURS_PER_MONTH, compareAll, crossover, decodeInputs,
  defaultUserPoints, encodeInputs, estimate, pickDbTier, scalingCurve, traffic,
} from "../src/cost.js";

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const line = (r, item) => r.lines.find((l) => l.item === item);

test("traffic derives requests, rates, and egress from usage", () => {
  const t = traffic(DEFAULT_INPUTS);
  assert.equal(t.requests, 20000 * 40 * 30);
  near(t.avgRps, 24e6 / (30 * 86400), 1e-9);
  near(t.peakRps, t.avgRps * 4, 1e-9);
  near(t.egressGb, 720, 1e-9);
});

test("serverless compute matches hand math", () => {
  const r = estimate("serverless");
  near(line(r, "Function requests").cost, 4.8);
  // 24M requests x 0.12 s x 0.5 GB = 1.44M GB-s
  near(line(r, "Function compute").cost, 1.44e6 * DEFAULT_PRICES.serverlessPerGbSecond);
  near(line(r, "API gateway").cost, 24);
});

test("containers respect the minimum instance count", () => {
  const r = estimate("containers", { ...DEFAULT_INPUTS, monthlyActiveUsers: 100 });
  const tasks = line(r, "Container tasks");
  assert.equal(tasks.count, DEFAULT_INPUTS.minInstances);
  const perTask = 1 * DEFAULT_PRICES.containerPerVcpuHour + 2 * DEFAULT_PRICES.containerPerGbHour;
  near(tasks.cost, Math.round(2 * perTask * HOURS_PER_MONTH * 100) / 100);
});

test("VM count scales with peak traffic", () => {
  const big = estimate("vms", { ...DEFAULT_INPUTS, monthlyActiveUsers: 1_000_000 });
  const t = traffic({ ...DEFAULT_INPUTS, monthlyActiveUsers: 1_000_000 });
  assert.equal(line(big, "VM instances").count, Math.ceil(t.peakRps / DEFAULT_INPUTS.rpsPerVm));
});

test("line items always sum to the total", () => {
  for (const mau of defaultUserPoints()) {
    for (const r of compareAll({ ...DEFAULT_INPUTS, monthlyActiveUsers: mau }).results) {
      near(r.lines.reduce((s, l) => s + l.cost, 0), r.total, 0.011);
    }
  }
});

test("the free egress tier is applied before charging", () => {
  const small = estimate("serverless", { ...DEFAULT_INPUTS, monthlyActiveUsers: 1000, cdnHitRatio: 0 });
  assert.equal(line(small, "Origin egress").cost, 0); // 36 GB is under the 100 GB free tier
  const noCdn = estimate("serverless", { ...DEFAULT_INPUTS, cdnHitRatio: 0 });
  near(line(noCdn, "Origin egress").cost, (720 - 100) * 0.09);
  assert.equal(line(noCdn, "CDN transfer"), undefined);
});

test("high availability doubles database cost", () => {
  const ha = estimate("containers");
  const single = estimate("containers", { ...DEFAULT_INPUTS, dbHighAvailability: false });
  near(line(ha, "Database instance").cost, line(single, "Database instance").cost * 2);
});

test("serverless needs a bigger database tier at the same traffic", () => {
  const inputs = { ...DEFAULT_INPUTS, monthlyActiveUsers: 500_000 };
  const t = traffic(inputs);
  const sv = pickDbTier("serverless", inputs, DEFAULT_PRICES, t);
  const ct = pickDbTier("containers", inputs, DEFAULT_PRICES, t);
  assert.ok(sv.connections > ct.connections);
  assert.ok(sv.tier.perHour >= ct.tier.perHour);
});

test("very high traffic warns when the database tiers run out", () => {
  const r = estimate("serverless", { ...DEFAULT_INPUTS, monthlyActiveUsers: 5_000_000, requestsPerUserPerDay: 400 });
  assert.equal(r.warnings.length, 1);
});

test("with default inputs serverless wins small and loses large", () => {
  assert.equal(compareAll({ ...DEFAULT_INPUTS, monthlyActiveUsers: 2000 }).cheapest, "serverless");
  assert.notEqual(compareAll({ ...DEFAULT_INPUTS, monthlyActiveUsers: 1_000_000 }).cheapest, "serverless");
  const [sv, ct] = scalingCurve();
  const at = crossover(sv, ct);
  assert.ok(at > 2000 && at < 1_000_000);
});

test("crossover returns null when one curve always wins", () => {
  const a = { points: [{ mau: 1, total: 1 }, { mau: 2, total: 2 }] };
  const b = { points: [{ mau: 1, total: 5 }, { mau: 2, total: 6 }] };
  assert.equal(crossover(a, b), null);
});

test("unknown architectures throw", () => {
  assert.throws(() => estimate("mainframe"), /Unknown architecture/);
});

test("inputs round-trip through the URL hash and ignore junk", () => {
  const custom = { ...DEFAULT_INPUTS, monthlyActiveUsers: 75000, dbHighAvailability: false };
  const hash = encodeInputs(custom);
  assert.equal(hash, "monthlyActiveUsers=75000&dbHighAvailability=false");
  assert.deepEqual(decodeInputs(`#${hash}`), custom);
  assert.deepEqual(decodeInputs("#evil=1&avgResponseKb=abc"), DEFAULT_INPUTS);
  assert.equal(encodeInputs(DEFAULT_INPUTS), "");
});
