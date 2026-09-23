import type { Metadata } from "next";
import Link from "next/link";

import { ApiReference } from "@/components/api-reference";

export const metadata: Metadata = {
  title: "Docs · Monitor Agents",
};

export default function DocsPage() {
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
          <Link aria-current="page" href="/docs">
            Docs
          </Link>
        </nav>
      </header>

      <div className="docs-page">
        <ApiReference />
      </div>
    </main>
  );
}
