import { useEffect, useRef } from 'react';

export default function Modal({ title, onClose, children, footer }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    // Remember where focus was so we can restore it when the dialog closes (a11y:
    // the keyboard/SR user lands back where they invoked the modal, not at page top).
    const prevFocus = document.activeElement;
    const dialog = dialogRef.current;

    const focusables = () =>
      Array.from(
        dialog?.querySelectorAll(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        ) || []
      ).filter((el) => el.offsetParent !== null);

    // Move focus into the dialog on open (first focusable, else the dialog itself).
    const first = focusables()[0];
    (first || dialog)?.focus();

    const onKey = (e) => {
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;
      // Trap Tab within the dialog so focus can't walk into the background page.
      const items = focusables();
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <h3>{title}</h3>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
