import type { LucideIcon } from 'lucide-react';
import { BarChart3, CalendarDays, Compass, Linkedin, Share2, Sparkles } from 'lucide-react';

import { AriesMark } from '../ui';
import styles from './hero-orbit.module.css';

const ORBIT_NODES: Array<{
  id: string;
  icon: LucideIcon;
  label: string;
  className: string;
  desktopOnly?: boolean;
  emphasize?: boolean;
}> = [
  { id: 'sparkles', icon: Sparkles, label: 'Strategy', className: styles.node1, emphasize: true },
  { id: 'calendar', icon: CalendarDays, label: 'Calendar', className: styles.node2 },
  { id: 'compass', icon: Compass, label: 'Channels', className: styles.node3 },
  { id: 'bar-chart', icon: BarChart3, label: 'Analytics', className: styles.node4, desktopOnly: true },
  { id: 'linkedin', icon: Linkedin, label: 'LinkedIn', className: styles.node5, desktopOnly: true, emphasize: true },
];

export function HeroOrbit(): JSX.Element {
  return (
    <div className={styles.wrapper} aria-hidden="true">
      <div className={styles.shell}>
        <div className={styles.glow} />
        <div className={styles.ringTertiary} />
        <div className={styles.ring} />
        <div className={styles.ringSecondary} />
        <div className={`${styles.spoke} ${styles.spoke1}`} />
        <div className={`${styles.spoke} ${styles.spoke2}`} />
        <div className={`${styles.spoke} ${styles.spoke3}`} />
        <div className={`${styles.spoke} ${styles.spoke4}`} />
        <div className={`${styles.spoke} ${styles.spoke5}`} />

        <div className={styles.orbit}>
          {ORBIT_NODES.map(({ id, icon: Icon, label, className, desktopOnly, emphasize }) => (
            <div
              key={id}
              className={[
                styles.node,
                className,
                desktopOnly ? styles.desktopNode : '',
                emphasize ? styles.nodePrimary : '',
              ]
                .filter(Boolean)
                .join(' ')}
              title={label}
            >
              <div className={styles.nodeCore}>
                <Icon className="h-4.5 w-4.5 text-white" />
              </div>
            </div>
          ))}
        </div>

        <div className={styles.centerHalo} />
        <div className={styles.center}>
          <AriesMark sizeClassName={styles.centerMark} />
          <p className={styles.centerLabel}>Aries AI</p>
        </div>

        <div className={`${styles.chip} ${styles.chipLeft} ${styles.desktopChip}`}>
          <div className={styles.chipIcon}>
            <BarChart3 className="h-4.5 w-4.5" />
          </div>
          <div className={styles.chipBody}>
            <span className={styles.chipLabel}>Analytics</span>
            <span className={styles.chipValue}>+24% growth this week</span>
          </div>
        </div>

        <div className={`${styles.chip} ${styles.chipRight} ${styles.desktopChip}`}>
          <div className={styles.chipIcon}>
            <Share2 className="h-4.5 w-4.5" />
          </div>
          <div className={styles.chipBody}>
            <span className={styles.chipLabel}>Auto-post</span>
            <span className={styles.chipValue}>X, LinkedIn, Insta, etc.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
