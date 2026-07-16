import { Dashboard } from "@/components/dashboard";
import { collectLiveSnapshot } from "@/lib/live-snapshot";

export const dynamic = "force-dynamic";

export default async function Home() {
  const snapshot = await collectLiveSnapshot();

  return <Dashboard snapshot={snapshot} />;
}
