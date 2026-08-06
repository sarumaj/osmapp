/**
 * Invariants of the waste flood fill, on a synthetic block grid.
 *
 * These mirror _segmentWaste's rule rather than calling it, because the real
 * function needs a polygonized street network. The rule is the part that has
 * to be right; the geometry around it is Turf's problem.
 *
 * The one-ring version of this carve — where a block had to touch the outer
 * boundary itself — would fail "flood reaches deeper than one ring".
 */
const test = require("node:test");
const assert = require("node:assert");

const W = 10;
const H = 7;
const blocks = [];
for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) blocks.push([x, y]);

const key = (b) => `${b[0]},${b[1]}`;
const onOuter = (b) => b[0] === 0 || b[1] === 0 || b[0] === W - 1 || b[1] === H - 1;
const adjacent = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

/** Three vertical territories; dwellings only in a small core. */
const owner = (b) => (b[0] < 4 ? 0 : b[0] < 7 ? 1 : 2);
const dwellings = new Set(
  blocks.filter((b) => b[0] >= 3 && b[0] <= 6 && b[1] >= 3 && b[1] <= 4).map(key),
);

const disposable = (b) => !dwellings.has(key(b));
const bordersOther = (b) => blocks.some((o) => adjacent(b, o) && owner(o) !== owner(b));
const fillable = (b) => disposable(b) && !bordersOther(b);

/** The rule under test: seed on the outer boundary, then flood inward. */
function floodFill() {
  const carved = new Set(blocks.filter((b) => onOuter(b) && fillable(b)).map(key));
  const queue = [...carved].map((k) => k.split(",").map(Number));
  while (queue.length) {
    const cur = queue.pop();
    for (const nb of blocks) {
      if (carved.has(key(nb)) || !adjacent(cur, nb)) continue;
      if (owner(nb) !== owner(cur) || !fillable(nb)) continue;
      carved.add(key(nb));
      queue.push(nb);
    }
  }
  return carved;
}

/** Which pairs of territories share a boundary, given the surviving blocks. */
function adjacencyPairs(live) {
  const pairs = new Set();
  for (const a of live)
    for (const b of live)
      if (adjacent(a, b) && owner(a) !== owner(b))
        pairs.add([owner(a), owner(b)].sort().join("-"));
  return pairs;
}

const carved = floodFill();
const survivors = blocks.filter((b) => !carved.has(key(b)));

test("no block holding a dwelling is ever carved", () => {
  for (const k of carved) assert.equal(dwellings.has(k), false, k);
});

test("territory adjacency is unchanged", () => {
  const before = adjacencyPairs(blocks);
  const after = adjacencyPairs(survivors);
  assert.deepEqual([...after].sort(), [...before].sort());
});

test("every territory survives and stays connected", () => {
  for (const t of [0, 1, 2]) {
    const own = survivors.filter((b) => owner(b) === t);
    assert.ok(own.length > 0, `territory ${t} survives`);

    const seen = new Set();
    const stack = [own[0]];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(key(cur))) continue;
      seen.add(key(cur));
      for (const o of own) if (!seen.has(key(o)) && adjacent(cur, o)) stack.push(o);
    }
    assert.equal(seen.size, own.length, `territory ${t} is one piece`);
  }
});

test("every carved block reaches the outside", () => {
  // Connected to the boundary through other carved blocks — that is what makes
  // the removal a notch rather than a hole.
  for (const k of carved) {
    const seen = new Set();
    const stack = [k.split(",").map(Number)];
    let escaped = false;
    while (stack.length && !escaped) {
      const cur = stack.pop();
      if (seen.has(key(cur))) continue;
      seen.add(key(cur));
      if (onOuter(cur)) escaped = true;
      for (const o of blocks)
        if (carved.has(key(o)) && !seen.has(key(o)) && adjacent(cur, o)) stack.push(o);
    }
    assert.ok(escaped, `${k} is walled in — that would be a hole`);
  }
});

test("blocks bordering another territory are never carved", () => {
  for (const k of carved) {
    const b = k.split(",").map(Number);
    assert.equal(bordersOther(b), false, `${k} sits on a seam`);
  }
});

test("the flood reaches deeper than one ring", () => {
  // The regression guard: the previous rule required each block to touch the
  // outer ring itself, so a wide empty margin only ever lost its outermost
  // ring. On this fixture that was 22 blocks against 40.
  const oneRing = blocks.filter((b) => onOuter(b) && fillable(b)).length;
  assert.ok(
    carved.size > oneRing,
    `flood ${carved.size} should exceed one-ring ${oneRing}`,
  );

  const interior = [...carved].filter((k) => !onOuter(k.split(",").map(Number)));
  assert.ok(interior.length > 0, "at least one carved block is not on the boundary");
});
