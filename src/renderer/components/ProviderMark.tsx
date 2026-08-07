/**
 * Provider marks.
 *
 * Official brand paths are used where a licensed set provides them. Simple Icons carries
 * no OpenAI/ChatGPT mark, so rather than reconstruct a logo from memory — which would risk
 * shipping a wrong or unlicensed asset — ChatGPT gets a monogram in the same tile
 * treatment. The tiles stay visually consistent either way.
 */

import { siClaude, siOpencode } from 'simple-icons';
import type { Provider } from '@shared/account';

const BRAND_PATHS: Partial<Record<Provider, { path: string; hex: string; title: string }>> = {
  claude: { path: siClaude.path, hex: `#${siClaude.hex}`, title: siClaude.title },
  opencode: { path: siOpencode.path, hex: `#${siOpencode.hex}`, title: siOpencode.title },
};

const MONOGRAMS: Record<Provider, string> = {
  claude: 'C',
  chatgpt: 'GPT',
  opencode: 'OC',
};

export function ProviderMark({ provider }: { readonly provider: Provider }): React.ReactElement {
  const brand = BRAND_PATHS[provider];

  if (brand !== undefined) {
    return (
      <span className="mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" role="presentation" style={{ fill: brand.hex }}>
          <path d={brand.path} />
        </svg>
      </span>
    );
  }

  return (
    <span className="mark mark__monogram" aria-hidden="true" style={{ color: 'var(--text-secondary)' }}>
      {MONOGRAMS[provider]}
    </span>
  );
}
