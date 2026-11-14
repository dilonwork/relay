import type { ReactNode } from 'react';

// One segment of the title bar path (the breadcrumb). Every segment
// but the last navigates up; the last segment is the current page —
// bold, not a link, aria-current="page" — and it IS the page title:
// there is no separate title element, the path is the title
// (ticket 337e6a55, UI&UX prototype "Sidebar & title deduplication").
export interface TitleBarSegment {
  label: string;
  onNavigate?: () => void;
}

interface TitleBarProps {
  segments: TitleBarSegment[];
  // Full title for the last segment's tooltip: long ticket titles
  // truncate with an ellipsis, the full text stays in title.
  title?: string;
  // Extra actions shown next to Refresh, e.g. the ticket status badge
  // on the detail page.
  badge?: ReactNode;
  onRefresh: () => void;
}

// One slim title bar per page (ticket 337e6a55): it carries the path,
// the page title (the last path segment) and the actions, and replaces
// the old content header (H1 + tagline + Refresh) and the per-panel
// H2s. The sidebar keeps the single "Relay" brand.
export default function TitleBar({ segments, title, badge, onRefresh }: TitleBarProps) {
  return (
    <div className="titlebar">
      <nav className="crumbs" aria-label="Breadcrumb">
        {segments.map((s, i) => {
          const last = i === segments.length - 1;
          if (last || !s.onNavigate) {
            return (
              <span key={i} className="here" aria-current="page" title={title ?? s.label}>
                {s.label}
              </span>
            );
          }
          return (
            <span key={i}>
              <button type="button" className="link" onClick={s.onNavigate}>
                {s.label}
              </button>
              <span className="sep" aria-hidden="true">
                /
              </span>
            </span>
          );
        })}
      </nav>
      <div className="actions">
        {badge}
        <button type="button" className="link" onClick={onRefresh}>
          Refresh
        </button>
      </div>
    </div>
  );
}
