import assert from "node:assert/strict";
import test from "node:test";

import { agentAuthError } from "./agent-auth.ts";

test("agentAuthError fails closed without a configured token", () => {
  const error = agentAuthError(new Request("http://localhost"), "");
  assert.equal(error?.status, 503);
});

test("agentAuthError rejects an invalid bearer token", () => {
  const request = new Request("http://localhost", {
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(agentAuthError(request, "correct")?.status, 401);
});

test("agentAuthError accepts the configured bearer token", () => {
  const request = new Request("http://localhost", {
    headers: { Authorization: "Bearer correct" },
  });
  assert.equal(agentAuthError(request, "correct"), null);
});
