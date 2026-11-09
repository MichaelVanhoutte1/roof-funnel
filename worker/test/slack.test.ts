import { test } from "node:test";
import assert from "node:assert/strict";
import { creditAlertMessage } from "../src/slack.ts";

test("creditAlertMessage lists the figures the closer needs", () => {
  const m = creditAlertMessage({ id: 42, name: "Jane <Doe>", score: 733, offerStatus: "Approved", offerAmount: "$25,000 / $72,000", dti: 16, income: 60000, creditFreeze: "No" });
  const s = JSON.stringify(m);
  assert.equal(m.text, "Credit check: Jane <Doe> — 733");
  assert.match(s, /Credit check: Jane &lt;Doe&gt;/);
  assert.match(s, /\*Score:\* 733/);
  assert.match(s, /\*Financing:\* Approved \(\$25,000 \/ \$72,000\)/);
  assert.match(s, /\*Debt-to-income:\* 16%/);
  assert.match(s, /\*Est\. income:\* \$60,000/);
  assert.doesNotMatch(s, /Credit freeze/);
  assert.match(s, /lead #42/);
});

test("creditAlertMessage says so when no credit file matched, and flags a freeze", () => {
  const m = creditAlertMessage({ id: 7, name: null, score: null, offerStatus: null, offerAmount: null, dti: null, income: null, creditFreeze: "Yes" });
  const s = JSON.stringify(m);
  assert.equal(m.text, "Credit check: Unknown name");
  assert.match(s, /no credit file matched/);
  assert.match(s, /\*Credit freeze:\* Yes/);
});
