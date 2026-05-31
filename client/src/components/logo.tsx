export function PhDataMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="phData matcher"
    >
      <rect width="40" height="40" rx="8" fill="currentColor" opacity="0.12" />
      <path
        d="M10 9h8a6 6 0 0 1 0 12h-4v10h-4V9zm4 4v5h4a2.5 2.5 0 0 0 0-5h-4z"
        fill="currentColor"
      />
      <rect x="25" y="17" width="5" height="14" rx="1" fill="currentColor" />
      <circle cx="27.5" cy="13" r="2" fill="currentColor" />
    </svg>
  );
}
