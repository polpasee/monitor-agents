import assert from "node:assert/strict";
import test from "node:test";

import { shortDateTimeFormatter } from "./format-time.ts";

test("shortDateTimeFormatter joins the date and time with a comma, in the given zone", () => {
  const utc = shortDateTimeFormatter({ timeZone: "UTC" });
  assert.equal(utc.format(new Date("2026-10-15T14:39:00Z")), "Oct 15, 14:39");
  assert.equal(utc.format(new Date("2026-01-05T04:07:00Z")), "Jan 5, 04:07");

  const bangkok = shortDateTimeFormatter({ timeZone: "Asia/Bangkok" });
  assert.equal(bangkok.format(new Date("2026-09-12T20:15:00Z")), "Sep 13, 03:15");
});

test("shortDateTimeFormatter writes midnight as 00, never 24, and can add seconds", () => {
  const utc = shortDateTimeFormatter({ timeZone: "UTC" });
  assert.equal(utc.format(new Date("2026-10-16T00:00:00Z")), "Oct 16, 00:00");

  const withSeconds = shortDateTimeFormatter({ timeZone: "UTC", seconds: true });
  assert.equal(
    withSeconds.format(new Date("2026-10-15T14:39:05Z")),
    "Oct 15, 14:39:05",
  );
});

test("shortDateTimeFormatter ignores the literal Intl puts between the date and the time", () => {
  // Newer browser CLDR data writes "Oct 15 at 14:39"; Node's writes "Oct 15, 14:39".
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  Intl.DateTimeFormat.prototype.formatToParts = function (date) {
    return original.call(this, date).map((part) =>
      part.type === "literal" && part.value === ", "
        ? { ...part, value: " at " }
        : part,
    );
  };
  try {
    const utc = shortDateTimeFormatter({ timeZone: "UTC" });
    assert.equal(utc.format(new Date("2026-10-15T14:39:00Z")), "Oct 15, 14:39");
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original;
  }
});
