/** Inline SVGs — no icon dependency, no network fetch, correct at 1x and 2x. */

type Props = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const PanelIcon = ({ size = 19, className }: Props) => (
  <svg {...base(size)} className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
  </svg>
);

export const NewChatIcon = ({ size = 18, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4 20h4l10.5-10.5a2.12 2.12 0 0 0-3-3L5 17v3z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
);

export const RocketIcon = ({ size = 18, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.9-.9.9-2.3 0-3.1a2.2 2.2 0 0 0-3 .1z" />
    <path d="M15.5 12.5 11 8c1.5-3.5 4.5-6 9-6 0 4.5-2.5 7.5-6 9z" />
    <path d="M11 8 7.5 8.5 5 11l3 1" />
    <path d="M15.5 12.5 15 16l-2.5 2.5-1-3" />
  </svg>
);

export const PlusIcon = ({ size = 17, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const GlobeIcon = ({ size = 17, className }: Props) => (
  <svg {...base(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
  </svg>
);

export const ArrowUpIcon = ({ size = 17, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 19V5" />
    <path d="M6 11l6-6 6 6" />
  </svg>
);

export const StopIcon = ({ size = 15, className }: Props) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

export const ChevronIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

export const TrashIcon = ({ size = 15, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M4 7h16M10 11v6M14 11v6" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M9 7V4h6v3" />
  </svg>
);

export const CloseIcon = ({ size = 16, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const DownIcon = ({ size = 14, className }: Props) => (
  <svg {...base(size)} className={className}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </svg>
);
