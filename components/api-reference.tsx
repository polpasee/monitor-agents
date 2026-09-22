"use client";

import { useSyncExternalStore } from "react";

import { apiEndpoints } from "@/lib/api-endpoints";

// The origin never changes while the page is open, so there is nothing to subscribe to.
const subscribe = () => () => {};

export function ApiReference() {
  // The server has no origin; an empty server snapshot keeps hydration identical.
  const origin = useSyncExternalStore(
    subscribe,
    () => window.location.origin,
    () => "",
  );

  return (
    <section className="api-reference" aria-labelledby="api-title">
      <header className="panel-header">
        <div>
          <p className="panel-header__eyebrow">Agent integration</p>
          <h2 id="api-title" className="panel-header__title">
            Kanban task API
          </h2>
        </div>
        <span className="panel-header__count">
          {apiEndpoints.length} endpoints
        </span>
      </header>

      <div className="api-reference__notes">
        <p>
          Base URL: <code>{origin || "this dashboard's origin"}</code> (runners
          read it from <code>MONITOR_API_URL</code>).
        </p>
        <p>
          Bearer endpoints need{" "}
          <code>Authorization: Bearer $MONITOR_AGENT_TOKEN</code>; keep the
          token out of browser code.
        </p>
        <p>Successful task responses return the full KanbanTask JSON.</p>
      </div>

      <div className="api-table-wrap">
        <table className="api-table">
          <thead>
            <tr>
              <th scope="col">Method</th>
              <th scope="col">Endpoint</th>
              <th scope="col">Auth</th>
              <th scope="col">Request</th>
              <th scope="col">Response</th>
              <th scope="col">Description</th>
            </tr>
          </thead>
          <tbody>
            {apiEndpoints.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`}>
                <td className="api-table__method">{endpoint.method}</td>
                <td>
                  <code>{endpoint.path}</code>
                </td>
                <td>{endpoint.auth === "bearer" ? "Bearer" : "None"}</td>
                <td>
                  {endpoint.request.length > 0 ? (
                    <ul>
                      {endpoint.request.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <ul>
                    {endpoint.responses.map((response) => (
                      <li key={`${response.status} ${response.description}`}>
                        <code>{response.status}</code> {response.description}
                      </li>
                    ))}
                  </ul>
                </td>
                <td>{endpoint.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
