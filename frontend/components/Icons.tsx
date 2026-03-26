import React from 'react';

export const XIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <path d="M4 4l11.733 16H20L8.267 4z" />
    <path d="M4 20l6.768-6.768m2.464-2.464L20 4" />
  </svg>
);

export const RedditIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    {...props}
  >
    <path d="M12 2C6.48 2 2 6.48 2 12c0 5.52 4.48 10 10 10s10-4.48 10-10c0-5.52-4.48-10-10-10zm5.1 12.3c-.1 0-.3 0-.4-.1-1.3-.8-3-1.3-4.7-1.3-1.7 0-3.4.5-4.7 1.3-.1.1-.3.1-.4.1-.2 0-.4-.1-.5-.3-.1-.2-.1-.5.1-.6 1.5-1 3.4-1.5 5.5-1.5s4 .5 5.5 1.5c.2.1.3.4.2.6-.1.2-.3.3-.6.3zM15.5 11c-.8 0-1.5-.7-1.5-1.5S14.7 8 15.5 8s1.5.7 1.5 1.5-.7 1.5-1.5 1.5zm-7 0c-.8 0-1.5-.7-1.5-1.5S7.7 8 8.5 8s1.5.7 1.5 1.5-.7 1.5-1.5 1.5z" />
  </svg>
);
