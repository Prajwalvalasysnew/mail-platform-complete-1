/** Line icons ported 1:1 from the confirmed design prototype's icon spec. */
type Prim =
  | ['path', string]
  | ['circle', number, number, number]
  | ['line', number, number, number, number]
  | ['rect', number, number, number, number, number];

function Svg({ prims, size = 16 }: { prims: Prim[]; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: 'block' }}
      aria-hidden
    >
      {prims.map((p, i) =>
        p[0] === 'path' ? (
          <path key={i} d={p[1]} />
        ) : p[0] === 'circle' ? (
          <circle key={i} cx={p[1]} cy={p[2]} r={p[3]} />
        ) : p[0] === 'rect' ? (
          <rect key={i} x={p[1]} y={p[2]} width={p[3]} height={p[4]} rx={1.5} />
        ) : (
          <line key={i} x1={p[1]} y1={p[2]} x2={p[3]} y2={p[4]} />
        )
      )}
    </svg>
  );
}

const P: Record<string, Prim[]> = {
  fleet: [
    ['rect', 3, 3, 7, 7, 1.5],
    ['rect', 14, 3, 7, 7, 1.5],
    ['rect', 14, 14, 7, 7, 1.5],
    ['rect', 3, 14, 7, 7, 1.5],
  ],
  tenants: [
    ['path', 'M4 21V6.5L11 3v18'],
    ['path', 'M11 21V9.5L18 12v9'],
    ['line', 3, 21, 21, 21],
  ],
  deliverability: [
    ['path', 'M4 18a8 8 0 1116 0'],
    ['line', 12, 18, 15.5, 9.5],
  ],
  pools: [
    ['rect', 4, 5, 16, 5, 1.5],
    ['rect', 4, 14, 16, 5, 1.5],
    ['line', 7.5, 7.5, 7.51, 7.5],
    ['line', 7.5, 16.5, 7.51, 16.5],
  ],
  support: [
    ['path', 'M3 13l3-8h12l3 8v4a2 2 0 01-2 2H5a2 2 0 01-2-2z'],
    ['path', 'M3 13h5l1.5 2.5h5L16 13h5'],
  ],
  abuse: [
    ['path', 'M12 4.5l8.5 15H3.5z'],
    ['line', 12, 10, 12, 14],
    ['line', 12, 17, 12, 17.01],
  ],
  kyc: [
    ['path', 'M12 3l8 3v6c0 5-3.5 7.7-8 9-4.5-1.3-8-4-8-9V6z'],
    ['path', 'M9 12l2 2 4-4'],
  ],
  audit: [
    ['path', 'M6 3h9l3 3v15H6z'],
    ['line', 9, 9.5, 15, 9.5],
    ['line', 9, 13, 15, 13],
    ['line', 9, 16.5, 13, 16.5],
  ],
  billing: [
    ['rect', 3, 6, 18, 12, 2],
    ['line', 3, 10, 21, 10],
  ],
  payments: [
    ['path', 'M3 8a2 2 0 012-2h12v4'],
    ['path', 'M3 8v9a2 2 0 002 2h13a1 1 0 001-1v-7a1 1 0 00-1-1H5'],
    ['line', 16.5, 12.5, 16.51, 12.5],
  ],
  settings: [
    ['line', 4, 7, 20, 7],
    ['line', 4, 12, 20, 12],
    ['line', 4, 17, 20, 17],
    ['circle', 9, 7, 2.1],
    ['circle', 15, 12, 2.1],
    ['circle', 7, 17, 2.1],
  ],
  team: [
    ['path', 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2'],
    ['circle', 9, 7, 4],
    ['path', 'M22 21v-2a4 4 0 00-3-3.87'],
    ['path', 'M16 3.13a4 4 0 010 7.75'],
  ],
  dlq: [
    ['path', 'M3 3h18v18H3z'],
    ['path', 'M9 3v18'],
    ['path', 'm14 9 3 3-3 3'],
    ['path', 'M3 12h9'],
  ],
  search: [
    ['circle', 11, 11, 7],
    ['line', 16.5, 16.5, 21, 21],
  ],
  mail: [
    ['rect', 3, 5, 18, 14, 2],
    ['path', 'M3 7l9 6 9-6'],
  ],
  logout: [
    ['path', 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4'],
    ['path', 'M16 17l5-5-5-5'],
    ['line', 21, 12, 9, 12],
  ],
  x: [
    ['line', 6, 6, 18, 18],
    ['line', 18, 6, 6, 18],
  ],
  check: [['path', 'M4 12.5l5 5L20 6.5']],
  refresh: [
    ['path', 'M21 12a9 9 0 11-2.64-6.36'],
    ['path', 'M21 3v6h-6'],
  ],
  trash: [
    ['path', 'M4 7h16'],
    ['path', 'M9 7V4h6v3'],
    ['path', 'M6 7l1 14h10l1-14'],
  ],
  play: [['path', 'M7 5l12 7-12 7z']],
  plus: [
    ['line', 12, 5, 12, 19],
    ['line', 5, 12, 19, 12],
  ],
  download: [
    ['path', 'M12 3v12'],
    ['path', 'M7 11l5 5 5-5'],
    ['path', 'M4 21h16'],
  ],
  shield: [
    ['path', 'M12 3l8 3v6c0 5-3.5 7.7-8 9-4.5-1.3-8-4-8-9V6z'],
  ],
  spark: [['path', 'M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z']],
};

export function Icon({ name, size = 16 }: { name: keyof typeof P | string; size?: number }) {
  return <Svg prims={P[name] ?? []} size={size} />;
}
