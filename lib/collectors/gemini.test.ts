import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectGeminiTelemetry,
  findAntigravityHttpPort,
  parseGeminiModelStatus,
  parseGeminiQuotaSummary,
} from "./gemini.ts";

test("Gemini collector maps available quota to used quota by window", () => {
  const quotas = parseGeminiQuotaSummary({
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              displayName: "Weekly Limit",
              window: "604800s",
              remainingFraction: 1,
              resetTime: "2026-07-20T00:00:00Z",
            },
            {
              displayName: "Five Hour Limit",
              window: "18000s",
              remainingFraction: 0.4,
              resetTime: "2026-07-14T18:00:00Z",
            },
          ],
        },
      ],
    },
  });

  assert.deepEqual(
    quotas.map(({ id, period, windowHours, usedPercent, resetsAt }) => ({
      id,
      period,
      windowHours,
      usedPercent,
      resetsAt,
    })),
    [
      {
        id: "gemini:quota:primary",
        period: "hour",
        windowHours: 5,
        usedPercent: 60,
        resetsAt: "2026-07-14T18:00:00.000Z",
      },
      {
        id: "gemini:quota:secondary",
        period: "week",
        windowHours: 168,
        usedPercent: 0,
        resetsAt: "2026-07-20T00:00:00.000Z",
      },
    ],
  );
});

test("Gemini collector falls back to the most constrained Gemini model", () => {
  const quota = parseGeminiModelStatus({
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Claude Sonnet",
            quotaInfo: {
              remainingFraction: 0.1,
              resetTime: "2026-07-14T17:00:00Z",
            },
          },
          {
            label: "Gemini Flash",
            quotaInfo: {
              remainingFraction: 0.8,
              resetTime: "2026-07-14T18:00:00Z",
            },
          },
          {
            label: "Gemini Pro",
            quotaInfo: {
              remainingFraction: 0.6,
              resetTime: "2026-07-14T18:00:00Z",
            },
          },
        ],
      },
    },
  });

  assert.equal(quota?.period, "hour");
  assert.equal(quota?.usedPercent, 40);
  assert.equal(quota?.resetsAt, "2026-07-14T18:00:00.000Z");
});

test("Gemini collector discovers only a valid Antigravity HTTP port", () => {
  assert.equal(
    findAntigravityHttpPort(
      "Language server listening on random port at 63277 for HTTPS (gRPC)\n" +
        "Language server listening on random port at 63278 for HTTP\n",
    ),
    63278,
  );
  assert.equal(findAntigravityHttpPort("port at 80 for HTTP"), null);
});

test("Gemini collector reads the Antigravity cache without forcing refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitor-gemini-"));
  const previousDirectory = process.env.ANTIGRAVITY_CLI_DIR;
  const originalFetch = globalThis.fetch;
  const requestBodies = new Map<string, unknown>();

  try {
    process.env.ANTIGRAVITY_CLI_DIR = directory;
    await mkdir(join(directory, "log"));
    await writeFile(
      join(directory, "log", "cli-test.log"),
      "Language server listening on random port at 63278 for HTTP\n",
    );
    globalThis.fetch = (async (input, init) => {
      const method = String(input).split("/").at(-1)!;
      requestBodies.set(method, JSON.parse(String(init?.body)) as unknown);
      return Response.json(
        method === "RetrieveUserQuotaSummary"
          ? {
              response: {
                groups: [
                  {
                    displayName: "Gemini Models",
                    buckets: [
                      {
                        displayName: "Five Hour Limit",
                        remainingFraction: 0.5,
                      },
                      {
                        displayName: "Weekly Limit",
                        remainingFraction: 0.75,
                      },
                    ],
                  },
                ],
              },
            }
          : {},
      );
    }) as typeof fetch;

    const result = await collectGeminiTelemetry();
    assert.deepEqual(
      result.quotaLimits.map((quota) => quota.period),
      ["hour", "week"],
    );
    assert.deepEqual(requestBodies.get("RetrieveUserQuotaSummary"), {
      request: {},
      forceRefresh: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDirectory === undefined) {
      delete process.env.ANTIGRAVITY_CLI_DIR;
    } else {
      process.env.ANTIGRAVITY_CLI_DIR = previousDirectory;
    }
    await rm(directory, { force: true, recursive: true });
  }
});
