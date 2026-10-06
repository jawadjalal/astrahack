import type { ReactNode } from "react";

// Hand-drawn UI icons: slightly off-true paths, 2.2px ink, round caps. 24x24 box.
const Svg = ({ children, size = 22 }: { children: ReactNode; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

export const IconSelect = () => (
  <Svg>
    <path d="M5.2 3.6c3.8 1.2 8.1 3.3 13.2 6.3 1.1.7.9 1.4-.3 1.8l-5 1.7c-.6.2-.9.6-1.1 1.2l-1.5 5c-.4 1.2-1.1 1.4-1.7.2C6.9 14.7 5.3 9.2 3.9 5.5c-.3-.9.3-2.1 1.3-1.9z" fill="currentColor" fillOpacity=".12" />
  </Svg>
);
export const IconHand = () => (
  <Svg>
    <path d="M8 12.5V5.6a1.4 1.4 0 0 1 2.8 0v5.2m0-6a1.4 1.4 0 0 1 2.8.1v6m0-4.9a1.4 1.4 0 0 1 2.8 0v6.3m0-4.1a1.4 1.4 0 0 1 2.7.3v5.6c0 3.6-2.3 6-5.8 6-3 0-4.6-1.3-6.2-3.8L4.6 13.4a1.5 1.5 0 0 1 2.4-1.7L8 12.9" />
  </Svg>
);
export const IconDraw = () => (
  <Svg>
    <path d="M15.3 4.6l4 4M3.7 20.3l.9-4.3L16.1 4.2a1.9 1.9 0 0 1 2.7 0l1 1a1.9 1.9 0 0 1 0 2.7L8.1 19.6z" fill="currentColor" fillOpacity=".12" />
    <path d="M13.6 6.5l3.9 3.9" />
  </Svg>
);
export const IconNote = () => (
  <Svg>
    <path d="M4.2 4.4c5.2-.4 10.4-.4 15.6 0 .4 5 .4 9 0 11.2l-4.2 4.1c-3.8.3-7.6.1-11.4-.3-.3-5.1-.3-10.2 0-15z" fill="currentColor" fillOpacity=".12" />
    <path d="M19.7 15.6c-1.6.1-3.2.1-4.2-.1-.1 1.4-.1 2.8.1 4.2" />
  </Svg>
);
export const IconArrow = () => (
  <Svg>
    <path d="M4.3 18.7C6.8 10.4 12 6.3 19.2 5.6" />
    <path d="M13.9 3.8l5.5 1.7-2.4 5.3" />
  </Svg>
);
export const IconText = () => (
  <Svg>
    <path d="M5 6.6c.1-.8.3-1.4.6-1.7 4.5-.4 8.7-.4 12.9 0 .4.4.6 1 .6 1.8M12 5.3c-.2 4.6-.2 9.2 0 13.8M9 19.1c2 .2 4.1.2 6 0" />
  </Svg>
);
export const IconPlus = () => (
  <Svg>
    <path d="M12 4.6c.2 4.9.1 9.8 0 14.8M4.7 12.1c4.8.2 9.7.1 14.6-.1" strokeWidth={2.8} />
  </Svg>
);
export const IconPresent = () => (
  <Svg>
    <path d="M3.6 5.4c5.6-.5 11.2-.5 16.8 0 .4 3.4.4 6.6 0 9.6-5.5.4-11.1.4-16.6 0-.4-3.1-.4-6.3-.2-9.6z" />
    <path d="M12 15.1v4.2M8 19.6c2.7-.3 5.3-.3 8 0" />
    <path d="M10.3 8.4l4.1 2.2-4.1 2.2z" fill="currentColor" />
  </Svg>
);
export const IconFollow = () => (
  <Svg>
    <circle cx="12" cy="12" r="3.2" fill="currentColor" fillOpacity=".2" />
    <path d="M12 3.4v3.1M12 17.5v3.1M3.4 12h3.1M17.5 12h3.1" />
    <path d="M6.2 6.3c1.2-1.3 2.9-2.2 5.8-2.3M18 6.2c1.5 1.3 2.1 3 2 5.7M17.8 17.8c-1.3 1.4-3 2.1-5.8 2.2M6.1 17.9c-1.3-1.4-2-3-2.1-5.8" strokeDasharray="1 3.6" />
  </Svg>
);
export const IconFit = () => (
  <Svg>
    <path d="M4 9.2V4.6c0-.3.2-.5.5-.5H9M15 4.1h4.5c.3 0 .5.2.5.5v4.6M20 14.8v4.7c0 .3-.2.5-.5.5H15M9 20H4.5a.5.5 0 0 1-.5-.5v-4.6" />
    <rect x="8.4" y="8.6" width="7.2" height="6.8" rx="1.4" fill="currentColor" fillOpacity=".12" />
  </Svg>
);
export const IconTrash = () => (
  <Svg>
    <path d="M4.4 6.6c5-.4 10.2-.4 15.2 0M9.4 6.4c0-1.5.4-2.4 1.1-2.6 1-.2 2-.2 3 0 .7.3 1.1 1.1 1.1 2.6" />
    <path d="M6.1 6.9c.3 4.4.6 8.8 1.1 12.7.1.5.5.8 1 .8 2.6.2 5.2.2 7.7 0 .5 0 .9-.3 1-.8.5-3.9.8-8.3 1.1-12.7" fill="currentColor" fillOpacity=".1" />
    <path d="M10 10.4l.2 6.2M14 10.4l-.2 6.2" />
  </Svg>
);
export const IconActivity = () => (
  <Svg>
    <path d="M4.2 6.2h.1M4.2 12h.1M4.2 17.8h.1" strokeWidth={3.2} />
    <path d="M8.6 6.3c3.7-.3 7.3-.3 11 0M8.6 12.1c3.7-.3 7.3-.3 11 0M8.6 17.7c3.7-.3 7.3-.3 11 0" />
  </Svg>
);
export const IconUpload = () => (
  <Svg>
    <path d="M12 15.6V4.4M7.6 8.6L12 4.2l4.4 4.4M4.6 14.8c-.1 1.7-.1 3.2.1 4.6 4.1.3 10.5.3 14.6 0 .2-1.4.2-3 0-4.6" />
  </Svg>
);
export const IconLink = () => (
  <Svg>
    <path d="M10.2 13.8a4 4 0 0 0 5.6.2l3-3a4 4 0 0 0-5.7-5.6l-1.2 1.2" />
    <path d="M13.8 10.2a4 4 0 0 0-5.6-.2l-3 3a4 4 0 0 0 5.7 5.6l1.2-1.2" />
  </Svg>
);
export const IconClose = () => (
  <Svg size={18}>
    <path d="M6 6.3l12 11.4M18 6.1L6.2 17.8" />
  </Svg>
);
export const IconChevron = ({ dir = "left" }: { dir?: "left" | "right" }) => (
  <Svg size={18}>
    <path d={dir === "left" ? "M14.8 5.6L8.4 12l6.4 6.4" : "M9.2 5.6l6.4 6.4-6.4 6.4"} />
  </Svg>
);
export const IconCopy = () => (
  <Svg size={18}>
    <rect x="8.6" y="8.4" width="11" height="11.4" rx="2" />
    <path d="M15.4 8.2V6c0-.8-.6-1.4-1.4-1.4H6C5.2 4.6 4.6 5.2 4.6 6v8.4c0 .8.6 1.4 1.4 1.4h2.6" />
  </Svg>
);
