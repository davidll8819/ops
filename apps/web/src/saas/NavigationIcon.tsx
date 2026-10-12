/** Shared outline icons keep every navigation label on the same baseline. */
export function NavigationIcon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    secretary: 'M4 4h16v11H9l-5 5V4Zm4 4h8M8 11h5',
    office: 'm3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8',
    tasks: 'M5 3h14v18H5V3Zm3 5h8M8 12h8M8 16h5',
    archive: 'M3 7h18v14H3V7Zm-1-4h22v4H2V3Zm7 8h6',
    members:
      'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21v-2a7 7 0 0 1 14 0v2M16 4a4 4 0 0 1 0 7M18 15a5 5 0 0 1 4 5v1',
    skills: 'M4 4h6v16H4V4Zm10 0h6v16h-6V4ZM7 8h0M17 8h0',
    agents: 'M5 7h14v13H5V7Zm7 0V3M9 12h0M15 12h0M9 16h6M2 11v5M22 11v5',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
    usage: 'M4 3v18h17M8 17v-5M13 17V8M18 17V5',
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  )
}
