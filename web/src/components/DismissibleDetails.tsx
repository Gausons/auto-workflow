import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react';

export function DismissibleDetails({ children, ...props }: ComponentPropsWithoutRef<'details'>) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener('click', closeOnOutsideClick);
    return () => document.removeEventListener('click', closeOnOutsideClick);
  }, []);

  return <details ref={detailsRef} {...props}>{children}</details>;
}
