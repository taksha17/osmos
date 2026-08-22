import logoSrc from '@resources/logo-ui.png';

type Variant = 'sidebar' | 'hero' | 'mark';

type Props = {
  /** sidebar = nav header; hero = home splash; mark = overlay icon crop */
  variant?: Variant;
};

export function BrandLogo({ variant = 'sidebar' }: Props) {
  const alt =
    variant === 'mark' ? 'OSMOS' : 'OSMOS — See, Understand, Assist';

  return (
    <div className={`brand-logo brand-logo--${variant}`}>
      <img
        src={logoSrc}
        alt={alt}
        className={`brand-logo__img${variant === 'mark' ? ' brand-logo__img--mark' : ''}`}
        draggable={false}
      />
    </div>
  );
}
