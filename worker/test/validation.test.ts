import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFullSubmission,
  classifyPartialSubmission,
  isFakeLeadIdentity,
  isObviousFakeText,
  usCanadaE164,
} from "../src/validation.ts";

const good = {
  timeline: "Right Away!",
  business_owner: "I own a business",
  capital: "Yes - I have $20,000+ available right now",
  city: "Tampa, FL",
  name: "Marcus Thompson",
  phone: "(813) 462-7731",
  email: "marcus.thompson@gmail.com",
};

test("a real-looking lead processes", () => {
  assert.deepEqual(classifyFullSubmission(good), { outcome: "process" });
});

test("the DQ capital answer still processes (routing decides, not the gate)", () => {
  assert.deepEqual(classifyFullSubmission({ ...good, capital: "No - I do not qualify to book a call" }), { outcome: "process" });
});

test("unknown option values are rejected with a message", () => {
  const g = classifyFullSubmission({ ...good, timeline: "Never" });
  assert.equal(g.outcome, "reject");
});

test("short phone rejects, foreign phone ghosts", () => {
  assert.equal(classifyFullSubmission({ ...good, phone: "813462" }).outcome, "reject");
  assert.equal(classifyFullSubmission({ ...good, phone: "+44 20 7946 0958" }).outcome, "ghost");
  assert.equal(classifyFullSubmission({ ...good, phone: "+57 305 555 0100" }).outcome, "ghost");
});

test("toll-free is not a lead", () => {
  assert.equal(usCanadaE164("800 555 2222"), null);
  assert.equal(usCanadaE164("813 462 7731"), "+18134627731");
  assert.equal(usCanadaE164("1 813 462 7731"), "+18134627731");
});

test("obvious test identities ghost", () => {
  assert.equal(classifyFullSubmission({ ...good, name: "Test Do Not Book" }).outcome, "ghost");
  assert.equal(classifyFullSubmission({ ...good, email: "test-do-not-book@example.com" }).outcome, "ghost");
  assert.equal(classifyFullSubmission({ ...good, name: "asdf" }).outcome, "ghost");
  assert.equal(classifyFullSubmission({ ...good, phone: "1234567890" }).outcome, "ghost");
  assert.equal(classifyFullSubmission({ ...good, city: "asdfgh" }).outcome, "ghost");
});

test("owner test address and configured internal domains ghost", () => {
  assert.equal(isFakeLeadIdentity({ name: "Sam Owner", email: "sam@onyaroof.com", digits10: "8134627731" }, { internalEmailDomains: "onyaroof.com" }), true);
  assert.equal(isFakeLeadIdentity({ name: "Sam Owner", email: "sam@onyaroof.com", digits10: "8134627731" }, {}), false);
});

test("real names with consonant clusters pass", () => {
  for (const n of ["Kirsch-Schmidt", "Nguyen Tran", "Tj Squib", "Sasaki Ito"]) {
    assert.equal(isObviousFakeText(n), false, n);
    assert.equal(isFakeLeadIdentity({ name: n, email: "k@kirschroofing.com", digits10: "8134627731" }), false, n);
  }
});

test("partial: phone only is enough, junk name ghosts", () => {
  assert.deepEqual(classifyPartialSubmission({ phone: "8134627731" }), { outcome: "process" });
  assert.equal(classifyPartialSubmission({ phone: "8134627731", name: "hello" }).outcome, "ghost");
  assert.equal(classifyPartialSubmission({ phone: "8134627731", timeline: "Nope" }).outcome, "reject");
});
