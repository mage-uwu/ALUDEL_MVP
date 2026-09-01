import { useId } from "react";

// The ALUDEL mark: the alchemical air glyph (a triangle crossed by a bar)
// drawn as three squircles — one at the apex, two at the base — with the bar
// running through the gap between rows. Squircle corners are a superellipse
// (n = 4) rather than circular rounding, for continuous curvature.
const SQUIRCLE =
  "M17.00,0.00L16.97,5.02L16.87,7.08L16.71,8.65L16.48,9.94L16.18,11.05L15.82,12.02L15.39,12.87L14.88,13.63L14.30,14.30L13.63,14.88L12.87,15.39L12.02,15.82L11.05,16.18L9.94,16.48L8.65,16.71L7.08,16.87L5.02,16.97L0.00,17.00L-5.02,16.97L-7.08,16.87L-8.65,16.71L-9.94,16.48L-11.05,16.18L-12.02,15.82L-12.87,15.39L-13.63,14.88L-14.30,14.30L-14.88,13.63L-15.39,12.87L-15.82,12.02L-16.18,11.05L-16.48,9.94L-16.71,8.65L-16.87,7.08L-16.97,5.02L-17.00,0.00L-16.97,-5.02L-16.87,-7.08L-16.71,-8.65L-16.48,-9.94L-16.18,-11.05L-15.82,-12.02L-15.39,-12.87L-14.88,-13.63L-14.30,-14.30L-13.63,-14.88L-12.87,-15.39L-12.02,-15.82L-11.05,-16.18L-9.94,-16.48L-8.65,-16.71L-7.08,-16.87L-5.02,-16.97L-0.00,-17.00L5.02,-16.97L7.08,-16.87L8.65,-16.71L9.94,-16.48L11.05,-16.18L12.02,-15.82L12.87,-15.39L13.63,-14.88L14.30,-14.30L14.88,-13.63L15.39,-12.87L15.82,-12.02L16.18,-11.05L16.48,-9.94L16.71,-8.65L16.87,-7.08L16.97,-5.02Z";

const CENTERS: [number, number][] = [
  [50, 25],
  [31, 67],
  [69, 67],
];

export function Logo({
  size = 40,
  tone = "ink",
  className,
}: {
  size?: number;
  /** ink: single colour via currentColor. material: ceramic squares, titanium bar. */
  tone?: "ink" | "material";
  className?: string;
}) {
  const id = useId();
  const cer = `cer${id}`;
  const ti = `ti${id}`;
  const gloss = `gloss${id}`;
  const squares = CENTERS.map(([x, y]) => (
    <path key={`${x}-${y}`} d={SQUIRCLE} transform={`translate(${x} ${y})`} />
  ));

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {tone === "material" ? (
        <>
          <defs>
            <linearGradient id={cer} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.55" stopColor="#f6f7f9" />
              <stop offset="1" stopColor="#e9ecf0" />
            </linearGradient>
            <linearGradient id={ti} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4a4d53" />
              <stop offset="1" stopColor="#232529" />
            </linearGradient>
            <linearGradient id={gloss} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="6" y1="46" x2="94" y2="46" stroke={`url(#${ti})`} strokeWidth="3.5" strokeLinecap="round" />
          <g fill={`url(#${cer})`} stroke="#dfe3e8" strokeWidth="1">
            {squares}
          </g>
          <g fill={`url(#${gloss})`}>
            {CENTERS.map(([x, y]) => (
              <rect key={`g${x}-${y}`} x={x - 15} y={y - 16} width="30" height="15" rx="9" />
            ))}
          </g>
        </>
      ) : (
        <g fill="currentColor" stroke="currentColor">
          <g stroke="none">{squares}</g>
          <line x1="6" y1="46" x2="94" y2="46" strokeWidth="3.2" strokeLinecap="round" />
        </g>
      )}
    </svg>
  );
}
