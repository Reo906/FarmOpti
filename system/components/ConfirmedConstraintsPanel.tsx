'use client';

import { useEffect, useState } from 'react';

interface ConstraintProposal {
  proposalId: string;
  sourceText: string;
  confirmedAt?: string;
}

export function ConfirmedConstraintsPanel() {
  const [constraints, setConstraints] = useState<ConstraintProposal[]>([]);

  const refresh = async () => {
    try {
      const response = await fetch('/api/voice/constraints');
      if (!response.ok) return;
      const json = (await response.json()) as { confirmed?: ConstraintProposal[] };
      setConstraints(json.confirmed ?? []);
    } catch {
      // non-critical — panel is informational
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  if (constraints.length === 0) return null;

  return (
    <section className="yc-card yc-constraints">
      <header>
        <div>
          <h3>Active farm rules</h3>
          <span>{constraints.length} confirmed</span>
        </div>
      </header>
      <ul className="yc-constraint-list">
        {constraints.map((c) => (
          <li key={c.proposalId} className="yc-constraint-item">
            <span className="yc-pill yc-pill-ok">Rule</span>
            <span className="yc-constraint-text">{c.sourceText}</span>
            {c.confirmedAt && (
              <time className="yc-constraint-time">
                {new Date(c.confirmedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
