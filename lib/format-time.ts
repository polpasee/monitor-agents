/**
 * "Oct 15, 14:39", or "Oct 15, 14:39:05" with seconds, in one time zone.
 *
 * Node and the browser ship different CLDR data, so the text Intl puts between
 * the date and the time differs ("Oct 15, 14:39" against "Oct 15 at 14:39") and
 * a server-rendered time then fails to hydrate. The parts themselves agree, so
 * the text is put together here instead.
 */
export function shortDateTimeFormatter({
  timeZone,
  seconds = false,
}: {
  timeZone: string;
  seconds?: boolean;
}): { format(date: Date): string } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
    timeZone,
  });

  return {
    format(date) {
      const part = new Map(
        formatter.formatToParts(date).map(({ type, value }) => [type, value]),
      );
      const time = [part.get("hour"), part.get("minute")];
      if (seconds) time.push(part.get("second"));
      return `${part.get("month")} ${part.get("day")}, ${time.join(":")}`;
    },
  };
}
