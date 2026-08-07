/**
 * One account: its identity on the left, its three windows on the right.
 *
 * Every bar in this row is driven by this account's own `windows` record. There is no
 * merging or inheritance between accounts anywhere in the render path.
 */

import { PROVIDER_LABELS, type AccountUsage } from '@shared/account';
import { WINDOW_KINDS } from '@shared/window';
import { ProviderMark } from './ProviderMark';
import { WindowRow } from './WindowRow';

interface AccountRowProps {
  readonly usage: AccountUsage;
  /** Label of the account this one shares a quota with, when it does. */
  readonly poolPartnerLabel?: string;
  readonly now: Date;
}

export function AccountRow({ usage, poolPartnerLabel, now }: AccountRowProps): React.ReactElement {
  return (
    <div className="account">
      <div className="account__identity">
        <ProviderMark provider={usage.provider} />
        <div style={{ minWidth: 0 }}>
          <div className="account__name">{usage.label}</div>
          {usage.subtitle !== undefined && <div className="account__sub">{usage.subtitle}</div>}
          <div className="account__meta">
            <span className="chip">{PROVIDER_LABELS[usage.provider]}</span>
            {usage.plan !== undefined && <span className="chip">{usage.plan}</span>}
            {poolPartnerLabel !== undefined && (
              <span
                className="chip chip--pool"
                title={`This is the same subscription quota as ${poolPartnerLabel}, not an additional budget.`}
              >
                shares pool with {poolPartnerLabel}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="account__windows">
        {WINDOW_KINDS.map((kind) => (
          <WindowRow
            key={kind}
            kind={kind}
            measurement={usage.windows[kind]}
            accountLabel={usage.label}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}
