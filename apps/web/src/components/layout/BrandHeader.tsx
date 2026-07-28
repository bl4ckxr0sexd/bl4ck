import { sanitizeImageSrc } from '../../lib/safeImageSrc';
import { useTranslation } from 'react-i18next';

interface BrandHeaderProps {
  /** Partner logo. Sanitized before render; falls back to the BL4CK SVG when null/unsafe. */
  logoUrl: string | null;
  /** Partner name. Falls back to "BL4CK" when null/empty. */
  name: string | null;
  /** Whether to render the text label (hidden in collapsed sidebar mode). */
  showLabel: boolean;
}

const BRAND_MARK = (
  <svg width="14" height="14" viewBox="0 0 64 64" fill="none" className="text-primary">
    <text
      x="32" y="34" textAnchor="middle" dominantBaseline="central"
      fontFamily="Arial, Helvetica, sans-serif" fontSize="44" fontWeight="700" fill="currentColor"
    >
      B
    </text>
  </svg>
);

export default function BrandHeader({ logoUrl, name, showLabel }: BrandHeaderProps) {
  const { t } = useTranslation('common');
  const safeLogoUrl = sanitizeImageSrc(logoUrl);
  const label = name?.trim() || 'BL4CK';

  return (
    <div className="flex items-center gap-2">
      <div className="flex u-h-px-22 w-[22px] shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-primary/15">
        {safeLogoUrl ? (
          <img src={safeLogoUrl} alt={t('layout.logoAlt', { brand: label })} className="h-full w-full object-contain" />
        ) : (
          BRAND_MARK
        )}
      </div>
      {showLabel && (
        <span className="text-lg font-bold tracking-tight text-foreground truncate">{label}</span>
      )}
    </div>
  );
}
