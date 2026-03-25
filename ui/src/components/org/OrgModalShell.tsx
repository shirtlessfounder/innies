'use client';

import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';
import analyticsStyles from '../../app/analytics/page.module.css';

type OrgModalShellProps = {
  eyebrow: string;
  title: string;
  children: ReactNode;
  onRequestClose?: () => void;
  dismissOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
};

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    return element.getAttribute('aria-hidden') !== 'true';
  });
}

export function OrgModalShell(input: OrgModalShellProps) {
  const {
    eyebrow,
    title,
    children,
    onRequestClose,
    dismissOnBackdrop = false,
    dismissOnEscape = false,
  } = input;
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    previousActiveElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    const dialog = dialogRef.current;
    if (dialog) {
      const focusableElements = getFocusableElements(dialog);
      if (focusableElements.length > 0) {
        focusableElements[0].focus();
      } else {
        dialogRef.current?.focus();
      }
    }

    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      const previousActiveElement = previousActiveElementRef.current;
      previousActiveElement?.focus();
    };
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (!dismissOnEscape || !onRequestClose) return;
        event.preventDefault();
        onRequestClose();
        return;
      }

      if (event.key === 'Tab') {
        const currentDialog = dialogRef.current;
        if (!currentDialog) {
          return;
        }

        const focusableElements = getFocusableElements(currentDialog);
        if (focusableElements.length === 0) {
          event.preventDefault();
          dialogRef.current?.focus();
          return;
        }

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        if (event.shiftKey) {
          if (activeElement === firstElement || activeElement === dialog) {
            event.preventDefault();
            lastElement.focus();
          }
          return;
        }

        if (activeElement === lastElement || !activeElement || !currentDialog.contains(activeElement)) {
          event.preventDefault();
          firstElement.focus();
        }
        return;
      }
    }

    globalThis.addEventListener('keydown', handleKeyDown);
    return () => globalThis.removeEventListener('keydown', handleKeyDown);
  }, [dismissOnEscape, onRequestClose]);

  function handleBackdropClick() {
    if (!dismissOnBackdrop || !onRequestClose) {
      return;
    }
    onRequestClose();
  }

  function handleModalCardClick(event: MouseEvent<HTMLDivElement>) {
    if (!dismissOnBackdrop) {
      return;
    }
    event.stopPropagation();
  }

  return (
    <div
      className={`${analyticsStyles.modalScope} ${analyticsStyles.modalBackdrop}`}
      onClick={dismissOnBackdrop ? handleBackdropClick : undefined}
    >
      <div
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="true"
        className={analyticsStyles.modalCard}
        onClick={dismissOnBackdrop ? handleModalCardClick : undefined}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={analyticsStyles.modalHeader}>
          <div className={analyticsStyles.modalTitleBlock}>
            <div className={analyticsStyles.managementSubsectionTitle}>{eyebrow}</div>
            <h2 className={analyticsStyles.modalHeading} id={titleId}>{title}</h2>
          </div>
        </div>

        <div className={analyticsStyles.modalBody} id={bodyId}>
          {children}
        </div>
      </div>
    </div>
  );
}
