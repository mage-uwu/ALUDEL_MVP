// One stroke weight, round caps, currentColor — so every control reads as one family.
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const Svg = ({ size, children, fill }: { size: number; children: React.ReactNode; fill?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false" {...(fill ? { fill: "currentColor" } : stroke)}>
    {children}
  </svg>
);

export const X = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" /></Svg>
);
export const Plus = ({ size = 20 }: { size?: number }) => (
  <Svg size={size}><path d="M10 4v12M4 10h12" /></Svg>
);
export const Check = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}><path d="M4 10.5l4 4 8-9" /></Svg>
);
export const ChevronLeft = ({ size = 20 }: { size?: number }) => (
  <Svg size={size}><path d="M12.5 4.5L7 10l5.5 5.5" /></Svg>
);
export const ChevronRight = ({ size = 18 }: { size?: number }) => (
  <Svg size={size}><path d="M7.5 4.5L13 10l-5.5 5.5" /></Svg>
);
export const More = ({ size = 20 }: { size?: number }) => (
  <Svg size={size} fill>
    <circle cx="4" cy="10" r="1.9" /><circle cx="10" cy="10" r="1.9" /><circle cx="16" cy="10" r="1.9" />
  </Svg>
);
export const Grip = ({ size = 18 }: { size?: number }) => (
  <Svg size={size} fill>
    <circle cx="7" cy="4.5" r="1.8" /><circle cx="13" cy="4.5" r="1.8" />
    <circle cx="7" cy="10" r="1.8" /><circle cx="13" cy="10" r="1.8" />
    <circle cx="7" cy="15.5" r="1.8" /><circle cx="13" cy="15.5" r="1.8" />
  </Svg>
);
export const Pencil = ({ size = 16 }: { size?: number }) => (
  <Svg size={size}><path d="M4 16v-3.2L13.3 3.5l3.2 3.2L7.2 16H4z" /><path d="M11.5 5.3l3.2 3.2" /></Svg>
);
