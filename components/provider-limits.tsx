import {
  formatResetDuration,
  getProviderQuota,
  percent,
  type Provider,
  type QuotaLimit,
} from "@/lib/telemetry";

type QuotaCard = "codex" | "claude" | "gemini" | "agy-gemini" | "agy-claude";

// AGY reports one quota per model group, so it renders one card per group.
const quotaCards: Record<
  QuotaCard,
  { provider: Provider; label: string; idPrefix?: string }
> = {
  codex: { provider: "codex", label: "Codex" },
  claude: { provider: "claude", label: "Claude" },
  gemini: { provider: "gemini", label: "Gemini" },
  "agy-gemini": { provider: "agy", label: "AGY Gemini", idPrefix: "agy-gemini" },
  "agy-claude": { provider: "agy", label: "AGY Claude", idPrefix: "agy-claude" },
};

const displayedProviders: readonly QuotaCard[] = ["codex", "claude", "gemini"];

interface ProviderLimitsProps {
  capturedAt: string;
  className?: string;
  providers?: readonly QuotaCard[];
  quotaLimits: QuotaLimit[];
}

const displayedPeriods = [
  { period: "hour", label: "5h" },
  { period: "week", label: "7d" },
] as const;

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
  className,
  providers = displayedProviders,
  quotaLimits,
}: ProviderLimitsProps) {
  return (
    <aside
      className={
        className
          ? `provider-limits-overlay ${className}`
          : "provider-limits-overlay"
      }
      aria-label="Provider limits"
    >
      <div className="provider-limits-overlay__providers">
        {providers.map((card) => {
          const { provider, label: providerLabel, idPrefix } = quotaCards[card];
          const providerQuotasByPeriod = {
            hour: getProviderQuota(quotaLimits, provider, "hour", idPrefix),
            week: getProviderQuota(quotaLimits, provider, "week", idPrefix),
          };

          return (
            <article
              className="provider-limits-overlay__provider quota-card"
              data-provider={provider}
              key={card}
              aria-label={`${providerLabel} limits`}
            >
              <h3 className="provider-limits-overlay__provider-name">
                {providerLabel}
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
                            ? `${providerLabel} ${label} usage: ${Math.round(usagePercent)}%`
                            : `${providerLabel} ${label} usage unavailable`
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
