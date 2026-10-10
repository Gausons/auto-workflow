import type { ReactNode } from 'react';
import styles from './PageHeading.module.css';

export function PageHeading({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <header className={`page-heading ${styles.heading}`}><div className={styles.title}><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className={styles.actions}>{children}</div>}</header>;
}
