import {
  formatResetDuration,
  getProviderQuota,
  percent,
  type Provider,
  type QuotaLimit,
} from "@/lib/telemetry";

interface ProviderLimitsProps {
  capturedAt: string;
  quotaLimits: QuotaLimit[];
}

const displayedProviders = [
  "codex",
  "claude",
  "gemini",
] as const satisfies readonly Provider[];

const displayedPeriods = [
  { period: "hour", label: "5h" },
  { period: "week", label: "7d" },
] as const;

const providerLabels: Record<(typeof displayedProviders)[number], string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
};

function quotaUsagePercent(quota: QuotaLimit | undefined): number | null {
  if (!quota) {
    return null;
  }

  if (quota.usedPercent !== null) {
    return percent(quota.usedPercent, 100);
  }

  const measuredPercents = [
    quota.usedTokens !== null && quota.tokenLimit !== null
      ? percent(quota.usedTokens, quota.tokenLimit)
      : null,
    quota.usedCostUsd !== null && quota.costLimitUsd !== null
      ? percent(quota.usedCostUsd, quota.costLimitUsd)
      : null,
  ].filter((value): value is number => value !== null);

  return measuredPercents.length > 0 ? Math.max(...measuredPercents) : null;
}

export function ProviderLimits({
  capturedAt,
  quotaLimits,
}: ProviderLimitsProps) {
  return (
    <aside className="provider-limits-overlay" aria-label="Provider limits">
      <div className="provider-limits-overlay__providers">
        {displayedProviders.map((provider) => {
          const providerQuotasByPeriod = {
            hour: getProviderQuota(quotaLimits, provider, "hour"),
            week: getProviderQuota(quotaLimits, provider, "week"),
          };

          return (
            <article
              className="provider-limits-overlay__provider quota-card"
              data-provider={provider}
              key={provider}
              aria-label={`${providerLabels[provider]} limits`}
            >
              <h3 className="provider-limits-overlay__provider-name">
                {providerLabels[provider]}
              </h3>
              <div className="provider-limit-list">
                {displayedPeriods.map(({ period, label }) => {
                  const quota = providerQuotasByPeriod[period];
                  const usagePercent = quotaUsagePercent(quota);
                  const available = usagePercent !== null;
                  const usageLevel =
                    usagePercent === null
                      ? "unknown"
                      : usagePercent >= 85
                        ? "high"
                        : usagePercent >= 60
                          ? "medium"
                          : "low";

                  return (
                    <div
                      className="provider-limit-row"
                      data-available={available}
                      key={period}
                    >
                      <span className="provider-limit-row__label">{label}</span>
                      <progress
                        aria-label={
                          available
                            ? `${providerLabels[provider]} ${label} usage: ${Math.round(usagePercent)}%`
                            : `${providerLabels[provider]} ${label} usage unavailable`
                        }
                        className="quota-meter__progress"
                        data-level={usageLevel}
                        max={100}
                        value={usagePercent ?? 0}
                      />
                      <span className="provider-limit-row__percentage">
                        {available ? `${Math.round(usagePercent)}%` : "—"}
                      </span>
                      <span className="provider-limit-row__reset">
                        Reset:{" "}
                        {quota?.resetsAt ? (
                          <time dateTime={quota.resetsAt}>
                            {formatResetDuration(quota.resetsAt, capturedAt)}
                          </time>
                        ) : (
                          "—"
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}
