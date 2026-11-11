import type { MessageUsage } from "@pi-desktop/shared";

export function formatUsageCost(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

export function knownUsageCost(usage?: MessageUsage): number | undefined {
  const total = usage?.cost?.total;
  if (usage?.costStatus === "unknown" || !Number.isFinite(total) || total! < 0) return undefined;
  return total;
}
