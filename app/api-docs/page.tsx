import type { Metadata } from "next";
import Link from "next/link";

import { ApiReference } from "@/components/api-reference";

export const metadata: Metadata = {
  title: "API · Monitor Agents",
};

export default function ApiDocsPage() {
  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-header__brand">
          <span className="dashboard-header__mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <p className="dashboard-header__eyebrow">Agent control plane</p>
            <h1 className="dashboard-header__title">Agent Observatory</h1>
          </div>
        </div>
        <nav className="dashboard-nav" aria-label="Dashboard views">
          <Link href="/">Dashboard</Link>
          <Link aria-current="page" href="/api-docs">
            API
          </Link>
        </nav>
      </header>

      <ApiReference />
    </main>
  );
}
