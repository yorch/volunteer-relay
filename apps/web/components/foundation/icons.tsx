const paths = {
  workspace: "M3 10 12 3l9 7v10h-6v-6H9v6H3z",
  inbox: "M4 4h16v12h-4l-2 3h-4l-2-3H4z M4 12h16",
  needs: "M5 21V4m0 1h12l-2 4 2 4H5",
  activities: "M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9Zm0 4v5l3 2",
  reports: "M4 20V10h4v10m4 0V4h4v16m4 0v-7h2v7",
  import: "M12 3v11m-4-4 4 4 4-4M4 16v4h16v-4",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2",
  members:
    "M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 4a4 4 0 0 1 3 4v2",
  notifications: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm5 3h4",
  history: "M4 5v5h5M5 10a8 8 0 1 1 1 7m6-9v4l3 2",
  delivery: "M3 5h12v12H3z M15 9h3l3 3v5h-6z M6 20h2m9 0h2",
  retention: "M4 6h16M9 6V4h6v2m-9 0 1 14h10l1-14M10 10v6m4-6v6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.2-4.2",
  refresh:
    "M20 11a8 8 0 0 0-14-4L4 9m0-5v5h5M4 13a8 8 0 0 0 14 4l2-2m0 5v-5h-5",
  check: "m5 12.5 4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6 6 18",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 6 6 6-6 6",
  arrowRight: "M5 12h14m-6-6 6 6-6 6",
  arrowLeft: "M19 12H5m6-6-6 6 6 6",
  download: "M12 3v12m-4-4 4 4 4-4M4 19h16",
  upload: "M12 16V4m-4 4 4-4 4 4M4 19h16",
  camera:
    "M4 8h3l2-3h6l2 3h3v11H4z M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5v4.5l3 1.5",
  calendar: "M4 6h16v14H4z M4 10h16M8 3v4m8-4v4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 21v-2a7 7 0 0 1 14 0v2",
  alert: "M12 3 2.5 20h19L12 3Zm0 6v5m0 3v.5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v6m0-9.5v.5",
  flag: "M5 21V4m0 1h12l-2 4 2 4H5",
  filter: "M4 5h16l-6 8v6l-4-2v-4z",
  menu: "M4 7h16M4 12h16M4 17h16",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 20,
}: {
  name: IconName;
  size?: 16 | 20 | 24;
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
