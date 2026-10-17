import type { CSSProperties } from "react";

import {
  formatResetDuration,
  getProviderQuota,
  percent,
  type Provider,
  type QuotaLimit,
} from "@/lib/telemetry";

type QuotaCard = "codex" | "claude" | "agy-gemini" | "agy-claude";

// AGY reports one quota per model group, so it renders one card per group.
const quotaCards: Record<
  QuotaCard,
  { provider: Provider; label: string; idPrefix?: string }
> = {
  codex: { provider: "codex", label: "Codex" },
  claude: { provider: "claude", label: "Claude" },
  "agy-gemini": { provider: "agy", label: "AGY Gemini", idPrefix: "agy-gemini" },
  "agy-claude": { provider: "agy", label: "AGY Claude", idPrefix: "agy-claude" },
};

interface ProviderLimitsProps {
  capturedAt: string;
  /** In a header row: one column per card, 180px each, rather than the overlay's layout. */
  inline?: boolean;
  providers: readonly QuotaCard[];
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
  inline = false,
  providers,
  quotaLimits,
}: ProviderLimitsProps) {
  // Set inline rather than from the stylesheet, so a browser holding an older
  // sheet still lays the cards out in one row; narrow screens override it there.
  const inlineLayout = inline
    ? {
        overlay: { width: `min(${180 * providers.length}px, 100%)` } as CSSProperties,
        cards: { gridTemplateColumns: `repeat(${providers.length}, minmax(0, 1fr))` },
      }
    : {
        // Wide enough for one row; the stylesheet's auto-fit grid still wraps when narrow.
        overlay: { width: `min(${180 * providers.length}px, calc(100% - 28px))` },
        cards: undefined,
      };
  return (
    <aside
      className={
        inline
          ? "provider-limits-overlay provider-limits-overlay--inline"
          : "provider-limits-overlay"
      }
      aria-label="Provider limits"
      style={inlineLayout?.overlay}
    >
      <div className="provider-limits-overlay__providers" style={inlineLayout?.cards}>
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
